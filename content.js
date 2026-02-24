(function() {
    const STORAGE_KEY = 'og-viewer-state';
    const escapeHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const getMetaData = () => {
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || 
                        document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
        const title = document.title;
        const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || "";
        const url = window.location.href;
        const hostname = window.location.hostname;
        const h1 = document.querySelector('h1')?.innerText || "";

        return { ogImage, title, description, url, hostname, h1 };
    };

    const getStructuredData = () => {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        let data = [];
        scripts.forEach(script => {
            try {
                const json = JSON.parse(script.innerText);
                if (Array.isArray(json)) data = data.concat(json);
                else data.push(json);
            } catch (e) {}
        });
        return data;
    };

    const getHreflangData = () => {
        const links = document.querySelectorAll('link[rel="alternate"][hreflang]');
        return Array.from(links).map(link => ({
            lang: link.getAttribute('hreflang'),
            href: link.getAttribute('href') || ''
        }));
    };

    const analyzeHreflang = (entries, currentUrl) => {
        const errors = [];
        const warnings = [];
        const langRegex = /^[a-z]{2}(-[a-zA-Z]{2})?$|^x-default$/i;

        if (entries.length === 0) return { entries, errors, warnings, status: 'none' };

        const langs = entries.map(e => e.lang);
        const currentUrlNorm = currentUrl.replace(/\/$/, '');
        const hasSelfRef = entries.some(e => {
            const h = (e.href || '').replace(/\/$/, '');
            return h === currentUrlNorm || currentUrl.startsWith(h) || h.startsWith(currentUrlNorm);
        });

        if (!hasSelfRef) errors.push('La page actuelle devrait être référencée dans ses propres balises hreflang (auto-référence manquante).');

        const duplicates = langs.filter((l, i) => langs.indexOf(l) !== i);
        if (duplicates.length > 0) errors.push(`Valeurs hreflang dupliquées : ${[...new Set(duplicates)].join(', ')}.`);

        entries.forEach(e => {
            if (!langRegex.test(e.lang)) warnings.push(`Code de langue invalide ou inhabituel : "${e.lang}".`);
            if (e.href && !e.href.startsWith('http')) warnings.push(`URL relative pour hreflang="${e.lang}" : les URL absolues sont recommandées.`);
        });

        const hasXDefault = entries.some(e => e.lang && e.lang.toLowerCase() === 'x-default');
        if (!hasXDefault && entries.length > 1) warnings.push('x-default est recommandé pour indiquer la version par défaut.');

        const htmlLang = document.documentElement.getAttribute('lang');
        if (htmlLang && entries.length > 0) {
            const matched = entries.some(e => e.lang && e.lang.toLowerCase() === htmlLang.toLowerCase());
            if (!matched && !hasXDefault) warnings.push(`L'attribut html lang="${htmlLang}" ne correspond à aucun hreflang.`);
        }

        let status = errors.length > 0 ? 'error' : (warnings.length > 0 ? 'warning' : 'ok');
        return { entries, errors, warnings, status };
    };

    let isPinned = false;
    let isHidden = false;
    let xOffset = 0;
    let yOffset = 0;

    const saveState = () => {
        try { chrome.storage.local.set({ [STORAGE_KEY]: { isPinned, isHidden, xOffset, yOffset } }); } catch (e) {}
    };

    const loadState = (cb) => {
        try {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
                const s = result[STORAGE_KEY];
                if (s) { isPinned = !!s.isPinned; isHidden = !!s.isHidden; xOffset = s.xOffset || 0; yOffset = s.yOffset || 0; }
                if (typeof cb === 'function') cb();
            });
        } catch (e) { if (typeof cb === 'function') cb(); }
    };

    const initOrUpdate = () => {
        // Ne pas rafraîchir si on est en train de drag ou si c'est épinglé (optionnel, à voir selon l'usage)
        const oldContainer = document.querySelector('.og-viewer-container');
        
        const data = getMetaData();
        const structuredData = getStructuredData();
        const hreflangEntries = getHreflangData();
        const hreflangAnalysis = analyzeHreflang(hreflangEntries, data.url);

        // Calcul du score SEO
        let score = 100;
        const suggestions = [];
        if (data.title.length < 30 || data.title.length > 60) { score -= 15; suggestions.push(`Le titre (${data.title.length} car.) devrait faire entre 30 et 60 caractères.`); }
        if (!data.description) { score -= 20; suggestions.push(`La meta description est absente.`); }
        else if (data.description.length < 120) { score -= 20; suggestions.push(`La meta description (${data.description.length} car.) est trop courte. Elle devrait faire entre 120 et 155 caractères.`); }
        if (!data.ogImage) { score -= 20; suggestions.push(`Image OpenGraph manquante.`); }
        if (structuredData.length === 0) { score -= 15; suggestions.push(`Aucune donnée structurée détectée.`); }
        if (!data.h1) { score -= 15; suggestions.push(`Balise H1 manquante.`); }
        if (hreflangAnalysis.status === 'error') { score -= 10; suggestions.push(...hreflangAnalysis.errors); }
        else if (hreflangAnalysis.status === 'warning') { score -= 5; suggestions.push(...hreflangAnalysis.warnings); }
        score = Math.max(0, score);

        // Si le container existe déjà, on met juste à jour le contenu (conserve état réduit/épinglé)
        if (oldContainer) {
            const panel = oldContainer.querySelector('.og-viewer-panel');
            const minimizedEl = oldContainer.querySelector('.og-viewer-minimized');
            if (panel) {
                const contentWrapper = panel.querySelector('.og-viewer-content');
                if (contentWrapper) contentWrapper.innerHTML = '';
                else return;

                const scoreColor = score > 80 ? '#00c853' : (score > 50 ? '#ffab00' : '#d50000');
                const scorePill = oldContainer.querySelector('.og-viewer-score-pill');
                if (scorePill) { scorePill.innerText = score; scorePill.style.background = scoreColor; }
                const minimizedScore = oldContainer.querySelector('.og-viewer-minimized-score');
                if (minimizedScore) { minimizedScore.textContent = score; minimizedScore.style.color = scoreColor; }

                renderContent(contentWrapper, data, structuredData, suggestions, hreflangAnalysis);

                panel.style.display = isHidden ? 'none' : 'block';
                if (minimizedEl) minimizedEl.style.display = isHidden ? 'flex' : 'none';
            }
            return;
        }

        // 2. Création initiale de l'interface
        const container = document.createElement('div');
        container.className = 'og-viewer-container';
        container.style.top = '10px';
        container.style.right = '10px';
        if (xOffset || yOffset) container.style.transform = `translate(${xOffset}px, ${yOffset}px)`;

        const scoreColor = score > 80 ? '#00c853' : (score > 50 ? '#ffab00' : '#d50000');
        const panel = document.createElement('div');
        panel.className = 'og-viewer-panel';
        panel.id = 'og-main-panel';

        const header = document.createElement('div');
        header.className = 'og-viewer-header';
        header.innerHTML = `
            <div class="og-viewer-header-left">
                <div class="og-viewer-score-pill" style="background: ${scoreColor}" title="Score SEO: ${score}/100">${score}</div>
                <div class="og-viewer-header-title">MetaScope</div>
            </div>
            <div class="og-viewer-header-actions">
                <button class="og-viewer-header-btn og-toggle-btn" title="${isHidden ? 'Afficher' : 'Réduire'}">−</button>
                <button class="og-viewer-header-btn og-pin-btn ${isPinned ? 'active' : ''}" title="${isPinned ? 'Désépingler' : 'Épingler'}">📌</button>
                <button class="og-viewer-close-btn og-viewer-header-btn" title="Fermer">×</button>
            </div>
        `;
        panel.appendChild(header);

        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'og-viewer-content';
        panel.appendChild(contentWrapper);
        renderContent(contentWrapper, data, structuredData, suggestions, hreflangAnalysis);

        // Icône réduite (visible quand isHidden)
        const minimizedEl = document.createElement('div');
        minimizedEl.className = 'og-viewer-minimized';
        minimizedEl.title = 'Cliquer pour afficher';
        minimizedEl.innerHTML = `<span class="og-viewer-minimized-score" style="color:${scoreColor}">${score}</span>`;
        minimizedEl.style.display = isHidden ? 'flex' : 'none';
        minimizedEl.onclick = (e) => { e.stopPropagation(); isHidden = false; saveState(); applyMinimizedState(); };

        const toggleBtn = header.querySelector('.og-toggle-btn');
        const pinBtn = header.querySelector('.og-pin-btn');

        const applyMinimizedState = () => {
            panel.style.display = isHidden ? 'none' : 'block';
            minimizedEl.style.display = isHidden ? 'flex' : 'none';
            toggleBtn.title = isHidden ? 'Afficher' : 'Réduire';
        };

        toggleBtn.onclick = (e) => { e.stopPropagation(); isHidden = !isHidden; saveState(); applyMinimizedState(); };
        pinBtn.onclick = (e) => { e.stopPropagation(); isPinned = !isPinned; saveState(); pinBtn.classList.toggle('active', isPinned); pinBtn.title = isPinned ? 'Désépingler' : 'Épingler'; };
        header.querySelector('.og-viewer-close-btn').onclick = (e) => { e.stopPropagation(); container.remove(); };

        applyMinimizedState();

        let isDragging = false, currentX, currentY, initialX, initialY;
        const startDrag = (e) => {
            if (e.target.closest('button')) return;
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            isDragging = true;
        };
        header.onmousedown = startDrag;
        minimizedEl.onmousedown = (e) => { if (e.button === 0) startDrag(e); };
        document.onmousemove = (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                xOffset = currentX; yOffset = currentY;
                container.style.transform = `translate(${currentX}px, ${currentY}px)`;
                saveState();
            }
        };
        document.onmouseup = () => isDragging = false;

        container.appendChild(panel);
        container.appendChild(minimizedEl);
        document.body.appendChild(container);
    };

    const renderContent = (wrapper, data, structuredData, suggestions, hreflangAnalysis) => {
        // Section Image OpenGraph
        if (data.ogImage) {
            const imgSection = document.createElement('div');
            imgSection.className = 'og-viewer-section';
            imgSection.innerHTML = `
                <div class="og-viewer-title">Aperçu OpenGraph</div>
                <div class="og-viewer-image-wrapper">
                    <img src="${data.ogImage}" id="og-preview-img" style="cursor: zoom-in;" title="Cliquez pour agrandir">
                </div>`;
            wrapper.appendChild(imgSection);

            imgSection.querySelector('#og-preview-img').onclick = () => {
                const lightbox = document.createElement('div');
                lightbox.className = 'og-viewer-lightbox';
                lightbox.innerHTML = `<img src="${data.ogImage}">`;
                document.body.appendChild(lightbox);
                setTimeout(() => lightbox.classList.add('active'), 10);
                lightbox.onclick = () => {
                    lightbox.classList.remove('active');
                    setTimeout(() => lightbox.remove(), 300);
                };
            };
        }

        // Section SERP Simulator
        const serpSection = document.createElement('div');
        serpSection.className = 'og-viewer-section';
        const hasBreadcrumbs = structuredData.find(i => i['@type'] === 'BreadcrumbList');
        const faqData = structuredData.find(i => i['@type'] === 'FAQPage');
        let richSnippetHtml = '';
        if (faqData && faqData.mainEntity) {
            richSnippetHtml += '<div class="serp-rich-snippet">';
            faqData.mainEntity.slice(0, 2).forEach(q => {
                richSnippetHtml += `<div class="serp-faq-item">${q.name || q.question}</div>`;
            });
            richSnippetHtml += '</div>';
        }
        serpSection.innerHTML = `
            <div class="og-viewer-title">Simulateur Google (SERP)</div>
            <div class="serp-preview">
                <div class="serp-breadcrumb">${data.hostname} ${hasBreadcrumbs ? ' › ...' : ''}</div>
                <div class="serp-title">${data.title.substring(0, 60)}${data.title.length > 60 ? '...' : ''}</div>
                <div class="serp-desc">${data.description.substring(0, 155)}${data.description.length > 155 ? '...' : ''}</div>
                ${richSnippetHtml}
            </div>
        `;
        wrapper.appendChild(serpSection);

        // Section Données Structurées
        const sdSection = document.createElement('div');
        sdSection.className = 'og-viewer-section';
        sdSection.innerHTML = `<div class="og-viewer-title">Données Structurées (${structuredData.length})</div>`;
        const highPriority = ['Product', 'Recipe', 'Review', 'FAQPage', 'BreadcrumbList', 'Event', 'Course', 'LocalBusiness'];
        if (structuredData.length > 0) {
            structuredData.forEach((item) => {
                const type = item['@type'] || 'Type inconnu';
                const isHigh = highPriority.includes(type);
                const div = document.createElement('div');
                div.className = 'sd-item';
                div.innerHTML = `
                    <strong>${type}</strong>
                    <span class="sd-priority-badge ${isHigh ? 'sd-priority-high' : 'sd-priority-med'}">
                        ${isHigh ? 'Visible Google' : 'Info Page'}
                    </span>
                    <div class="sd-json">${JSON.stringify(item, null, 2)}</div>
                `;
                div.onclick = (e) => { e.stopPropagation(); div.classList.toggle('active'); };
                sdSection.appendChild(div);
            });
        }
        wrapper.appendChild(sdSection);

        // Section Hreflang
        const hreflangSection = document.createElement('div');
        hreflangSection.className = 'og-viewer-section';
        const hreflang = hreflangAnalysis || { entries: [], errors: [], warnings: [], status: 'none' };
        let hreflangTitle = 'Hreflang';
        if (hreflang.entries.length > 0) {
            const statusIcon = hreflang.status === 'error' ? '🔴' : (hreflang.status === 'warning' ? '🟡' : '🟢');
            hreflangTitle = `Hreflang (${hreflang.entries.length} langue${hreflang.entries.length > 1 ? 's' : ''}) ${statusIcon}`;
        }
        hreflangSection.innerHTML = `<div class="og-viewer-title">${hreflangTitle}</div>`;

        if (hreflang.entries.length === 0) {
            const emptyP = document.createElement('p');
            emptyP.className = 'og-hreflang-empty';
            emptyP.textContent = 'Aucune balise hreflang détectée.';
            hreflangSection.appendChild(emptyP);
        } else {
            const list = document.createElement('div');
            list.className = 'og-hreflang-list';
            hreflang.entries.forEach(e => {
                const item = document.createElement('div');
                item.className = 'og-hreflang-item';
                item.innerHTML = `<span class="og-hreflang-lang">${escapeHtml(e.lang)}</span><a href="${escapeHtml(e.href)}" target="_blank" rel="noopener" class="og-hreflang-url">${escapeHtml(e.href || '—')}</a>`;
                list.appendChild(item);
            });
            hreflangSection.appendChild(list);
            hreflang.errors.forEach(msg => {
                const div = document.createElement('div');
                div.className = 'seo-suggestion';
                div.innerHTML = `<span>⚠️</span><span>${escapeHtml(msg)}</span>`;
                hreflangSection.appendChild(div);
            });
            hreflang.warnings.forEach(msg => {
                const div = document.createElement('div');
                div.className = 'og-hreflang-warning';
                div.innerHTML = `<span>💡</span><span>${escapeHtml(msg)}</span>`;
                hreflangSection.appendChild(div);
            });
        }
        wrapper.appendChild(hreflangSection);

        // Section Suggestions
        if (suggestions.length > 0) {
            const suggSection = document.createElement('div');
            suggSection.className = 'og-viewer-section';
            suggSection.innerHTML = `<div class="og-viewer-title">Suggestions</div>`;
            suggestions.forEach(s => {
                suggSection.innerHTML += `<div class="seo-suggestion"><span>💡</span><span>${s}</span></div>`;
            });
            wrapper.appendChild(suggSection);
        }
    };

    // Initialisation (charge l'état sauvegardé puis affiche)
    loadState(() => initOrUpdate());

    // Détection des changements de page (pour les SPA comme Next.js/React)
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            // Attendre un peu que le DOM se mette à jour
            setTimeout(initOrUpdate, 500);
        }
    }).observe(document, {subtree: true, childList: true});

})();
