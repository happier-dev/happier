import { describe, expect, it, vi } from 'vitest';
import type { CodeMirrorWebViewTheme } from './codemirrorWebViewHtml';

type CodeMirrorWebViewThemeOverrides = Omit<Partial<CodeMirrorWebViewTheme>, 'syntax'> & {
    syntax?: Partial<CodeMirrorWebViewTheme['syntax']>;
};

function createCodeMirrorWebViewTheme(
    overrides?: CodeMirrorWebViewThemeOverrides,
): CodeMirrorWebViewTheme {
    const { syntax: syntaxOverrides, ...rootOverrides } = overrides ?? {};
    return {
        backgroundColor: '#000',
        textColor: '#fff',
        dividerColor: '#333',
        lineNumberColor: '#777',
        activeLineColor: '#111',
        selectionColor: '#0a84ff44',
        isDark: true,
        ...rootOverrides,
        syntax: {
            defaultColor: syntaxOverrides?.defaultColor ?? '#fff',
            keywordColor: syntaxOverrides?.keywordColor ?? '#5ac8fa',
            stringColor: syntaxOverrides?.stringColor ?? '#32d74b',
            commentColor: syntaxOverrides?.commentColor ?? '#8e8e93',
            numberColor: syntaxOverrides?.numberColor ?? '#bf5af2',
            functionColor: syntaxOverrides?.functionColor ?? '#ffd60a',
        },
    };
}

describe('buildCodeMirrorWebViewHtml', () => {
    it('scales editor font metrics via uiFontScale', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');

        const html = buildCodeMirrorWebViewHtml({
            theme: createCodeMirrorWebViewTheme(),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 2,
            osFontScale: 1,
        });

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
            theme: createCodeMirrorWebViewTheme(),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        });

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
            theme: createCodeMirrorWebViewTheme(),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        });

        expect(html).toContain('cdn.jsdelivr.net');
    });

    it('uses CodeMirror 6 history from commands instead of legacy @codemirror/history', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');
        const html = buildCodeMirrorWebViewHtml({
            theme: createCodeMirrorWebViewTheme(),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        });

        expect(html).not.toContain('@codemirror/history');
        expect(html).toContain('{ defaultKeymap, history, historyKeymap }');
    });

    it('builds a CodeMirror theme from app editor colors and syntax tokens', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');
        const html = buildCodeMirrorWebViewHtml({
            theme: createCodeMirrorWebViewTheme({
                backgroundColor: '#101010',
                textColor: '#f8f8f2',
                dividerColor: '#303030',
                lineNumberColor: '#8a8a8a',
                activeLineColor: '#1f1f1f',
                selectionColor: '#58a6ff',
                syntax: {
                    defaultColor: '#f8f8f2',
                    keywordColor: '#ff79c6',
                    stringColor: '#50fa7b',
                    commentColor: '#6272a4',
                    numberColor: '#bd93f9',
                    functionColor: '#8be9fd',
                },
                isDark: true,
            }),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        });

        expect(html).toContain('color: theme.lineNumberColor');
        expect(html).toContain('backgroundColor: theme.activeLineColor');
        expect(html).toContain('HighlightStyle.define');
        expect(html).toContain('tags.keyword');
        expect(html).toContain('color: syntax.keywordColor');
        expect(html).toContain('color: syntax.stringColor');
        expect(html).toContain('color: syntax.commentColor');
    });

    it('supports requestDoc/docSnapshot messages for reliable host-side flush', async () => {
        vi.resetModules();
        vi.doMock('./codemirrorWebViewBundle.generated', () => ({
            CODEMIRROR_WEBVIEW_BUNDLE_JS: '',
        }));

        const { buildCodeMirrorWebViewHtml } = await import('./codemirrorWebViewHtml');
        const html = buildCodeMirrorWebViewHtml({
            theme: createCodeMirrorWebViewTheme(),
            wrapLines: true,
            showLineNumbers: true,
            changeDebounceMs: 100,
            maxChunkBytes: 64_000,
            uiFontScale: 1,
            osFontScale: 1,
        });

        expect(html).toContain('requestDoc');
        expect(html).toContain('docSnapshot');
    });
});
