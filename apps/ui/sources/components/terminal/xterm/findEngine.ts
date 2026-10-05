import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import type { FindEngine, TerminalFindSnapshot } from '../embedded/embeddedTerminalRendererHandle';

export type XtermFindColors = Readonly<{ matchAll: string; matchCurrent: string }>;

/** Renderer-local Find; matching and selection belong to the supplied xterm addon. */
export function createXtermFindEngine(term: Terminal, addon: SearchAddon, colors: XtermFindColors): FindEngine & {
    dispose(): void;
    setColors(colors: XtermFindColors): void;
    applyQuery(query: string, options: TerminalFindSnapshot['options']): void;
} {
    let snapshot: TerminalFindSnapshot = { open: false, query: '', options: { regex: false, matchCase: false }, status: { kind: 'idle' }, retainedLines: 0 };
    const listeners = new Set<() => void>();
    const publish = (next: TerminalFindSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
    let disposed = false;
    let truncated = false;
    const retainSelection = (operation: () => void) => {
        const selection = term.getSelectionPosition();
        operation();
        if (selection) {
            const length = (selection.end.y - selection.start.y) * term.cols + selection.end.x - selection.start.x;
            term.select(selection.start.x, selection.start.y, length);
        }
    };
    const decorations = () => ({
        matchBackground: colors.matchAll, matchOverviewRuler: colors.matchAll,
        activeMatchBackground: colors.matchCurrent, activeMatchColorOverviewRuler: colors.matchCurrent,
    });
    const resultSubscription = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (disposed || !snapshot.open || !snapshot.query || snapshot.status.kind === 'invalidPattern') return;
        // This is the addon's 1000-decoration ceiling, not a second Find limit.
        const limited = resultCount >= 1000 || truncated;
        publish({ ...snapshot, retainedLines: term.buffer.active.length,
            status: { kind: 'results', current: resultIndex < 0 ? null : resultIndex + 1,
                total: resultCount, coverage: limited ? 'limited' : term.buffer.active.type === 'alternate' ? 'loaded' : 'complete' } });
    });
    const search = (direction: 1 | -1, refresh = false) => {
        if (disposed || !snapshot.open) return;
        if (!snapshot.query) {
            retainSelection(() => addon.clearDecorations());
            publish({ ...snapshot, status: { kind: 'idle' }, retainedLines: term.buffer.active.length });
            return;
        }
        if (snapshot.options.regex) {
            try { new RegExp(snapshot.query, snapshot.options.matchCase ? '' : 'i'); }
            catch {
                retainSelection(() => addon.clearDecorations());
                publish({ ...snapshot, status: { kind: 'invalidPattern' } });
                return;
            }
        }
        // Clear the addon's cached count after parsed output/clear/resize, preserving its cell selection.
        if (refresh) retainSelection(() => addon.clearDecorations());
        if (snapshot.status.kind === 'invalidPattern') publish({ ...snapshot, status: { kind: 'idle' } });
        const options = { regex: snapshot.options.regex, caseSensitive: snapshot.options.matchCase,
            incremental: refresh, decorations: decorations() };
        if (direction === 1) addon.findNext(snapshot.query, options);
        else addon.findPrevious(snapshot.query, options);
    };
    const refresh = () => {
        if (term.buffer.active.type === 'normal' && term.buffer.active.length >= term.rows + (term.options.scrollback ?? 0)) truncated = true;
        search(1, true);
    };
    const writes = term.onWriteParsed(refresh);
    const resizes = term.onResize(refresh);
    const buffers = term.buffer.onBufferChange(refresh);
    const clear = () => {
        retainSelection(() => addon.clearDecorations());
        publish({ ...snapshot, open: false, status: { kind: 'idle' } });
    };
    return {
        get query() { return snapshot.query; }, get options() { return snapshot.options; }, get status() { return snapshot.status; },
        capabilities: { regex: true, stop: false },
        getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        open: () => { publish({ ...snapshot, open: true }); refresh(); },
        // One guest request must not publish a previous query's counts under its new revision.
        applyQuery: (query, options) => { publish({ ...snapshot, open: true, query, options, status: { kind: 'idle' } }); refresh(); },
        close: clear,
        setQuery: (query) => { publish({ ...snapshot, query }); search(1, true); },
        setOptions: (options) => { publish({ ...snapshot, options }); search(1, true); },
        step: (direction) => search(direction), stop: () => {},
        dispose: () => { disposed = true; writes.dispose(); resizes.dispose(); buffers.dispose(); resultSubscription.dispose(); clear(); listeners.clear(); },
        setColors: (next) => { colors = next; search(1, true); },
    };
}
