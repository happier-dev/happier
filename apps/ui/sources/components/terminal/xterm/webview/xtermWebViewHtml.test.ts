import { describe, expect, it, vi } from 'vitest';

describe('buildXtermWebViewHtml', () => {
    it('embeds the Xterm bundle when available and avoids CDN imports', async () => {
        vi.resetModules();
        vi.doMock('./xtermWebViewAssets.generated', () => ({
            XTERM_WEBVIEW_BUNDLE_JS: '/* bundled-xterm */ globalThis.__XTERM__ = 1;',
            XTERM_WEBVIEW_CSS: '/* xterm-css */',
        }));

        const { buildXtermWebViewHtml } = await import('./xtermWebViewHtml');

        const html = buildXtermWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                cursorColor: '#fff',
                selectionBackgroundColor: '#222',
                isDark: true,
            },
            fontSizePx: 14,
            lineHeightPx: 18,
            maxChunkBytes: 64_000,
            allowCdnFallback: true,
        });

        expect(html).toContain('bundled-xterm');
        expect(html).toContain('xterm-css');
        expect(html).not.toContain('cdn.jsdelivr.net');
    });

    it('falls back to CDN imports when the bundle is not available and allowCdnFallback=true', async () => {
        vi.resetModules();
        vi.doMock('./xtermWebViewAssets.generated', () => ({
            XTERM_WEBVIEW_BUNDLE_JS: '',
            XTERM_WEBVIEW_CSS: '',
        }));

        const { buildXtermWebViewHtml } = await import('./xtermWebViewHtml');

        const html = buildXtermWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                cursorColor: '#fff',
                selectionBackgroundColor: '#222',
                isDark: true,
            },
            fontSizePx: 14,
            lineHeightPx: 18,
            maxChunkBytes: 64_000,
            allowCdnFallback: true,
        });

        expect(html).toContain('cdn.jsdelivr.net');
    });

    it('includes the message protocol surface', async () => {
        vi.resetModules();
        vi.doMock('./xtermWebViewAssets.generated', () => ({
            XTERM_WEBVIEW_BUNDLE_JS: '/* bundled-xterm */',
            XTERM_WEBVIEW_CSS: '',
        }));

        const { buildXtermWebViewHtml } = await import('./xtermWebViewHtml');

        const html = buildXtermWebViewHtml({
            theme: {
                backgroundColor: '#000',
                textColor: '#fff',
                cursorColor: '#fff',
                selectionBackgroundColor: '#222',
                isDark: true,
            },
            fontSizePx: 14,
            lineHeightPx: 18,
            maxChunkBytes: 64_000,
            allowCdnFallback: false,
        });

        for (const token of ['ready', 'resize', 'input', 'write', 'clear', 'setTheme', 'setFontSize', 'focus']) {
            expect(html).toContain(token);
        }
    });
});

