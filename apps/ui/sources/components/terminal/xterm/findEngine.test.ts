/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { runInNewContext } from 'node:vm';
import { createXtermFindEngine } from './findEngine';
import { buildXtermWebViewHtml } from './webview/xtermWebViewHtml';
vi.mock('./webview/xtermWebViewAssets.generated', () => ({ XTERM_WEBVIEW_BUNDLE_JS: '', XTERM_WEBVIEW_CSS: '' }));

const disposals: Array<() => void> = [];
// jsdom has no canvas or media-query platform; matching, buffers and selection stay real.
beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
});
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
async function fixture(text: string, scrollback = 5000) {
    const term = new Terminal({ cols: 80, rows: 24, scrollback, allowProposedApi: true });
    const element = document.createElement('div'); document.body.append(element); term.open(element);
    const addon = new SearchAddon(); term.loadAddon(addon);
    const find = createXtermFindEngine(term, addon, { matchAll: '#f5c778', matchCurrent: '#9f5810' });
    disposals.push(() => { find.dispose(); term.dispose(); element.remove(); });
    await new Promise<void>((resolve) => term.write(text, resolve));
    find.open();
    return { term, find };
}
describe('xterm engine Find', () => {
    it('executes the shared engine inside the actual guest bridge and keeps consumed keys out of terminal input', async () => {
        const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
        const terminals: Terminal[] = [];
        class GuestTerminal extends Terminal {
            constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); terminals.push(this); }
        }
        const messages: Array<{ type: string; payload: unknown }> = [];
        const listeners = new Map<string, (event: { data: string }) => void>();
        const html = buildXtermWebViewHtml({ theme: { backgroundColor: '#000', textColor: '#fff', cursorColor: '#fff', selectionBackgroundColor: '#333', isDark: true,
            findColors: { matchAll: '#f5c778', matchCurrent: '#9f5810' } }, fontSizePx: 14, lineHeightPx: 18, maxChunkBytes: 64000, allowCdnFallback: false });
        const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
        if (!script) throw new Error('guest script missing');
        runInNewContext(script, {
            HAPPIER_XTERM_WEBVIEW: { Terminal: GuestTerminal, SearchAddon, FitAddon: class { activate() {} fit() {} dispose() {} } },
            document, window: { ReactNativeWebView: { postMessage: (message: string) => messages.push(JSON.parse(message)) }, addEventListener: (name: string, listener: (event: { data: string }) => void) => listeners.set(name, listener) },
            TextEncoder, TextDecoder, Uint8Array, atob, btoa, setTimeout, clearTimeout,
        });
        await Promise.resolve(); await Promise.resolve();
        const term = terminals[0]; if (!term) throw new Error('guest terminal missing');
        disposals.push(() => { term.dispose(); root.remove(); });
        await new Promise<void>((resolve) => term.write('guest guest', resolve));
        const send = (type: string, payload: unknown) => listeners.get('message')?.({ data: JSON.stringify({ v: 1, type, payload }) });
        send('find.set', { revision: 1, query: 'guest', options: { regex: false, matchCase: false } });
        expect(messages.filter((message) => message.type === 'find.results').at(-1)?.payload).toMatchObject({ revision: 1, status: { kind: 'results', total: 2 } });
        messages.length = 0;
        send('find.set', { revision: 2, query: 'absent', options: { regex: false, matchCase: false } });
        const replacementResults = messages.filter((message) => message.type === 'find.results')
            .map((message) => message.payload).filter((payload): payload is { revision: number; status: { kind: 'results'; total: number } } =>
                typeof payload === 'object' && payload !== null && 'revision' in payload && typeof payload.revision === 'number' && 'status' in payload
                && typeof payload.status === 'object' && payload.status !== null && 'kind' in payload.status && payload.status.kind === 'results'
                && 'total' in payload.status && typeof payload.status.total === 'number');
        expect(replacementResults.length).toBeGreaterThan(0);
        expect(replacementResults.every((payload) => payload.revision === 2 && payload.status.total === 0)).toBe(true);
        send('find.keybindings', { signatures: ['f|shift=false|ctrl=true|meta=false|alt=false'] });
        messages.length = 0;
        term.textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(messages.filter((message) => message.type === 'find.key')).toHaveLength(1);
        expect(messages.filter((message) => message.type === 'input')).toHaveLength(0);
        term.textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', keyCode: 71, ctrlKey: true, bubbles: true, cancelable: true }));
        expect(messages.filter((message) => message.type === 'input').at(-1)?.payload).toEqual({ data: '\x07' });
    });
    it('searches rendered cells, preserves literal backslashes and current selection on close', async () => {
        const { term, find } = await fixture('discard\r\x1b[2Kkept \\path kept\r\n界 kept');
        find.setQuery('discard'); expect(find.status).toMatchObject({ kind: 'results', total: 0 });
        find.setQuery('kept'); expect(find.status).toMatchObject({ kind: 'results', total: 3 });
        find.setQuery('KEPT'); expect(find.status).toMatchObject({ kind: 'results', total: 3 });
        find.setOptions({ regex: false, matchCase: true }); expect(find.status).toMatchObject({ kind: 'results', total: 0 });
        find.setOptions({ regex: false, matchCase: false }); find.setQuery('kept');
        find.step(1); expect(term.getSelection()).toBe('kept');
        const selected = term.getSelectionPosition(); find.close();
        expect(term.getSelectionPosition()).toEqual(selected);
        find.open(); find.setQuery('\\path'); expect(find.status).toMatchObject({ kind: 'results', total: 1 });
    });
    it('reports addon decoration bounds and exhausted scrollback as limited', async () => {
        const { find } = await fixture('hit '.repeat(1001));
        find.setQuery('hit'); expect(find.status).toMatchObject({ kind: 'results', coverage: 'limited' });
        const trimmed = await fixture('old\r\n'.repeat(50), 1);
        trimmed.find.setQuery('absent'); expect(trimmed.find.status).toMatchObject({ kind: 'results', coverage: 'limited', total: 0 });
    });
    it('refreshes appended/erased/alternate-buffer results and retires invalid regex and closed work', async () => {
        const { term, find } = await fixture('match'); find.setQuery('match');
        await new Promise<void>((resolve) => term.write('\r\nmatch', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        term.resize(40, 24); expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        await new Promise<void>((resolve) => term.write('\x1b[?1049hother', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 0, coverage: 'loaded' });
        await new Promise<void>((resolve) => term.write('\x1b[?1049l', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        term.clear(); await new Promise<void>((resolve) => term.write('\x1b[2J\x1b[H', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 0 });
        find.setOptions({ regex: true, matchCase: false }); find.setQuery('[');
        expect(find.status).toEqual({ kind: 'invalidPattern' });
        find.close(); await new Promise<void>((resolve) => term.write('match', resolve));
        expect(find.status).toEqual({ kind: 'idle' });
    });
});
