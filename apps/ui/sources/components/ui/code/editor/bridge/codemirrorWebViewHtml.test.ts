import { describe, expect, it, vi } from 'vitest';

describe('buildCodeMirrorWebViewHtml', () => {
    it('scales editor font metrics via uiFontScale', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');

        const html = buildCodeMirrorWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                dividerColor: '#333',
                isDark: true,
            },
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 2,
            osFontScale: 1,
        } as any);

        expect(html).toContain('font-size: 26px;');
        expect(html).toContain('line-height: 40px;');
    });

    it('embeds the CodeMirror bundle when available and avoids CDN imports', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* bundled-cm6 */ globalThis.__CM6__ = 1;',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');
        const html = buildCodeMirrorWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                dividerColor: '#333',
                isDark: true,
            },
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        } as any);

        expect(html).toContain('/* bundled-cm6 */');
        expect(html).not.toContain('cdn.jsdelivr.net');
    });

    it('falls back to CDN imports when the bundle is not available', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');
        const html = buildCodeMirrorWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                dividerColor: '#333',
                isDark: true,
            },
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        } as any);

        expect(html).toContain('cdn.jsdelivr.net');
    });
});
