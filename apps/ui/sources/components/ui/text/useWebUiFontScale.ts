import * as React from 'react';
import { Platform } from 'react-native';

import { useLocalSetting } from '@/sync/store/hooks';

import {
    ensureOverrideStyleElement,
    scanDocumentForUnistylesFontMetrics,
    setRootCssVar,
    syncOverrideStyleElement,
    type UnistylesFontMetric,
} from './webUnistylesFontOverrides';

let webOverrideObserverInstalled = false;
const webUnistylesFontMetricsCache = new Map<string, UnistylesFontMetric>();

function scheduleSync() {
    if (typeof document === 'undefined') return;
    const g = globalThis as any;
    if (g.__HAPPIER_WEB_UI_FONT_SCALE_SYNC_SCHEDULED__) return;
    g.__HAPPIER_WEB_UI_FONT_SCALE_SYNC_SCHEDULED__ = true;

    const run = () => {
        g.__HAPPIER_WEB_UI_FONT_SCALE_SYNC_SCHEDULED__ = false;
        try {
            const added = scanDocumentForUnistylesFontMetrics(document, webUnistylesFontMetricsCache);
            if (added <= 0) return;
            const styleEl = ensureOverrideStyleElement(document);
            syncOverrideStyleElement(styleEl, webUnistylesFontMetricsCache);
        } catch {
            // best-effort only
        }
    };

    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(run);
        return;
    }
    setTimeout(run, 0);
}

function installObserverOnce() {
    if (webOverrideObserverInstalled) return;
    if (typeof document === 'undefined') return;

    webOverrideObserverInstalled = true;

    try {
        // Some CSS-in-JS engines (including Unistyles) add new rules via `CSSStyleSheet.insertRule`,
        // which does not mutate DOM nodes. Patch insertRule to schedule a rescan when new rules land.
        const g = globalThis as any;
        if (!g.__HAPPIER_WEB_UI_FONT_SCALE_INSERT_RULE_PATCHED__ && typeof CSSStyleSheet !== 'undefined') {
            const proto = (CSSStyleSheet as any)?.prototype;
            const original = proto?.insertRule;
            if (typeof original === 'function') {
                g.__HAPPIER_WEB_UI_FONT_SCALE_INSERT_RULE_PATCHED__ = true;
                proto.insertRule = function patchedInsertRule(this: CSSStyleSheet, ...args: any[]) {
                    const result = original.apply(this, args);
                    scheduleSync();
                    return result;
                };
            }
        }

        // Fallback: also observe <style> / <link> changes in case the engine swaps sheets.
        if (typeof MutationObserver === 'function') {
            const observer = new MutationObserver(() => {
                scheduleSync();
            });
            observer.observe(document.head, { childList: true, subtree: true });
        }
    } catch {
        // ignore
    }
}

/**
 * Web-only: Unistyles compiles many font-related styles into static CSS classes (no numeric `fontSize`
 * values remain in React `style` props), so per-component JS scaling cannot reliably adjust font sizes.
 *
 * This hook:
 * - sets a root CSS variable for the chosen UI font scale
 * - generates an override stylesheet that scales `.unistyles_*` font rules via `calc(... * var(--scale))`
 * - keeps the override sheet up-to-date as new Unistyles classes are injected at runtime
 */
export function useWebUiFontScale() {
    const scale = useLocalSetting('uiFontScale');

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        // One-time setup: create override sheet + initial scan/sync + observers for late-injected rules.
        const styleEl = ensureOverrideStyleElement(document);
        scanDocumentForUnistylesFontMetrics(document, webUnistylesFontMetricsCache);
        syncOverrideStyleElement(styleEl, webUnistylesFontMetricsCache);
        installObserverOnce();

        // In practice, Unistyles can inject styles a tick after mount/render; do a couple extra passes.
        scheduleSync();
        const t = setTimeout(scheduleSync, 50);
        return () => clearTimeout(t);
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;
        setRootCssVar(document, scale);
    }, [scale]);
}
