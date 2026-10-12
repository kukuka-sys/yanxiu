// ==UserScript==
// @name              教师研修网自动看课脚本
// @name:zh-CN        教师研修网自动看课脚本
// @namespace         https://github.com/AGkite/yanxiu
// @version           2.9.4
// @description       Auto study on yanxiu.com: skip PPT, speed play, quiz, next video lesson.
// @description:zh-CN yanxiu.com 跳过PPT课件、自动学习视频、倍速播放、自动答题、自动切下一节
// @author            AGkite
// @match             https://*.yanxiu.com/*
// @icon              https://www.google.com/s2/favicons?sz=64&domain=yanxiu.com
// @grant             none
// @run-at            document-idle
// @license           MIT
// @charset           UTF-8
// @homepageURL       https://github.com/AGkite/yanxiu
// @supportURL        https://github.com/AGkite/yanxiu/issues
// @downloadURL      none
// ==/UserScript==

(function () {
    'use strict';

    if (location.hostname === 'preview.yanxiu.com') {
        return;
    }

    const LOG = '[研修网刷课 v2.9.4]';
    // 倍速设置：建议 1~2，过高可能导致学时不记录或被检测
    const PLAYBACK_RATE = 1;
    // 学习锁：视频页存活期间保持，仅课程结束或超时后释放（不依赖心跳，避免后台 tab 被节流误判）
    const STORAGE_PLAYER_LOCK = 'yx-player-lock';
    const STORAGE_PLAYER_HEARTBEAT = 'yx-player-heartbeat';
    const STORAGE_PLAYER_TAB = 'yx-player-tab-id';
    const STORAGE_PLAYER_URL = 'yx-player-url';
    const STORAGE_LIST_REFRESH_EVENT = 'yx-list-refresh-event';
    const STORAGE_COURSE_CURSOR_PREFIX = 'yx-course-cursor-';
    const SESSION_LIST_REFRESH_SEEN = 'yx-list-refresh-seen';
    // 列表页点击课程后，若播放器一直未打开，尽快释放等待锁
    const PENDING_PLAYER_TIMEOUT = 20 * 1000;
    const LIST_CLICK_RETRY = 30 * 1000;
    // 视频页长时间没有心跳则释放旧锁（后台 tab 约每 15~60 秒刷新一次）
    const HEARTBEAT_ACTIVE = 90 * 1000;
    // true = 跳过纯 PPT 幻灯片（有页码无视频），「课件」标签的视频仍会学习
    const SKIP_PPT = true;
    const SECTION_HEADERS = ['课程导学', '主题解析', '延伸阅读'];
    const PLAYER_LOAD_WAIT = 8000;
    const READING_LOAD_WAIT = 15000;
    const playerLoadAt = Date.now();
    const TAB_ID = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let statusText = '脚本已加载';
    let lastListClickAt = 0;
    let lastNextClickAt = 0;
    let lastSkipAt = 0;
    let listClickLocked = false;
    let listRefreshScheduled = false;
    let finishingCourse = false;
    let lastRefreshSignalAt = 0;
    let watchedTimeReachedAt = 0;

    function log(msg) {
        console.log(`${LOG} ${msg}`);
        statusText = msg;
        updatePanel();
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isVisible(element) {
        if (!(element instanceof Element) || !document.body.contains(element)) {
            return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function clickElement(el) {
        if (!el || !isVisible(el)) {
            return false;
        }
        el.click();
        return true;
    }

    function getHeartbeatAge() {
        const beat = localStorage.getItem(STORAGE_PLAYER_HEARTBEAT);
        if (!beat) {
            return Infinity;
        }
        const timestamp = Number(beat);
        return Number.isFinite(timestamp) ? Date.now() - timestamp : Infinity;
    }

    function setPlayerLock() {
        localStorage.setItem(STORAGE_PLAYER_LOCK, '1');
        localStorage.setItem(STORAGE_PLAYER_HEARTBEAT, String(Date.now()));
    }

    function releasePlayerLock() {
        localStorage.removeItem(STORAGE_PLAYER_LOCK);
        localStorage.removeItem(STORAGE_PLAYER_HEARTBEAT);
        localStorage.removeItem(STORAGE_PLAYER_TAB);
        localStorage.removeItem(STORAGE_PLAYER_URL);
    }

    function isPlayerTabOpen() {
        if (localStorage.getItem(STORAGE_PLAYER_LOCK) !== '1') {
            return false;
        }
        const tab = localStorage.getItem(STORAGE_PLAYER_TAB);
        const timeout = tab === 'list-pending' ? PENDING_PLAYER_TIMEOUT : HEARTBEAT_ACTIVE;
        const playerUrl = localStorage.getItem(STORAGE_PLAYER_URL);
        let pointsToList = false;
        if (playerUrl) {
            try {
                pointsToList = /\/(?:training\/)?member\/?$/.test(new URL(playerUrl).pathname);
            } catch (e) {
                pointsToList = true;
            }
        }
        if (getHeartbeatAge() > timeout || pointsToList) {
            releasePlayerLock();
            return false;
        }
        return true;
    }

    // 列表页启动时清理残留锁（例如手动关闭了视频 tab）
    function cleanupStaleLock() {
        if (localStorage.getItem(STORAGE_PLAYER_LOCK) !== '1') {
            return;
        }
        if (localStorage.getItem(STORAGE_PLAYER_TAB) === TAB_ID) {
            releasePlayerLock();
            return;
        }
        if (!isPlayerTabOpen()) {
            log('视频页已关闭，准备继续下一课程');
        }
    }

    function bindPlayerTabUnload(projectId) {
        window.addEventListener('pagehide', () => {
            if (projectId && Date.now() - lastRefreshSignalAt > 5000) {
                signalListRefresh(projectId);
            }
            if (localStorage.getItem(STORAGE_PLAYER_TAB) === TAB_ID) {
                releasePlayerLock();
            }
        });
    }

    function touchPlayerHeartbeat() {
        const pageType = getPageType();
        if (pageType !== 'legacy-player' && pageType !== 'train2-player') {
            return;
        }
        localStorage.setItem(STORAGE_PLAYER_LOCK, '1');
        localStorage.setItem(STORAGE_PLAYER_HEARTBEAT, String(Date.now()));
        localStorage.setItem(STORAGE_PLAYER_TAB, TAB_ID);
        localStorage.setItem(STORAGE_PLAYER_URL, location.href.split('#')[0]);
    }

    function clearPlayerTabOpen() {
        if (localStorage.getItem(STORAGE_PLAYER_TAB) === TAB_ID) {
            releasePlayerLock();
        }
    }

    function forceReleaseIfPlayerPage() {
        const pageType = getPageType();
        if (pageType === 'legacy-player' || pageType === 'train2-player') {
            releasePlayerLock();
        }
    }

    function getPageType() {
        const path = location.pathname;
        if (path.includes('/train2/') && /\/(?:training\/)?member\/?$/.test(path)) {
            return 'train2-list';
        }
        if (path.includes('/train2/')) {
            return 'train2-player';
        }
        if (path === '/train/guide/course/list') {
            return 'legacy-list';
        }
        if (/\/grain\/course\/\d+\/detail/.test(path)) {
            return 'legacy-player';
        }
        if (path.includes('/cms/project/index')) {
            return 'project-index';
        }
        return 'unknown';
    }

    function signalListRefresh(projectId) {
        if (projectId && /^\d+$/.test(projectId)) {
            lastRefreshSignalAt = Date.now();
            localStorage.setItem(STORAGE_LIST_REFRESH_EVENT,
                `${projectId}|${lastRefreshSignalAt}|${Math.random().toString(36).slice(2)}`);
        }
    }

    function refreshListAfterCourse() {
        if (listRefreshScheduled) {
            return true;
        }
        if (window !== window.top) {
            return false;
        }
        const match = location.pathname.match(/^\/train2\/workspace\/(\d+)\/(?:training\/)?member\/?$/);
        const event = localStorage.getItem(STORAGE_LIST_REFRESH_EVENT);
        if (!match || !event || sessionStorage.getItem(SESSION_LIST_REFRESH_SEEN) === event) {
            return false;
        }
        const [projectId, timestamp] = event.split('|');
        const eventTime = Number(timestamp);
        if (projectId !== match[1] || !Number.isFinite(eventTime) ||
            eventTime > Date.now() || Date.now() - eventTime > 12 * 60 * 60 * 1000) {
            return false;
        }
        // 视频页仍在学习时先暂停选择课程，离开视频页后再刷新目录。
        if (isPlayerTabOpen()) {
            return true;
        }
        sessionStorage.setItem(SESSION_LIST_REFRESH_SEEN, event);
        listRefreshScheduled = true;
        log('课程已结束，正在刷新列表进度');
        setTimeout(() => {
            if (getPageType() === 'train2-list' && window === window.top) {
                location.reload();
            }
        }, 3000);
        return true;
    }

    function findByExactText(text, root) {
        root = root || document;
        return [...root.querySelectorAll('button, a, span, div, p, li')].filter((el) => {
            return el.textContent.trim() === text && isVisible(el);
        });
    }

    function findByContainsText(text, root) {
        root = root || document;
        return [...root.querySelectorAll('button, a, span, div, p, li')].filter((el) => {
            return el.textContent.includes(text) && isVisible(el);
        });
    }

    function updatePanel() {
        let panel = document.getElementById('yx-auto-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'yx-auto-panel';
            panel.style.cssText = [
                'position:fixed',
                'top:10px',
                'right:10px',
                'z-index:999999',
                'background:rgba(0,0,0,0.75)',
                'color:#0f0',
                'padding:8px 12px',
                'border-radius:6px',
                'font-size:13px',
                'max-width:320px',
                'line-height:1.5',
                'pointer-events:none'
            ].join(';');
            document.body.appendChild(panel);
        }
        panel.textContent = `${LOG} ${statusText}`;
    }

    function hasVideoElement() {
        for (const video of document.querySelectorAll('video')) {
            if (isVisible(video)) {
                return true;
            }
        }
        for (const frame of document.querySelectorAll('iframe')) {
            try {
                const doc = frame.contentDocument;
                if (doc && doc.querySelector('video')) {
                    return true;
                }
            } catch (e) {
                // 跨域 iframe 忽略
            }
        }
        return false;
    }

    function hasActiveVideo() {
        for (const video of document.querySelectorAll('video')) {
            if (!isVisible(video)) {
                continue;
            }
            if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                return true;
            }
            if (video.currentTime > 0) {
                return true;
            }
            if (video.readyState >= 2) {
                return true;
            }
        }
        for (const frame of document.querySelectorAll('iframe')) {
            try {
                const doc = frame.contentDocument;
                if (!doc) {
                    continue;
                }
                for (const video of doc.querySelectorAll('video')) {
                    if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                        return true;
                    }
                }
            } catch (e) {
                // 跨域 iframe 忽略
            }
        }
        return false;
    }

    function isPptSlidePage() {
        if (hasVideoElement() || hasActiveVideo()) {
            return false;
        }
        return !!getDocumentPageInfo();
    }

    function isSectionHeader(item) {
        const text = item.textContent.trim();
        return SECTION_HEADERS.includes(text) ||
            (text.length < 8 && !item.querySelector('a, button'));
    }

    function getCatalogItems() {
        const selectors = [
            '.catalogue-list li',
            '.catalog-list li',
            '.menu-list li',
            '[class*="catalog"] li',
            '[class*="Catalog"] li',
            '.ivu-tree-title'
        ];
        for (const sel of selectors) {
            const found = [...document.querySelectorAll(sel)].filter(isVisible);
            if (found.length > 1) {
                return found;
            }
        }
        return [];
    }

    function findActiveCatalogIndex(items) {
        let activeIndex = -1;
        items.forEach((item, index) => {
            const cls = item.className || '';
            const style = window.getComputedStyle(item);
            if (
                cls.includes('active') ||
                cls.includes('current') ||
                cls.includes('selected') ||
                item.querySelector('.active, .current, .selected') ||
                style.color === 'rgb(24, 144, 255)' ||
                style.fontWeight === '600' ||
                style.fontWeight === '700'
            ) {
                activeIndex = index;
            }
        });
        return activeIndex;
    }

    function clickCatalogItem(items, index) {
        const item = items[index];
        if (!item || isSectionHeader(item)) {
            return false;
        }
        const target = item.querySelector('a, span, div, p') || item;
        if (clickElement(target)) {
            log(`已切换目录第 ${index + 1} 节`);
            return true;
        }
        return false;
    }

    function clickNextCatalogItem() {
        const items = getCatalogItems();
        if (items.length === 0) {
            return false;
        }
        const activeIndex = findActiveCatalogIndex(items);
        const start = activeIndex >= 0 ? activeIndex + 1 : 0;
        for (let i = start; i < items.length; i++) {
            if (isSectionHeader(items[i])) {
                continue;
            }
            if (clickCatalogItem(items, i)) {
                return true;
            }
        }
        return false;
    }

    function isReadingPage() {
        if (getPageType() !== 'legacy-player' || hasVideoElement() || hasActiveVideo()) {
            return false;
        }
        for (const frame of document.querySelectorAll('iframe[src]')) {
            try {
                if (isVisible(frame) && new URL(frame.src, location.href).hostname === 'preview.yanxiu.com') {
                    return true;
                }
            } catch (e) {
                // 非标准 iframe 地址忽略
            }
        }
        const items = getCatalogItems();
        const activeIndex = findActiveCatalogIndex(items);
        if (activeIndex >= 0 && items[activeIndex].textContent.trim() !== '延伸阅读') {
            for (let i = activeIndex; i >= 0; i--) {
                const title = items[i].textContent.trim();
                if (SECTION_HEADERS.includes(title)) {
                    return title === '延伸阅读';
                }
            }
        }
        for (const heading of findByExactText('延伸阅读')) {
            const headingRect = heading.getBoundingClientRect();
            let container = heading.parentElement;
            for (let depth = 0; depth < 6 && container && container !== document.body; depth++) {
                const selected = [...container.querySelectorAll('.active, .current, .selected, [aria-selected="true"]')]
                    .find((el) => isVisible(el) &&
                        el.textContent.trim() !== '延伸阅读' &&
                        el.getBoundingClientRect().top > headingRect.bottom &&
                        Math.abs(el.getBoundingClientRect().left - headingRect.left) < 150);
                if (selected) {
                    return true;
                }
                container = container.parentElement;
            }
        }
        return false;
    }

    function handleSkipNonVideoLesson() {
        if (!SKIP_PPT) {
            return;
        }
        const now = Date.now();
        const reading = isReadingPage();
        if (!reading && !isPptSlidePage()) {
            return;
        }
        if (reading && now - playerLoadAt < READING_LOAD_WAIT) {
            return;
        }
        if (now - lastSkipAt < 2000) {
            return;
        }

        const hasKnownReadingPosition = !reading || findActiveCatalogIndex(getCatalogItems()) >= 0;
        if (hasKnownReadingPosition && clickNextCatalogItem()) {
            lastSkipAt = now;
            log(reading ? '已跳过延伸阅读，切换下一节' : '已跳过 PPT，切换下一节');
            return;
        }

        log('目录已全部浏览，返回列表');
        lastSkipAt = now;
        if (now - lastNextClickAt >= 5000) {
            lastNextClickAt = now;
            finishCurrentCourse();
        }
    }

    function getDocumentPageInfo() {
        const candidates = [...document.querySelectorAll('span, div, p, em, b')].filter(isVisible);
        for (const el of candidates) {
            const text = el.textContent.trim();
            const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
            if (match) {
                const current = parseInt(match[1], 10);
                const total = parseInt(match[2], 10);
                if (total > 0 && current > 0 && current <= total) {
                    return { current: current, total: total, el: el };
                }
            }
        }
        return null;
    }

    function finishCurrentCourse() {
        if (finishingCourse) {
            return;
        }
        finishingCourse = true;
        if (location.pathname.includes('/train2/')) {
            log('本节已学完，返回课程列表');
            const workspace = location.pathname.match(/^\/train2\/workspace\/(\d+)/);
            const memberUrl = workspace
                ? new URL(`/train2/workspace/${workspace[1]}/member`, location.origin).href
                : location.href.replace(/\/training\/[^/?#]+.*$/, '/training/member');
            setTimeout(() => {
                signalListRefresh(workspace && workspace[1]);
                forceReleaseIfPlayerPage();
                if (window.opener && !window.opener.closed) {
                    window.close();
                    if (window.closed) {
                        return;
                    }
                }
                if (memberUrl !== location.href) {
                    location.href = memberUrl;
                }
            }, 2000);
            return;
        }
        log('本节已学完，关闭页面返回列表');
        const projectId = new URLSearchParams(location.search).get('projectId');
        const memberUrl = projectId && /^\d+$/.test(projectId)
            ? new URL(`/train2/workspace/${projectId}/member`, location.origin).href
            : null;
        setTimeout(() => {
            signalListRefresh(projectId);
            forceReleaseIfPlayerPage();
            if (window.opener && !window.opener.closed) {
                window.close();
                if (window.closed) {
                    return;
                }
            }
            if (memberUrl) {
                location.href = memberUrl;
            } else {
                history.back();
            }
        }, 2000);
    }

    function applyPlaybackRate(video) {
        video.muted = true;
        if (video.playbackRate !== PLAYBACK_RATE) {
            video.playbackRate = PLAYBACK_RATE;
        }
        if (video.paused && !video.ended) {
            video.play().catch(() => {});
        }
    }

    function handleCommonPopups() {
        const alarmSelectors = [
            '.alarmClock-wrapper',
            '.clock-tip',
            '[class*="alarmClock"]',
            '[class*="AlarmClock"]'
        ];
        for (const sel of alarmSelectors) {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) {
                clickElement(el);
                log('已点击继续计时');
                return true;
            }
        }
        findByContainsText('点击我继续').forEach((el) => {
            if (!el.closest('.question-stem')) {
                clickElement(el);
            }
        });

        const scoring = document.querySelector('.scoring-wrapper');
        if (scoring && isVisible(scoring)) {
            const rateBtn = document.querySelector('div.commit > button.ivu-btn');
            if (rateBtn) {
                rateBtn.disabled = false;
                clickElement(rateBtn);
                log('已提交课程评分');
            }
        }

        handleQuiz();

        const textBtns = document.querySelectorAll('button.ivu-btn.ivu-btn-text');
        if (textBtns.length === 2 && isVisible(textBtns[1])) {
            clickElement(textBtns[1]);
        }
        return false;
    }

    function tryGoNextVideo() {
        const now = Date.now();
        if (now - lastNextClickAt < 5000) {
            return true;
        }

        const nextBtn =
            document.querySelector('p.next') ||
            document.querySelector('.ended-mask .next') ||
            findByExactText('下一个')[0] ||
            findByExactText('下一节')[0] ||
            findByContainsText('下一个')[0];

        if (nextBtn && isVisible(nextBtn)) {
            clickElement(nextBtn);
            lastNextClickAt = now;
            log('当前视频已学完，点击下一节');
            return true;
        }

        if (clickNextCatalogItem()) {
            lastNextClickAt = now;
            return true;
        }

        return false;
    }

    function handleQuiz() {
        document.querySelectorAll('.question-stem').forEach((item, index) => {
            if (!isVisible(item)) {
                return;
            }
            const label = item.querySelector('.label-text');
            if (label) {
                clickElement(label);
            }
            setTimeout(() => {
                const btns = document.querySelectorAll('.question button.ivu-btn.ivu-btn-primary');
                if (btns[index]) {
                    clickElement(btns[index]);
                }
            }, 1500);
        });

        document.querySelectorAll('.ivu-modal-wrap:not([style*="display: none"]) .ivu-radio-wrapper').forEach((radio) => {
            if (isVisible(radio)) {
                clickElement(radio);
            }
        });
        document.querySelectorAll('.ivu-modal-wrap:not([style*="display: none"]) .ivu-btn-primary').forEach((btn) => {
            if (isVisible(btn) && btn.textContent.includes('确定')) {
                clickElement(btn);
            }
        });
    }

    function expandModules() {
        document.querySelectorAll('.ivu-collapse-header, [class*="collapse"] [class*="header"]').forEach((header) => {
            const item = header.closest('.ivu-collapse-item, [class*="collapse-item"]');
            if (item && !item.classList.contains('ivu-collapse-item-active')) {
                clickElement(header);
            }
        });
    }

    function parseCourseMinutes(text) {
        const hours = text.match(/(\d+)\s*小时/);
        const minutes = text.match(/(\d+)\s*分钟/);
        return (hours ? Number(hours[1]) * 60 : 0) +
            (minutes ? Number(minutes[1]) : 0);
    }

    function hydrateCourseCursorDuration() {
        const workspace = location.pathname.match(/^\/train2\/workspace\/(\d+)/);
        if (!workspace) {
            return;
        }
        const key = STORAGE_COURSE_CURSOR_PREFIX + workspace[1];
        let cursor;
        try {
            cursor = JSON.parse(localStorage.getItem(key));
        } catch (e) {
            return;
        }
        if (!cursor || cursor.durationMinutes > 0 || !cursor.title) {
            return;
        }
        for (const card of document.querySelectorAll('.learn-course-list .tool-card')) {
            if (card.querySelector('.tool-card__title')?.textContent.trim() !== cursor.moduleName) {
                continue;
            }
            for (const row of card.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row')) {
                const cells = [...row.querySelectorAll(':scope > td')];
                if (cells[0]?.textContent.replace(/\s+/g, ' ').trim() !== cursor.title) {
                    continue;
                }
                const durationMinutes = parseCourseMinutes(cells[1]?.textContent || '');
                if (durationMinutes > 0) {
                    localStorage.setItem(key, JSON.stringify({ ...cursor, durationMinutes }));
                }
                return;
            }
        }
    }

    function findNextIncompleteLesson() {
        const watchTexts = ['继续看课', '开始看课', '去看课', '看课'];
        if (getPageType() === 'train2-list') {
            const cards = [...document.querySelectorAll('.learn-course-list .tool-card')];
            const workspace = location.pathname.match(/^\/train2\/workspace\/(\d+)/);
            let cursor = null;
            if (workspace) {
                try {
                    cursor = JSON.parse(localStorage.getItem(STORAGE_COURSE_CURSOR_PREFIX + workspace[1]));
                } catch (e) {
                    // 尚未记录课程顺序时从第一行开始。
                }
            }
            for (const card of cards) {
                const moduleName = card.querySelector('.tool-card__title')?.textContent.trim() || '课程';
                const requiredText = card.querySelector('.tool-card__participate')?.textContent || '';
                const learnedText = card.querySelector('.tool-card__achieved')?.textContent || '';
                const requiredMatch = requiredText.match(/观看课程\s*([\d.]+)\s*分钟/);
                const learnedMatch = learnedText.match(/已学习\s*([\d.]+)\s*分钟/);
                if (requiredMatch && learnedMatch &&
                    Number(learnedMatch[1]) >= Number(requiredMatch[1])) {
                    continue;
                }

                const rows = [...card.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row')];
                const courses = rows.map((row, index) => {
                    const cells = [...row.querySelectorAll(':scope > td')];
                    const button = [...(cells[3] || row).querySelectorAll('button, a')]
                        .find((el) => watchTexts.includes(el.textContent.trim()) && isVisible(el));
                    const match = (cells[2] || row).textContent.match(/(\d{1,3})\s*%/);
                    const title = (cells[0] || row).textContent.replace(/\s+/g, ' ').trim();
                    const durationMinutes = parseCourseMinutes((cells[1] || row).textContent);
                    return { button, percent: match ? Number(match[1]) : 0,
                        index, title, moduleName, durationMinutes };
                });
                let start = 0;
                if (cursor && cursor.moduleName === moduleName && courses.length > 0) {
                    const index = Number.isInteger(cursor.index) &&
                        courses[cursor.index] && courses[cursor.index].title === cursor.title
                        ? cursor.index
                        : courses.findIndex((course) => course.title === cursor.title);
                    if (index >= 0) {
                        start = (index + 1) % courses.length;
                    }
                }
                for (let offset = 0; offset < courses.length; offset++) {
                    const course = courses[(start + offset) % courses.length];
                    if (course.button && course.percent < 100) {
                        return course;
                    }
                }

                const nextPage = card.querySelector('.el-pagination .btn-next');
                if (rows.length > 0 && nextPage && !nextPage.disabled &&
                    nextPage.getAttribute('aria-disabled') !== 'true' &&
                    !nextPage.classList.contains('disabled') && isVisible(nextPage)) {
                    return { action: 'next-page', button: nextPage, moduleName };
                }
            }
            return null;
        }

        const candidates = [...document.querySelectorAll('button, a')].filter((el) => {
            const text = el.textContent.trim();
            return watchTexts.includes(text) && isVisible(el);
        });
        const buttons = candidates.filter((el) => {
            return !candidates.some((other) => other !== el && other.contains(el));
        });

        let unknownProgress = null;
        for (const btn of buttons) {
            let container = btn.parentElement;
            let foundProgress = false;
            for (let depth = 0; depth < 12 && container; depth++) {
                const match = container.textContent.match(/(?:已观看|进度)?\s*(\d{1,3})\s*%/);
                if (match) {
                    const percent = parseInt(match[1], 10);
                    foundProgress = true;
                    if (percent < 100) {
                        return { button: btn, percent: percent };
                    }
                    break;
                }
                container = container.parentElement;
            }
            if (!foundProgress && !unknownProgress) {
                unknownProgress = { button: btn, percent: 0 };
            }
        }

        return unknownProgress;
    }

    function handleCourseList() {
        const pageType = getPageType();
        if (pageType !== 'train2-list' && pageType !== 'project-index') {
            return;
        }
        expandModules();
        hydrateCourseCursorDuration();
        if (refreshListAfterCourse()) {
            return;
        }

        const hasVideo = document.querySelector('video');
        if (hasVideo && isVisible(hasVideo)) {
            return;
        }

        if (isPlayerTabOpen()) {
            log(localStorage.getItem(STORAGE_PLAYER_TAB) === 'list-pending'
                ? '正在打开学习页，若未打开将自动重试'
                : '已有学习页在进行，等待完成');
            return;
        }

        if (listClickLocked) {
            return;
        }

        const lesson = findNextIncompleteLesson();
        if (!lesson) {
            log('当前模块已达目标学时，或没有可看的未完成课程');
            return;
        }

        if (lesson.action === 'next-page') {
            listClickLocked = true;
            if (clickElement(lesson.button)) {
                log(`${lesson.moduleName}当前页已看完，切换下一页`);
            }
            setTimeout(() => {
                listClickLocked = false;
            }, 3000);
            return;
        }

        const now = Date.now();
        if (now - lastListClickAt < LIST_CLICK_RETRY) {
            return;
        }

        listClickLocked = true;
        if (clickElement(lesson.button)) {
            const workspace = location.pathname.match(/^\/train2\/workspace\/(\d+)/);
            signalListRefresh(workspace && workspace[1]);
            if (workspace && Number.isInteger(lesson.index)) {
                localStorage.setItem(STORAGE_COURSE_CURSOR_PREFIX + workspace[1],
                    JSON.stringify({ index: lesson.index, title: lesson.title,
                        moduleName: lesson.moduleName,
                        durationMinutes: lesson.durationMinutes, clickedAt: now }));
            }
            lastListClickAt = now;
            setPlayerLock();
            localStorage.setItem(STORAGE_PLAYER_TAB, 'list-pending');
            log(`已打开${lesson.moduleName}：${lesson.title}（进度 ${lesson.percent}%）`);
        }
        setTimeout(() => {
            listClickLocked = false;
        }, 3000);
    }

    function finishWhenWatchTimeReached() {
        if (getPageType() !== 'legacy-player' || finishingCourse) {
            return false;
        }
        const projectId = new URLSearchParams(location.search).get('projectId');
        const courseId = (location.pathname.match(/^\/grain\/course\/(\d+)\/detail/) || [])[1];
        if (!projectId || !courseId) {
            return false;
        }
        const key = STORAGE_COURSE_CURSOR_PREFIX + projectId;
        let cursor;
        try {
            cursor = JSON.parse(localStorage.getItem(key));
        } catch (e) {
            return false;
        }
        if (!cursor || !(cursor.durationMinutes > 0)) {
            return false;
        }
        if (!cursor.courseId) {
            const pageTitle = (document.querySelector('.headInfo-wrapper')?.textContent || '')
                .replace(/\s+/g, '').replace(/[《》]/g, '');
            const courseTitle = cursor.title.replace(/^(必修|选修)/, '')
                .replace(/\s+/g, '').replace(/[《》]/g, '');
            const titleMatches = courseTitle.length >= 4 && pageTitle.includes(courseTitle);
            const justOpened = Date.now() - Number(cursor.clickedAt) < 5 * 60 * 1000;
            if ((pageTitle && !titleMatches) || (!pageTitle && !justOpened)) {
                return false;
            }
            cursor.courseId = courseId;
            localStorage.setItem(key, JSON.stringify(cursor));
        }
        if (cursor.courseId !== courseId) {
            return false;
        }

        const timerText = [...document.querySelectorAll('.action-timer .state')]
            .filter(isVisible).map((el) => el.textContent).join(' ');
        const match = timerText.match(/您已完成看课(?:总)?时长\s*([\d.]+)\s*分钟/);
        const watchedMinutes = match ? Number(match[1]) : 0;
        if (watchedMinutes < cursor.durationMinutes) {
            watchedTimeReachedAt = 0;
            return false;
        }
        if (!watchedTimeReachedAt) {
            watchedTimeReachedAt = Date.now();
            log(`已完成看课时长 ${watchedMinutes}/${cursor.durationMinutes} 分钟，等待进度保存`);
        }
        if (Date.now() - watchedTimeReachedAt >= 10000) {
            finishCurrentCourse();
            return true;
        }
        return false;
    }

    function handleVideoPlayer() {
        const pageType = getPageType();
        if (pageType !== 'train2-player' && pageType !== 'legacy-player') {
            return;
        }
        touchPlayerHeartbeat();

        if (finishWhenWatchTimeReached()) {
            return;
        }

        if (handleCommonPopups()) {
            return;
        }

        if (!hasActiveVideo()) {
            if (hasVideoElement()) {
                document.querySelectorAll('video').forEach((video) => {
                    video.play().catch(() => {});
                });
                log('视频加载中…');
                return;
            }
            if (Date.now() - playerLoadAt < PLAYER_LOAD_WAIT) {
                log('页面加载中…');
                return;
            }
            if (SKIP_PPT) {
                handleSkipNonVideoLesson();
            }
            return;
        }

        let anyEnded = false;

        document.querySelectorAll('video').forEach((video) => {
            applyPlaybackRate(video);
            if (video.ended) {
                anyEnded = true;
            }
        });

        document.querySelectorAll('iframe').forEach((frame) => {
            try {
                const doc = frame.contentDocument;
                if (!doc) {
                    return;
                }
                doc.querySelectorAll('video').forEach((video) => {
                    applyPlaybackRate(video);
                    if (video.ended) {
                        anyEnded = true;
                    }
                });
            } catch (e) {
                // 跨域 iframe 忽略
            }
        });

        const endedMask = document.querySelector('.ended-mask');
        if ((endedMask && isVisible(endedMask)) || anyEnded) {
            if (!tryGoNextVideo()) {
                finishCurrentCourse();
            }
        }
    }

    async function handleLegacyCourseList() {
        await sleep(500);

        function getGoal() {
            const ems = document.querySelectorAll('em');
            if (ems.length >= 2) {
                const total = parseInt(ems[0].innerText.match(/\d+(?=分钟)/));
                const done = parseInt(ems[1].innerText.match(/\d+(?=分钟)/)[0]);
                return total - done;
            }
            return 300;
        }

        function getProgress(item) {
            const info = item.firstElementChild.lastElementChild;
            if (info.className === 'item-infos pass') {
                return 1;
            }
            if (info.lastElementChild.childElementCount === 1) {
                return 0;
            }
            return 0.01 * parseInt(info.lastElementChild.lastElementChild.innerText.match(/\d+(?=%)/)[0]);
        }

        const minutesTotal = getGoal();
        const filterBtn = document.querySelector('ul.filter-data > li:nth-child(3) > div > div.content > div:nth-child(3) > span');
        if (filterBtn) {
            clickElement(filterBtn);
        }
        await sleep(500);

        if (document.querySelectorAll('div.item').length === 0) {
            const allBtn = document.querySelector('ul.filter-data > li:nth-child(3) > div > div.content > div:nth-child(1) > span');
            if (allBtn) {
                clickElement(allBtn);
            }
        }
        await sleep(500);

        const courses = document.querySelectorAll('div.item');
        if (minutesTotal <= 0) {
            log('已完成所需学时');
            return;
        }

        if (isPlayerTabOpen()) {
            log('已有学习页在进行，等待完成');
            return;
        }

        for (let i = 0; i < courses.length; i++) {
            const progress = getProgress(courses[i]);
            if (progress >= 1) {
                continue;
            }
            const link = courses[i].firstChild.firstChild;
            if (link) {
                clickElement(link);
                setPlayerLock();
                localStorage.setItem(STORAGE_PLAYER_TAB, 'list-pending');
                log(`已打开第 ${i + 1} 个课程`);
            }
            break;
        }
    }

    function start() {
        updatePanel();
        const pageType = getPageType();
        log(`检测到页面类型: ${pageType}`);

        if (pageType === 'train2-list' || pageType === 'project-index') {
            window.addEventListener('focus', refreshListAfterCourse);
            window.addEventListener('storage', (event) => {
                if (event.key === STORAGE_LIST_REFRESH_EVENT || event.key === STORAGE_PLAYER_LOCK) {
                    refreshListAfterCourse();
                }
            });
            cleanupStaleLock();
            bindPlayerTabUnload();
            refreshListAfterCourse();
            setTimeout(handleCourseList, 3000);
            setInterval(handleCourseList, 10000);
            setInterval(handleVideoPlayer, 3000);
        } else if (pageType === 'legacy-list') {
            cleanupStaleLock();
            handleLegacyCourseList();
        } else if (pageType === 'train2-player' || pageType === 'legacy-player') {
            const projectId = pageType === 'legacy-player'
                ? new URLSearchParams(location.search).get('projectId')
                : (location.pathname.match(/^\/train2\/workspace\/(\d+)/) || [])[1];
            bindPlayerTabUnload(projectId);
            touchPlayerHeartbeat();
            signalListRefresh(projectId);
            document.addEventListener('visibilitychange', () => {
                touchPlayerHeartbeat();
            });
            // 独立心跳，避免 handleVideoPlayer 在后台 tab 被节流后列表页误判
            setInterval(() => {
                touchPlayerHeartbeat();
            }, 10000);
            handleVideoPlayer();
            let returnedToList = false;
            setInterval(() => {
                if (getPageType() === 'train2-list') {
                    if (!returnedToList) {
                        returnedToList = true;
                        signalListRefresh(projectId);
                        clearPlayerTabOpen();
                    }
                    handleCourseList();
                } else {
                    handleVideoPlayer();
                }
            }, 3000);
            setInterval(handleQuiz, 5000);
        } else {
            cleanupStaleLock();
            setTimeout(() => {
                handleCourseList();
                handleVideoPlayer();
            }, 3000);
            setInterval(handleCourseList, 10000);
            setInterval(handleVideoPlayer, 3000);
            setInterval(handleQuiz, 5000);
        }
    }

    start();
})();
