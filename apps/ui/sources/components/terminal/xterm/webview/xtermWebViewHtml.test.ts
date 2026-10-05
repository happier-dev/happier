import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { Terminal } from '@xterm/xterm';

describe('buildXtermWebViewHtml', () => {
    it('suppresses real parser DA replies during replay until completion and resumes live input', async () => {
        vi.resetModules();
        vi.doMock('./xtermWebViewAssets.generated', () => ({ XTERM_WEBVIEW_BUNDLE_JS: '', XTERM_WEBVIEW_CSS: '' }));
        const { buildXtermWebViewHtml } = await import('./xtermWebViewHtml');
        const html = buildXtermWebViewHtml({
            theme: { backgroundColor: '#000', textColor: '#fff', cursorColor: '#fff', selectionBackgroundColor: '#222', isDark: true },
            fontSizePx: 14, lineHeightPx: 18, maxChunkBytes: 64_000, allowCdnFallback: false,
        });
        const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
        if (!script) throw new Error('WebView module script missing');
        const messages: Array<{ type: string; payload: unknown }> = [];
        const listeners = new Map<string, (event: { data: string }) => void>();
        const parsed: Array<Promise<void>> = [];
        const completions: Array<() => void> = [];
        let terminal: Terminal | null = null;
        // Only the WebView DOM/layout boundary is replaced; xterm parses every byte.
        class ParserTerminal extends Terminal {
            constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); terminal = this; }
            open() {}
            focus() {}
            write(data: string | Uint8Array, callback?: () => void) {
                parsed.push(new Promise<void>((resolve) => super.write(data, () => {
                    if (callback) completions.push(callback);
                    resolve();
                })));
            }
        }
        const root = { addEventListener: () => {} };
        const sandbox = {
            HAPPIER_XTERM_WEBVIEW: { Terminal: ParserTerminal, FitAddon: class { activate() {} fit() {} dispose() {} } },
            window: {
                ReactNativeWebView: { postMessage: (message: string) => messages.push(JSON.parse(message)) },
                addEventListener: (name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener),
            },
            document: { getElementById: () => root, addEventListener: () => {} },
            TextEncoder, TextDecoder, Uint8Array, atob, btoa,
            setTimeout: () => 1, clearTimeout: () => {},
        };
        runInNewContext(script, sandbox);
        await Promise.resolve();
        await Promise.resolve();
        const send = (data: string, intent?: 'replay') => {
            const listener = listeners.get('message');
            if (!listener) throw new Error('WebView host message listener missing');
            listener({ data: JSON.stringify({ v: 1, type: 'write', payload: { data, intent } }) });
        };
        const activeTerminal = terminal as Terminal | null;
        if (!activeTerminal) throw new Error('WebView terminal not booted');
        try {
            // Both renderer adapters preserve the user's terminal colors without contrast rewriting.
            expect(activeTerminal.options.minimumContrastRatio).toBe(1);
            expect(activeTerminal.options.drawBoldTextInBrightColors).toBe(false);
            expect(activeTerminal.options.fontWeightBold).toBe('bold');
            send('\u001b[c', 'replay');
            await Promise.all(parsed);
            expect(messages.filter((message) => message.type === 'input')).toEqual([]);
            activeTerminal.input('during replay');
            expect(messages.filter((message) => message.type === 'input')).toEqual([]);
            completions.shift()?.();
            activeTerminal.input('after replay');
            expect(messages.filter((message) => message.type === 'input')).toEqual([
                { v: 1, type: 'input', payload: { data: 'after replay' } },
            ]);
            messages.length = 0;
            send('\u001b[c');
            await Promise.all(parsed);
            expect(messages.filter((message) => message.type === 'input')).toEqual([
                { v: 1, type: 'input', payload: { data: expect.stringMatching(/^\u001b\[\?/) } },
            ]);
            completions.shift()?.();
        } finally {
            activeTerminal.dispose();
        }
    });

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

        for (const token of ['ready', 'resize', 'input', 'paste', 'write', 'writeBytes', 'writeComplete', 'clear', 'setTheme', 'setFontSize', 'focus']) {
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

        expect(html).toContain('screenReaderMode: INTERACTION_POLICY.screenReaderMode === true');
        expect(html).toContain('"rendererKind":"xterm-webview"');
        expect(html).toContain("registerOscHandler(52");
        expect(html).toContain("registerDcsHandler({ final: 'q' }");
        expect(html).toContain("type: 'copySelection'");
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

    it('captures real WebView clipboard paste before xterm emits ordinary input', async () => {
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

        expect(html).toContain("root.addEventListener('paste'");
        expect(html).toContain("type: 'paste'");
        expect(html).toContain('event.preventDefault()');
        expect(html).toContain('event.stopPropagation()');
        expect(html).toContain("getData('text/plain')");
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
