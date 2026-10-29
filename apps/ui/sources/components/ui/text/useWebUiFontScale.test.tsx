import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID, HAPPIER_UI_FONT_SCALE_CSS_VAR } from './webUnistylesFontOverrides';
import { observeDocumentUnistylesFontMetrics, setRootCssVar } from './webUnistylesFontOverrides';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Preference selection and storage stay real; only browser/clock boundaries are substituted.
const { storage } = await import('@/sync/domains/state/storageStore');
const { useWebUiFontScale } = await import('./useWebUiFontScale');

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ['__HAPPIER_WEB_UI_FONT_SCALE_SYNC_SCHEDULED__', '__HAPPIER_WEB_UI_FONT_SCALE_INSERT_RULE_PATCHED__']) {
        Reflect.deleteProperty(globalThis, key);
    }
});

it('scales late nested CSSOM font declarations used by Unistyles, including a changed metric, without polling', async () => {
    const dom = new JSDOM('<!doctype html><html><head><style></style></head><body><span class="unistyles_label">Label</span></body></html>');
    const document = dom.window.document;
    const stop = observeDocumentUnistylesFontMetrics(document);
    try {
        setRootCssVar(document, 2);
        const sheet = document.styleSheets[0]!;
        // react-native-unistyles 3.5.3 + the repo patch: CSSState.updateRule inserts
        // an empty rule inside @media, then assigns its declaration through cssText.
        sheet.insertRule('@media all {}', 0);
        const group = sheet.cssRules[0] as CSSGroupingRule;
        group.insertRule('.unistyles_label {}', 0);
        const rule = group.cssRules[0] as CSSStyleRule;
        rule.style.cssText = 'font-size: 14px; line-height: 20px;';
        await Promise.resolve();
        const override = () => document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID)!.textContent!;
        expect(override()).toContain('font-size: calc(14px * var(--happier-ui-font-scale))');
        expect(document.documentElement.style.getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR)).toBe('2');
        const retained = override();
        rule.style.cssText = 'font-size: 14px; line-height: 20px; color: red;';
        await Promise.resolve();
        expect(override()).toBe(retained);
        rule.style.cssText = 'font-size: 16px; line-height: 24px;';
        await Promise.resolve();
        expect(override()).toContain('font-size: calc(16px * var(--happier-ui-font-scale))');
        expect(override()).not.toContain('font-size: calc(14px *');
    } finally { stop(); dom.window.close(); }
});

it('keeps the same class separate across Unistyles media queries and preserves child selectors', () => {
    const dom = new JSDOM('<!doctype html><html><head><style>@media all { .unistyles_responsive { font-size: 14px; } } @media (min-width: 800px) { .unistyles_responsive { font-size: 18px; } .unistyles_child > * { font-size: 12px; } }</style></head><body></body></html>');
    const stop = observeDocumentUnistylesFontMetrics(dom.window.document);
    try {
        const sheet = (dom.window.document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID) as HTMLStyleElement).sheet!;
        const media = Array.from(sheet.cssRules).filter(rule => rule.type === 4) as CSSMediaRule[];
        expect([...new Set(media.map(rule => rule.conditionText))]).toEqual(['all', '(min-width: 800px)']);
        const rulesFor = (condition: string) => media.filter(rule => rule.conditionText === condition)
            .flatMap(rule => Array.from(rule.cssRules)) as CSSStyleRule[];
        expect(rulesFor('all').find(rule => rule.selectorText === '.unistyles_responsive')!.style.getPropertyValue('font-size')).toContain('14px');
        const wide = rulesFor('(min-width: 800px)');
        expect(wide.find(rule => rule.selectorText === '.unistyles_responsive')!.style.getPropertyValue('font-size')).toContain('18px');
        expect(wide.some(rule => rule.selectorText === '.unistyles_child > *')).toBe(true);
    } finally { stop(); dom.window.close(); }
});

it('updates only new font rules, without idle frames or observing its own writes, for both mounted roots', async () => {
    const dom = new JSDOM('<!doctype html><html><head><style>.unistyles_initial { font-size: 16px; }</style></head><body></body></html>');
    const { document, CSSStyleSheet, MutationObserver } = dom.window;
    const originalInsertRule = CSSStyleSheet.prototype.insertRule;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
    });
    const flushFrames = async () => {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => { for (const callback of pending) callback(0); });
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('CSSStyleSheet', CSSStyleSheet);
    vi.stubGlobal('MutationObserver', MutationObserver);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const previousSettings = storage.getState().localSettings;
    storage.setState({ localSettings: { ...previousSettings, uiFontScale: 1.25 } });
    try {
        const root = await renderHook(() => useWebUiFontScale());
        const embed = await renderHook(() => useWebUiFontScale());
        await vi.advanceTimersByTimeAsync(50);
        await flushFrames();
        await flushFrames();
        requestFrame.mockClear();
        const sheet = document.styleSheets[0]!;
        for (let index = 0; index < 50; index++) sheet.insertRule(`.unrelated_${index} { color: red; }`);
        await act(async () => { await Promise.resolve(); });
        expect(requestFrame, 'unrelated CSS is not font-scaling demand').toHaveBeenCalledTimes(0);

        const override = () => document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID)?.textContent ?? '';
        expect(override()).toContain('font-size: calc(16px *');
        const unscaledText = document.createElement('span');
        unscaledText.setAttribute('data-happier-ui-font-scaling', 'disabled');
        document.body.appendChild(unscaledText);
        expect(dom.window.getComputedStyle(unscaledText).getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR), 'disableUiFontScaling opts out of the scale').toBe('1');
        let publications = 0;
        const publishedStyle = document.getElementById(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID)!;
        const publicationObserver = new MutationObserver((records: MutationRecord[]) => {
            publications += records.filter(record => record.target === publishedStyle).length;
        });
        publicationObserver.observe(publishedStyle, { childList: true });
        try {
            for (let index = 0; index < 50; index++) sheet.insertRule(`.unistyles_burst_${index} { font-size: ${14 + index}px; }`);
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            expect(override()).toContain('.unistyles_burst_49');
            expect(publications, 'one synchronous style burst publishes once before paint').toBe(1);
        } finally { publicationObserver.disconnect(); }
        sheet.insertRule('.unistyles_late { font-size: 18px; line-height: 24px; }');
        await act(async () => { await Promise.resolve(); });
        expect(override()).toContain('font-size: calc(18px *');
        expect(override()).toContain('line-height: calc(24px *');
        sheet.insertRule('.unistyles_late { font-size: 18px; line-height: 24px; }');
        await act(async () => { await Promise.resolve(); });
        expect(override().split('.unistyles_late ').length - 1, 'a re-inserted known rule is not duplicated').toBe(1);

        const added = document.createElement('style');
        added.textContent = '.unistyles_sheet { font-size: 22px; }';
        document.head.appendChild(added);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(override()).toContain('font-size: calc(22px *');
        expect(override().split('.unistyles_late ').length - 1, 'later publications do not re-append injected rules').toBe(1);
        await root.unmount();
        sheet.insertRule('.unistyles_remaining { letter-spacing: 2px; }');
        await act(async () => { await Promise.resolve(); });
        expect(override()).toContain('letter-spacing: calc(2px *');

        await act(async () => storage.getState().applyLocalSettings({ uiFontScale: 1.5 }, { persist: false }));
        expect(document.documentElement.style.getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR)).toBe('1.5');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(requestFrame).toHaveBeenCalledTimes(0);
        expect(frames.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await embed.unmount();
        expect(CSSStyleSheet.prototype.insertRule).toBe(originalInsertRule);
        const retained = override();
        sheet.insertRule('.unistyles_retired { font-size: 30px; }');
        await Promise.resolve();
        expect(override()).toBe(retained);
    } finally {
        standardCleanup();
        storage.setState({ localSettings: previousSettings });
        CSSStyleSheet.prototype.insertRule = originalInsertRule;
        dom.window.close();
    }
});
