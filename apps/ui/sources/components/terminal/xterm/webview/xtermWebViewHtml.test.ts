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

        for (const token of ['ready', 'resize', 'input', 'write', 'writeBytes', 'writeComplete', 'clear', 'setTheme', 'setFontSize', 'focus']) {
            expect(html).toContain(token);
        }
    });

    it('enables xterm screen reader DOM mode inside the native WebView baseline', async () => {
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

        expect(html).toContain('screenReaderMode: true');
    });

    it('focuses the xterm input from native WebView user gestures', async () => {
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

        expect(html).toContain('function focusTerminal()');
        expect(html).toContain("root.addEventListener('pointerdown', focusTerminal");
        expect(html).toContain("root.addEventListener('touchstart', focusTerminal");
        expect(html).toContain("root.addEventListener('mousedown', focusTerminal");
        expect(html).toContain('focusTerminal();');
    });

    it('decodes base64 byte writes before passing Uint8Array chunks into xterm', async () => {
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

        expect(html).toContain('enqueueWriteBytes');
        expect(html).toContain('dataBase64');
        expect(html).toContain('base64ToBytes');
        expect(html).toContain('term.write(chunk.bytes');
    });

    it('suppresses stale xterm renderer timer errors after WebView teardown', async () => {
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

        expect(html).toContain('isBenignDisposedXtermRenderError');
        expect(html).toContain("Cannot read properties of undefined (reading 'dimensions')");
        expect(html).toContain('event.preventDefault()');
    });

    it('retries the initial ready fit while the WebView root is still laying out', async () => {
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

        expect(html).toContain('READY_FIT_RETRY_LIMIT');
        expect(html).toContain('scheduleReadyFitAttempt');
        expect(html).toContain("fitAndReport('ready')");
    });

    it('debounces resize-triggered xterm fitting during native keyboard animations', async () => {
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

        expect(html).toContain('RESIZE_FIT_DEBOUNCE_MS');
        expect(html).toContain('scheduleFitAndReport');
        expect(html).toContain("scheduleFitAndReport(didSendReady ? 'resize' : 'ready')");
        expect(html).not.toContain('new ResizeObserver(() => fitAndReport');
    });

    it('routes xterm web links to the host instead of using the addon default opener', async () => {
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

        expect(html).toContain('new mod.WebLinksAddon((event, uri)');
        expect(html).toContain("type: 'link'");
        expect(html).not.toContain('term.loadAddon(new mod.WebLinksAddon())');
    });
});
