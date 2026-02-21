import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    scanDocumentForUnistylesFontMetrics,
    ensureOverrideStyleElement,
    syncOverrideStyleElement,
    setRootCssVar,
    HAPPIER_UI_FONT_SCALE_CSS_VAR,
    HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID,
} from './webUnistylesFontOverrides';

describe('webUnistylesFontOverrides', () => {
    it('generates calc(var(--scale)) overrides for Unistyles font rules', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        const styleTag = document.createElement('style');
        styleTag.textContent = `
            .unistyles_a1 { font-size: 16px; line-height: 24px; letter-spacing: 0.15px; color: red; }
            .unistyles_b2 { font-size: 14px; }
        `;
        document.head.appendChild(styleTag);

        const metrics = new Map<string, { fontSize?: string; lineHeight?: string; letterSpacing?: string }>();
        const added = scanDocumentForUnistylesFontMetrics(document, metrics);
        expect(added).toBe(2);

        const overrideEl = ensureOverrideStyleElement(document);
        const appended = syncOverrideStyleElement(overrideEl, metrics);
        expect(appended).toBe(2);

        const css = overrideEl.textContent ?? '';
        expect(css).toContain(`.${'unistyles_a1'}`);
        expect(css).toContain(`font-size: calc(16px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
        expect(css).toContain(`line-height: calc(24px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
        expect(css).toContain(`letter-spacing: calc(0.15px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);

        expect(css).toContain(`.${'unistyles_b2'}`);
        expect(css).toContain(`font-size: calc(14px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}))`);
    });

    it('sets the root CSS variable to the provided scale', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        setRootCssVar(document, 1.1);
        const raw = document.documentElement.style.getPropertyValue(HAPPIER_UI_FONT_SCALE_CSS_VAR);
        expect(raw.trim()).toBe('1.1');
    });

    it('does not duplicate override rules when synced repeatedly', () => {
        const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`);
        const { document } = dom.window;

        const styleTag = document.createElement('style');
        styleTag.textContent = `.unistyles_a1 { font-size: 16px; }`;
        document.head.appendChild(styleTag);

        const metrics = new Map<string, { fontSize?: string; lineHeight?: string; letterSpacing?: string }>();
        scanDocumentForUnistylesFontMetrics(document, metrics);

        const overrideEl = ensureOverrideStyleElement(document);
        expect(overrideEl.id).toBe(HAPPIER_UI_FONT_OVERRIDE_STYLE_ELEMENT_ID);

        const appended1 = syncOverrideStyleElement(overrideEl, metrics);
        const appended2 = syncOverrideStyleElement(overrideEl, metrics);
        expect(appended1).toBe(1);
        expect(appended2).toBe(0);

        const css = overrideEl.textContent ?? '';
        const occurrences = css.split('.unistyles_a1').length - 1;
        expect(occurrences).toBe(1);
    });
});
