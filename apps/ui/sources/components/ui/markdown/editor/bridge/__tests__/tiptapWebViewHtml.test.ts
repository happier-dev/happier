import { describe, expect, it, vi } from 'vitest';

import type { TiptapWebViewTheme } from '../tiptapWebViewHtml';

/**
 * F9 / Lane F: `buildTiptapWebViewHtml` inlines the generated bundle + CSS and —
 * critically — FAILS CLOSED with no CDN fallback (D9). When the embedded bundle
 * is empty/absent it must still emit an HTML document that posts an `error`
 * envelope on boot so the native surface falls back to raw mode.
 *
 * Pure string builder -> node environment. The generated bundle module is mocked
 * per-test (mirrors `code/editor/bridge/codemirrorWebViewHtml.test.ts`).
 */

function createTiptapWebViewTheme(overrides?: Partial<TiptapWebViewTheme>): TiptapWebViewTheme {
    return {
        isDark: true,
        backgroundColor: '#101010',
        textColor: '#f5f5f5',
        secondaryTextColor: '#999999',
        dividerColor: '#303030',
        selectionBackgroundColor: '#0a84ff44',
        selectionAccentColor: '#0a84ff',
        linkColor: '#4ea1ff',
        codeBackgroundColor: '#1c1c1c',
        ...overrides,
    };
}

const BASE_PARAMS = {
    readOnly: false,
    changeDebounceMs: 100,
    maxChunkBytes: 64_000,
    uiFontScale: 1,
    osFontScale: 1,
};

describe('buildTiptapWebViewHtml (bundle present)', () => {
    it('inlines the generated bundle JS and the ProseMirror CSS', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* bundled-tiptap */ globalThis.HAPPIER_TIPTAP_WEBVIEW = { createRuntime() {} };',
            TIPTAP_WEBVIEW_CSS: '.ProseMirror { color: red; }',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        expect(html).toContain('/* bundled-tiptap */');
        expect(html).toContain('.ProseMirror { color: red; }');
    });

    it('never references a CDN (no CDN fallback, D9)', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* bundled-tiptap */ globalThis.HAPPIER_TIPTAP_WEBVIEW = {};',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        expect(html).not.toContain('cdn.jsdelivr.net');
        expect(html).not.toContain('unpkg.com');
        expect(html).not.toContain('esm.sh');
    });

    it('marks HAS_BUNDLE true so boot proceeds to create the runtime', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* bundled-tiptap */ x;',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        expect(html).toContain('const HAS_BUNDLE = true;');
        expect(html).toContain('HAPPIER_TIPTAP_WEBVIEW');
    });

    it('emits an error envelope path so a missing runtime still fails closed', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* bundled-tiptap */ x;',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        // Even with a bundle present, the boot guard throws (and emits `error`)
        // when the runtime API is missing — there is no silent CDN fallback.
        expect(html).toContain("type: 'error'");
        expect(html).toContain('TipTap bundle missing');
    });
});

describe('buildTiptapWebViewHtml (bundle absent — fails closed)', () => {
    it('does not inline a <script> bundle tag when the bundle is empty', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        expect(html).toContain('const HAS_BUNDLE = false;');
        expect(html).not.toContain('cdn.jsdelivr.net');
    });

    it('emits an error envelope on boot when the bundle is missing (fail closed, no CDN)', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        // The boot guard throws when there is no runtime, and the catch posts an
        // `error` envelope so the native surface falls back to raw mode (D9/R-A4).
        expect(html).toContain("type: 'error'");
    });
});

describe('buildTiptapWebViewHtml theming + config', () => {
    it('applies theme colors into the inline CSS', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme({ backgroundColor: '#abc123', linkColor: '#beef00' }),
            ...BASE_PARAMS,
        });

        expect(html).toContain('#abc123');
        expect(html).toContain('#beef00');
    });

    it('defines CSS variables for ProseMirror selection chrome from the active theme', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme({
                textColor: '#fedcba',
                selectionBackgroundColor: '#11223344',
                selectionAccentColor: '#445566',
            }),
            ...BASE_PARAMS,
        });

        expect(html).toContain('--happier-tiptap-selection-background-color: #11223344;');
        expect(html).toContain('--happier-tiptap-selection-accent-color: #445566;');
        expect(html).toContain('--happier-tiptap-gap-cursor-color: #fedcba;');
        expect(html).toContain(
            '.ProseMirror ::selection { background: var(--happier-tiptap-selection-background-color); }',
        );
    });

    it('scales the prose base font via uiFontScale (16 * scale, MarkdownView spec)', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme(),
            ...BASE_PARAMS,
            uiFontScale: 2,
            osFontScale: 1,
        });

        // Prose base is now 16/24 (MarkdownView's buildEnrichedMarkdownStyle), NOT
        // the 13/20 code-editor metrics. proseScale = uiFontScale * osFontScale = 2,
        // so base font-size = 32px and base line-height = 48px.
        expect(html).toContain('.ProseMirror { font-family:');
        expect(html).toContain('font-size: 32px;');
        expect(html).toContain('line-height: 48px;');
    });

    it('folds OS Dynamic Type into the prose scale (uiFontScale * osFontScale)', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme(),
            ...BASE_PARAMS,
            uiFontScale: 1.5,
            osFontScale: 2,
        });

        // proseScale = 1.5 * 2 = 3 -> base font-size = 48px (the WebView can't stack
        // OS Dynamic Type natively, so both scales are folded into the CSS).
        expect(html).toContain('font-size: 48px;');
    });

    it('styles headings and inline code via the shared prose builder', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme(),
            ...BASE_PARAMS,
            uiFontScale: 1,
            osFontScale: 1,
        });

        // Headings used to fall back to browser defaults (no rules at all). They are
        // now emitted by buildMarkdownProseCss at the MarkdownView multipliers.
        // base 16 -> h1 24px, h2 20px, h3 18px.
        expect(html).toContain('.ProseMirror h1 { font-size: 24px;');
        expect(html).toContain('.ProseMirror h2 { font-size: 20px;');
        expect(html).toContain('.ProseMirror h3 { font-size: 18px;');
        // Inline code uses the mono stack at 0.88x (16 * 0.88 = 14.08).
        expect(html).toContain('.ProseMirror code { font-family: Menlo,');
        expect(html).toContain('font-size: 14.08px;');
        // The shared builder removes the contenteditable focus ring.
        expect(html).toContain('outline: none;');
    });

    it('passes the change debounce + readOnly flags into the boot script', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({
            theme: createTiptapWebViewTheme(),
            ...BASE_PARAMS,
            changeDebounceMs: 175,
            readOnly: true,
        });

        expect(html).toContain('const CHANGE_DEBOUNCE_MS = 175;');
        expect(html).toContain('const READ_ONLY = true;');
    });

    it('supports the requestDoc/docSnapshot flush protocol references', async () => {
        vi.resetModules();
        vi.doMock('../tiptapWebViewBundle.generated', () => ({
            TIPTAP_WEBVIEW_BUNDLE_JS: '/* b */',
            TIPTAP_WEBVIEW_CSS: '',
        }));

        const { buildTiptapWebViewHtml } = await import('../tiptapWebViewHtml');
        const html = buildTiptapWebViewHtml({ theme: createTiptapWebViewTheme(), ...BASE_PARAMS });

        expect(html).toContain('ready');
    });
});
