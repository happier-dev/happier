import { describe, expect, it } from 'vitest';

import {
    TIPTAP_WEBVIEW_BUNDLE_JS,
    TIPTAP_WEBVIEW_CSS,
} from '../tiptapWebViewBundle.generated';

/**
 * R6 / D9: the committed native WebView bundle is load-bearing — there is NO CDN
 * fallback. If the generated bundle regresses to empty/placeholder, the native
 * rich editor silently fails closed to raw for everyone. This guard fails the
 * suite the moment the committed bundle is empty, catching that regression in CI
 * (the build step also asserts non-empty, F8; this is the runtime backstop).
 */

describe('TIPTAP_WEBVIEW_BUNDLE_JS', () => {
    it('is a non-empty string (the bundle was actually built + committed)', () => {
        expect(typeof TIPTAP_WEBVIEW_BUNDLE_JS).toBe('string');
        expect(TIPTAP_WEBVIEW_BUNDLE_JS.length).toBeGreaterThan(0);
    });

    it('embeds the headless WebView runtime global assignment', () => {
        // The esbuild entry assigns `globalThis.HAPPIER_TIPTAP_WEBVIEW`; a real
        // build contains that identifier (a placeholder would not).
        expect(TIPTAP_WEBVIEW_BUNDLE_JS).toContain('HAPPIER_TIPTAP_WEBVIEW');
    });

    it('does not dispatch raw bridge command names by spreading arbitrary args', () => {
        expect(TIPTAP_WEBVIEW_BUNDLE_JS).not.toMatch(/kind:[A-Za-z_$][\w$]*,\.\.\.[A-Za-z_$][\w$]*/);
    });

    it('embeds the typed menu-command parser cases', () => {
        expect(TIPTAP_WEBVIEW_BUNDLE_JS).toContain('setHeading');
        expect(TIPTAP_WEBVIEW_BUNDLE_JS).toContain('setLink');
    });

    it('exports the ProseMirror CSS as a string', () => {
        expect(typeof TIPTAP_WEBVIEW_CSS).toBe('string');
        expect(TIPTAP_WEBVIEW_CSS.length).toBeGreaterThan(0);
    });

    it('replaces upstream hardcoded selection chrome colors with theme CSS variables', () => {
        expect(TIPTAP_WEBVIEW_CSS).not.toContain('#8cf');
        expect(TIPTAP_WEBVIEW_CSS).not.toContain('border-top: 1px solid black;');
        expect(TIPTAP_WEBVIEW_CSS).toContain('var(--happier-tiptap-selection-accent-color)');
        expect(TIPTAP_WEBVIEW_CSS).toContain('var(--happier-tiptap-gap-cursor-color)');
    });
});
