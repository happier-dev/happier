/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { runInNewContext } from 'node:vm';
import { createXtermFindEngine } from './findEngine';
import { createWebViewFindEngine, type XtermFindRequest } from './webview/findBridge';
import { buildXtermWebViewHtml } from './webview/xtermWebViewHtml';
vi.mock('./webview/xtermWebViewAssets.generated', () => ({ XTERM_WEBVIEW_BUNDLE_JS: '', XTERM_WEBVIEW_CSS: '' }));

const disposals: Array<() => void> = [];
// jsdom has no canvas or media-query platform; matching, buffers and selection stay real.
beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
});
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); });
async function fixture(text: string, scrollback = 5000) {
    const term = new Terminal({ cols: 80, rows: 24, scrollback, allowProposedApi: true });
    const element = document.createElement('div'); document.body.append(element); term.open(element);
    const addon = new SearchAddon(); term.loadAddon(addon);
    const find = createXtermFindEngine(term, addon, { matchAll: '#f5c778', matchCurrent: '#9f5810' });
    disposals.push(() => { find.dispose(); term.dispose(); element.remove(); });
    await new Promise<void>((resolve) => term.write(text, resolve));
    find.open();
    return { term, find, addon };
}
describe('xterm engine Find', () => {
    it('does no addon search for an already-open equal query/options request and still searches a changed query', async () => {
        const { find, addon } = await fixture('hit hit');
        find.setQuery('hit');
        const search = vi.spyOn(addon, 'findNext'); // Count real matching work; keep the addon implementation.
        for (let i = 0; i < 10; i++) {
            find.open();
            find.setOptions({ regex: false, matchCase: false });
            find.setQuery('hit');
        }
        expect(search).not.toHaveBeenCalled();
        expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        find.setQuery('absent');
        expect(search).toHaveBeenCalledTimes(1);
        expect(find.status).toMatchObject({ kind: 'results', total: 0 });
    });

    it('sends no find.set for an already-open equal WebView query/options request, preserving the current result', () => {
        const requests: XtermFindRequest[] = [];
        const bridge = createWebViewFindEngine(request => requests.push(request));
        bridge.engine.open();
        bridge.engine.setQuery('hit');
        const revision = requests.at(-1)!.payload.revision;
        bridge.accept({ revision, retainedLines: 24, status: { kind: 'results', total: 2, current: 1, coverage: 'complete' } });
        const matched = bridge.engine.getSnapshot();
        requests.length = 0;
        for (let i = 0; i < 10; i++) {
            bridge.engine.open();
            bridge.engine.setOptions({ regex: false, matchCase: false });
            bridge.engine.setQuery('hit');
        }
        expect(requests).toHaveLength(0);
        expect(bridge.engine.getSnapshot()).toBe(matched);
        bridge.engine.setQuery('changed');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ type: 'find.set', payload: { query: 'changed' } });
        bridge.accept({ revision, retainedLines: 24, status: { kind: 'results', total: 99, current: 1, coverage: 'complete' } });
        expect(bridge.engine.status).toEqual({ kind: 'idle' });
    });

    it('publishes only changed WebView result facts and retains equal nested values', () => {
        const requests: XtermFindRequest[] = [];
        const bridge = createWebViewFindEngine(request => requests.push(request));
        bridge.engine.open();
        bridge.engine.setQuery('hit');
        const revision = requests.at(-1)!.payload.revision;
        const reply = { revision, retainedLines: 24, status: { kind: 'results', total: 2, current: 1, coverage: 'complete' } };
        bridge.accept(reply);
        const matched = bridge.engine.getSnapshot();
        const publications = vi.fn();
        const unsubscribe = bridge.engine.subscribe(publications);
        for (let i = 0; i < 10; i++) bridge.accept({ ...reply, status: { ...reply.status } });
        expect(publications).not.toHaveBeenCalled();
        expect(bridge.engine.getSnapshot()).toBe(matched);
        bridge.accept({ ...reply, status: { ...reply.status, total: 3 } });
        expect(publications).toHaveBeenCalledTimes(1);
        expect(bridge.engine.status).toMatchObject({ kind: 'results', total: 3 });
        const changed = bridge.engine.getSnapshot();
        bridge.accept({ ...reply, retainedLines: 25, status: { ...reply.status, total: 3 } });
        expect(publications).toHaveBeenCalledTimes(2);
        expect(bridge.engine.getSnapshot().status).toBe(changed.status);
        expect(bridge.engine.getSnapshot().options).toBe(matched.options);
        unsubscribe();
    });

    it('publishes only changed snapshot facts across parsed output and addon refreshes', async () => {
        const { term, find } = await fixture('hit');
        find.setQuery('hit');
        vi.useFakeTimers();
        const snapshots: ReturnType<typeof find.getSnapshot>[] = [];
        const unsubscribe = find.subscribe(() => snapshots.push(find.getSnapshot()));
        disposals.push(unsubscribe);
        const writeAndRefresh = async (text: string) => {
            const parsed = new Promise<void>((resolve) => term.write(text, resolve));
            await vi.advanceTimersByTimeAsync(0);
            await parsed;
            // Exercise the installed SearchAddon's own 200ms write/resize refresh too.
            await vi.advanceTimersByTimeAsync(200);
        };
        const initial = find.getSnapshot();
        for (let i = 0; i < 10; i++) await writeAndRefresh(' x');
        expect(snapshots).toHaveLength(0);
        expect(find.getSnapshot()).toBe(initial);
        await writeAndRefresh(' hit');
        expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        expect(snapshots).toHaveLength(1);
        snapshots.length = 0;
        const matched = find.getSnapshot();
        term.resize(81, 24);
        await vi.advanceTimersByTimeAsync(200);
        expect(find.getSnapshot()).toBe(matched);
        expect(snapshots).toHaveLength(0);
        term.resize(81, 25);
        await vi.advanceTimersByTimeAsync(200);
        expect(find.getSnapshot().retainedLines).toBe(25);
        expect(find.getSnapshot().status).toBe(matched.status);
        expect(find.getSnapshot().options).toBe(matched.options);
        expect(snapshots).toHaveLength(1);
    });
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
        const selected = term.getSelectionPosition();
        term.resize(81, 24);
        expect(term.getSelectionPosition()).toEqual(selected);
        find.close();
        expect(term.getSelectionPosition()).toEqual(selected);
        find.open(); find.setQuery('\\path'); expect(find.status).toMatchObject({ kind: 'results', total: 1 });
    });
    it('marks the selection a match step makes as its own, so it never reads as the user selecting text', async () => {
        const { term, find } = await fixture('tide kept\r\nslack tide');
        const seenDuringStep: boolean[] = [];
        const subscription = term.onSelectionChange(() => seenDuringStep.push(find.ownsSelection()));
        find.setQuery('tide'); find.step(1);
        subscription.dispose();
        expect(term.getSelection()).toBe('tide');
        // Selection listeners (the Ask · Copy toolbar) hear the step while it runs and after it.
        expect(seenDuringStep.length).toBeGreaterThan(0);
        expect(seenDuringStep.every(Boolean)).toBe(true);
        expect(find.ownsSelection()).toBe(true);
        find.close();
        expect(find.ownsSelection()).toBe(true);
        const selected = term.getSelectionPosition();
        if (!selected) throw new Error('Find match selection missing');
        term.clearSelection();
        expect(find.ownsSelection()).toBe(false);
        const length = (selected.end.y - selected.start.y) * term.cols + selected.end.x - selected.start.x;
        term.select(selected.start.x, selected.start.y, length);
        expect(term.getSelection()).toBe('tide');
        expect(find.ownsSelection()).toBe(false);
        find.close();
        expect(term.getSelection()).toBe('tide');
        expect(find.ownsSelection()).toBe(false);
        // A selection the user makes afterwards is theirs.
        term.select(0, 1, 5);
        expect(find.ownsSelection()).toBe(false);
    });
    it('owns the match selection during the delayed output refresh', async () => {
        const { term, find } = await fixture('tide tide');
        find.setQuery('tide'); find.step(1);
        expect(find.ownsSelection()).toBe(true);
        vi.useFakeTimers();
        const ownershipDuringRefresh: boolean[] = [];
        const subscription = term.onSelectionChange(() => ownershipDuringRefresh.push(find.ownsSelection()));
        disposals.push(() => subscription.dispose());
        const parsed = new Promise<void>((resolve) => term.write(' tide', resolve));
        await vi.advanceTimersByTimeAsync(0);
        await parsed;
        await vi.advanceTimersByTimeAsync(200);
        expect(find.status).toMatchObject({ kind: 'results', total: 3 });
        expect(term.getSelection()).toBe('tide');
        expect(find.ownsSelection()).toBe(true);
        expect(ownershipDuringRefresh.length).toBeGreaterThan(0);
        expect(ownershipDuringRefresh.every(Boolean)).toBe(true);
        term.clearSelection();
        expect(find.ownsSelection()).toBe(false);
        term.select(5, 0, 4);
        expect(find.ownsSelection()).toBe(false);
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
        await vi.waitFor(() => expect(find.status).toMatchObject({ kind: 'results', total: 2 }));
        term.resize(40, 24); expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        await new Promise<void>((resolve) => term.write('\x1b[?1049hother', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 0, coverage: 'loaded' });
        await new Promise<void>((resolve) => term.write('\x1b[?1049l', resolve));
        expect(find.status).toMatchObject({ kind: 'results', total: 2 });
        term.clear(); await new Promise<void>((resolve) => term.write('\x1b[2J\x1b[H', resolve));
        await vi.waitFor(() => expect(find.status).toMatchObject({ kind: 'results', total: 0 }));
        find.setOptions({ regex: true, matchCase: false }); find.setQuery('[');
        expect(find.status).toEqual({ kind: 'invalidPattern' });
        find.close(); await new Promise<void>((resolve) => term.write('match', resolve));
        expect(find.status).toEqual({ kind: 'idle' });
    });
});
