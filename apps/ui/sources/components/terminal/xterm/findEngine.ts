import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import type { FindEngine, TerminalFindSnapshot } from '../embedded/embeddedTerminalRendererHandle';

export type XtermFindColors = Readonly<{ matchAll: string; matchCurrent: string }>;

/** Renderer-local Find; matching and selection belong to the supplied xterm addon. */
export function createXtermFindEngine(term: Terminal, addon: SearchAddon, colors: XtermFindColors): FindEngine & {
    dispose(): void;
    setColors(colors: XtermFindColors): void;
    applyQuery(query: string, options: TerminalFindSnapshot['options']): void;
    /** True while the selection is the match a step selected (the addon selects it), not text the user chose. */
    ownsSelection(): boolean;
} {
    let snapshot: TerminalFindSnapshot = { open: false, query: '', options: { regex: false, matchCase: false }, status: { kind: 'idle' }, retainedLines: 0 };
    const listeners = new Set<() => void>();
    const publish = (next: TerminalFindSnapshot) => {
        const options = next.options.regex === snapshot.options.regex && next.options.matchCase === snapshot.options.matchCase
            ? snapshot.options : next.options;
        const sameStatus = next.status === snapshot.status || next.status.kind === snapshot.status.kind && (
            next.status.kind === 'idle' || next.status.kind === 'invalidPattern'
            || next.status.kind === 'results' && snapshot.status.kind === 'results'
                && next.status.current === snapshot.status.current && next.status.total === snapshot.status.total
                && next.status.coverage === snapshot.status.coverage);
        const status = sameStatus ? snapshot.status : next.status;
        if (next.open === snapshot.open && next.query === snapshot.query && options === snapshot.options
            && status === snapshot.status && next.retainedLines === snapshot.retainedLines) return;
        snapshot = { ...next, options, status };
        for (const listener of listeners) listener();
    };
    let disposed = false;
    let truncated = false;
    // The addon marks a match by selecting it; that selection is Find's until the user selects something else.
    let stepping = false;
    let stepSelection: string | null = null;
    // The addon also searches from its write/resize callback. Scope ownership at those public methods
    // so selection listeners see the correct owner before onDidChangeResults fires.
    const findNext = addon.findNext;
    const findPrevious = addon.findPrevious;
    const withSelectionOwnership = (search: SearchAddon['findNext']): SearchAddon['findNext'] => (...args) => {
        const wasStepping = stepping;
        stepping = true;
        try { return search.apply(addon, args); }
        finally {
            // xterm can omit the select event when a cleared match is selected at the same cells.
            stepSelection = selectionKey();
            stepping = wasStepping;
        }
    };
    addon.findNext = withSelectionOwnership(findNext);
    addon.findPrevious = withSelectionOwnership(findPrevious);
    const selectionKey = () => {
        const position = term.getSelectionPosition();
        return position ? `${position.start.x},${position.start.y},${position.end.x},${position.end.y}` : null;
    };
    const selections = term.onSelectionChange(() => {
        const selected = selectionKey();
        if (stepping) stepSelection = selected;
        else if (selected !== stepSelection) stepSelection = null;
    });
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
    // This is the addon's 1000-decoration ceiling, not a second Find limit.
    const coverage = (total: number) => total >= 1000 || truncated ? 'limited'
        : term.buffer.active.type === 'alternate' ? 'loaded' : 'complete';
    const resultSubscription = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (disposed || !snapshot.open || !snapshot.query || snapshot.status.kind === 'invalidPattern') return;
        publish({ ...snapshot, retainedLines: term.buffer.active.length,
            status: { kind: 'results', current: resultIndex < 0 ? null : resultIndex + 1,
                total: resultCount, coverage: coverage(resultCount) } });
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
        // Explicit query/options/buffer refreshes invalidate the addon's cached count, retaining its cell selection.
        if (refresh) retainSelection(() => addon.clearDecorations());
        if (snapshot.status.kind === 'invalidPattern') publish({ ...snapshot, status: { kind: 'idle' } });
        const options = { regex: snapshot.options.regex, caseSensitive: snapshot.options.matchCase,
            incremental: refresh, decorations: decorations() };
        if (direction === 1) addon.findNext(snapshot.query, options);
        else addon.findPrevious(snapshot.query, options);
    };
    const updateBufferFacts = () => {
        if (term.buffer.active.type === 'normal' && term.buffer.active.length >= term.rows + (term.options.scrollback ?? 0)) truncated = true;
        if (disposed || !snapshot.open) return;
        const status: TerminalFindSnapshot['status'] = snapshot.status.kind === 'results' ? { ...snapshot.status,
            coverage: coverage(snapshot.status.total) } : snapshot.status;
        publish({ ...snapshot, status, retainedLines: term.buffer.active.length });
    };
    const refresh = () => {
        updateBufferFacts();
        search(1, true);
    };
    // SearchAddon owns write/resize matching (including its refresh cadence); the host adds only coverage facts.
    const writes = term.onWriteParsed(updateBufferFacts);
    const resizes = term.onResize(updateBufferFacts);
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
        ownsSelection: () => stepping || (stepSelection !== null && selectionKey() === stepSelection),
        dispose: () => {
            disposed = true;
            addon.findNext = findNext; addon.findPrevious = findPrevious;
            writes.dispose(); resizes.dispose(); buffers.dispose(); selections.dispose(); resultSubscription.dispose(); clear(); listeners.clear();
        },
        setColors: (next) => { colors = next; search(1, true); },
    };
}
