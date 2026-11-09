import { describe, expect, it, vi } from 'vitest';
import type { CodeIntelligenceFallbackInput, CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult, LanguageIntelligenceSyncInput, LanguageIntelligenceSyncResult, LanguageIntelligenceWatchInput, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { createCodeIntelligenceController } from './createCodeIntelligenceController';
import { selectDocumentOutline } from './documentOutline';
import { bindCodeDiagnosticDecorations, selectCodeDiagnostics } from './codeDiagnostics';

const result: Extract<CodeIntelligenceFallbackResult, { status: 'ok' }> = {
    status: 'ok', source: 'text_matches', coverage: 'complete', hasMore: false,
    locations: [{ path: 'src/target.ts', range: { start: { line: 3, character: 16 }, end: { line: 3, character: 22 } }, lineText: 'export function answer() {}' }],
};

function fixture() {
    let text = 'const total = answer(1);';
    let current = true;
    let retire: (() => void) | undefined;
    const requests: Array<{ input: CodeIntelligenceFallbackInput; signal: AbortSignal; resolve(value: CodeIntelligenceFallbackResult): void }> = [];
    const opened: string[] = [];
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
        accountLifetime: {
            scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current,
            onRetire: callback => { retire = callback; return { dispose: () => { retire = undefined; } }; },
        },
        getText: () => text,
        query: (input, signal) => new Promise(resolve => requests.push({ input, signal, resolve })),
        openLocation: location => { opened.push(location.path); },
    });
    return { controller, requests, opened, setText: (value: string) => { text = value; }, retire: () => { current = false; retire?.(); } };
}

function editingFixture(initialText = 'answer()', flushPendingChange?: () => Promise<void>, withCapabilities = false) {
    let text = initialText;
    let completion = true;
    const textListeners = new Set<() => void>();
    const syncs: LanguageIntelligenceSyncInput[] = [];
    const watches: Array<(value: LanguageIntelligenceWatchResult) => void> = [];
    const requests: Array<{ input: LanguageIntelligenceQueryInput; signal: AbortSignal; resolve(value: LanguageIntelligenceQueryResult): void }> = [];
    const controller = createCodeIntelligenceController({
        scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
        getText: () => text, getUnsaved: () => true, flushPendingChange,
        subscribeText: listener => { textListeners.add(listener); return () => { textListeners.delete(listener); }; },
        query: async () => result, openLocation() {},
        languageServer: {
            sync: async input => { syncs.push(input); return { status: 'ok', generation: 'g1',
                ...('version' in input.op ? { version: input.op.version } : {}), servers: [{ serverId: 'ts', label: 'TS', state: 'ready', loading: false, generation: 'g1' }], ...(withCapabilities ? { capabilities: {
                    hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none' as const, acceptsExternalChanges: false,
                    completion, completionTriggerCharacters: ['.'],
                } } : {}) }; },
            query: (input, signal) => new Promise(resolve => { requests.push({ input, signal, resolve }); }),
            watch: (_input, signal) => new Promise((resolve, reject) => { watches.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
            restart: async () => ({ status: 'ok' }),
        },
    });
    return { controller, syncs, requests, watches, setCompletion(value: boolean) { completion = value; },
        edit(value: string) { text = value; for (const listener of textListeners) listener(); } };
}

describe('editing code intelligence requests', () => {
    it('publishes no snapshots or markers for equal watch replies and updates only the diagnosed file', async () => {
        const f = editingFixture();
        const server = { serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: 'g1' };
        const entry = (path: string, message: string) => ({ state: 'ready' as const, version: 1, generation: 'g1', items: [{
            serverId: 'ts', path, severity: 'error' as const, message,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        }] });
        const receive = async (answer: LanguageIntelligenceWatchResult) => {
            await vi.waitFor(() => expect(f.watches).toHaveLength(1));
            f.watches.shift()!(answer);
            await vi.waitFor(() => expect(f.watches).toHaveLength(1));
        };
        let release = () => {};
        try {
            await f.controller.activate();
            await receive({ status: 'ok', revision: 1, servers: [server], diagnostics: {
                'a.ts': { ts: entry('a.ts', 'First') }, 'b.ts': { ts: entry('b.ts', 'Other') },
            } });
            const snapshot = f.controller.getSnapshot();
            const projection = f.controller.getDiagnosticsProjection();
            const changed = vi.fn();
            const unsubscribe = f.controller.subscribe(changed);
            const setDecorations = vi.fn();
            release = bindCodeDiagnosticDecorations({ path: 'a.ts', getProjection: f.controller.getDiagnosticsProjection,
                subscribe: f.controller.subscribe, handle: { setDecorations } });
            for (let index = 0; index < 12; index++) await receive({ status: 'ok', revision: 1, servers: [{ ...server }], diagnostics: {} });
            expect(f.controller.getSnapshot()).toBe(snapshot);
            expect(f.controller.getDiagnosticsProjection()).toBe(projection);
            expect(changed).not.toHaveBeenCalled();
            expect(setDecorations).toHaveBeenCalledTimes(1);
            await receive({ status: 'ok', revision: 2, servers: [{ ...server }], diagnostics: { 'b.ts': { ts: entry('b.ts', 'Changed') } } });
            expect(f.controller.getDiagnosticsProjection().entries['a.ts']).toBe(projection.entries['a.ts']);
            expect(setDecorations).toHaveBeenCalledTimes(1);
            expect(f.controller.getSnapshot().diagnostics?.items.map(item => item.message)).toEqual(['First', 'Changed']);
            await receive({ status: 'ok', revision: 3, servers: [server], diagnostics: { 'a.ts': { ts: entry('a.ts', 'New marker') } } });
            expect(setDecorations.mock.lastCall?.[1]).toMatchObject([{ message: 'New marker' }]);
            expect(f.controller.getSnapshot().diagnostics?.count).toBe(2);
            unsubscribe();
        } finally { release(); f.controller.dispose(); }
    });

    it('keeps Problems checking across a rewritten document until the new watch answer arrives', async () => {
        const f = editingFixture();
        const server = { serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: 'g1' };
        const item = { serverId: 'ts', path: 'a.ts', severity: 'error' as const, message: 'Unknown name',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } };
        try {
            const check = f.controller.checkProblems();
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            f.requests[0].resolve({ status: 'ok', kind: 'diagnostics', diagnostics: [item], hasMore: false });
            await check;
            f.watches.shift()!({ status: 'ok', revision: 1, servers: [server], diagnostics: { 'a.ts': {
                ts: { version: 1, generation: 'g1', state: 'ready', items: [item] },
            } } });
            await vi.waitFor(() => expect(f.controller.getSnapshot().diagnostics?.count).toBe(1));
            f.edit('answer(  )');
            expect(f.controller.getSnapshot().diagnostics).toMatchObject({ state: 'checking', count: null, items: [item] });
            await f.controller.syncDocument();
            expect(f.controller.getSnapshot().diagnostics?.state).toBe('checking');
            await vi.waitFor(() => expect(f.watches).toHaveLength(1));
            f.watches.shift()!({ status: 'ok', revision: 2, servers: [server], diagnostics: { 'a.ts': {
                ts: { version: 2, generation: 'g1', state: 'ready', items: [item] },
            } } });
            await vi.waitFor(() => expect(f.controller.getSnapshot().diagnostics?.count).toBe(1));
            expect(f.requests).toHaveLength(1);
        } finally { f.controller.dispose(); }
    });

    it('retires completed and pending hover results as soon as their text changes, without requerying on edits', async () => {
        const f = editingFixture();
        try {
            const hover = f.controller.hover({ line: 0, character: 2 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            f.requests[0].resolve({ status: 'ok', kind: 'hover', sections: [{ serverId: 'ts', label: 'TS', markdown: 'function answer()' }] });
            await hover;
            expect(f.controller.getSnapshot().result).not.toBeNull();
            f.edit('renamed()');
            expect(f.controller.getSnapshot()).toMatchObject({ status: 'idle', result: null, querySelection: null });
            await f.controller.syncDocument();
            expect(f.requests).toHaveLength(1);
            const next = f.controller.hover({ line: 0, character: 2 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            f.edit('changedAgain()');
            expect(f.requests[1].signal.aborted).toBe(true);
            f.requests[1].resolve({ status: 'ok', kind: 'hover', sections: [{ serverId: 'ts', label: 'TS', markdown: 'function renamed()' }] });
            await next;
            expect(f.controller.getSnapshot().result).toBeNull();
        } finally { f.controller.dispose(); }
    });

    it('retains capability projection identity across ordinary text synchronization', async () => {
        const f = editingFixture('answer()', undefined, true);
        try {
            await f.controller.activate();
            const capabilities = f.controller.getSnapshot().capabilities;
            expect(capabilities?.completion).toBe(true);
            f.edit('answer(1)'); await f.controller.syncDocument();
            expect(f.controller.getSnapshot().capabilities).toBe(capabilities);
            f.setCompletion(false);
            f.edit('answer(2)'); await f.controller.syncDocument();
            expect(f.controller.getSnapshot().capabilities).not.toBe(capabilities);
            expect(f.controller.getSnapshot().capabilities?.completion).toBe(false);
        } finally { f.controller.dispose(); }
    });
    it('queries the text committed by its editor flush instead of cancelling that same request', async () => {
        const f = editingFixture('answer()', async () => { f.edit('answer(1)'); });
        try {
            const pending = f.controller.completion({ line: 0, character: 8 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            expect(f.requests[0].signal.aborted).toBe(false);
            f.requests[0].resolve({ status: 'ok', kind: 'completion', items: [], isIncomplete: false });
            expect(await pending).toMatchObject({ status: 'ok', kind: 'completion' });
        } finally { f.controller.dispose(); }
    });
    it('keeps project checks explicit and cancellable, retaining the last confirmed project diagnostics', async () => {
        vi.useFakeTimers();
        const f = editingFixture();
        try {
            await f.controller.activate();
            expect(f.requests).toHaveLength(0);
            expect(f.controller.getSnapshot().projectDiagnostics?.state ?? 'idle').toBe('idle');
            const check = f.controller.projectDiagnostics();
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            expect(f.controller.getSnapshot().projectDiagnostics?.state).toBe('checking');
            f.requests[0].resolve({ status: 'ok', kind: 'diagnostics', hasMore: false, diagnostics: [{
                serverId: 'ts', path: 'unopened.ts', severity: 'error', message: 'Missing name',
                range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } },
            }] });
            await check;
            expect(f.controller.getSnapshot().projectDiagnostics).toMatchObject({ state: 'ready', count: 1 });
            expect(f.controller.getSnapshot().projectDiagnostics?.items[0]?.path).toBe('unopened.ts');
            const abort = new AbortController();
            const again = f.controller.projectDiagnostics(abort.signal);
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            abort.abort();
            f.requests[1].resolve({ status: 'ok', kind: 'diagnostics', hasMore: false, diagnostics: [] });
            await again;
            expect(f.controller.getSnapshot().projectDiagnostics).toMatchObject({ state: 'ready', count: 1 });
            const changed = f.controller.projectDiagnostics();
            await vi.waitFor(() => expect(f.requests).toHaveLength(3));
            f.edit('changed()');
            expect(f.requests[2].signal.aborted).toBe(true);
            expect(f.controller.getSnapshot().projectDiagnostics).toMatchObject({ state: 'ready', count: 1 });
            f.requests[2].resolve({ status: 'ok', kind: 'diagnostics', hasMore: false, diagnostics: [] });
            expect(await changed).toBeNull();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(f.requests).toHaveLength(3);
        } finally { f.controller.dispose(); vi.useRealTimers(); }
    });
    it('starts once on explicit Edit activation and sends only compact changes for completion bursts on a 5k-line buffer', async () => {
        const initial = Array.from({ length: 5000 }, (_, line) => `const value${line} = ${line};`).join('\n');
        const f = editingFixture(initial);
        try {
            expect(f.syncs).toHaveLength(0);
            await f.controller.activate();
            await f.controller.activate();
            for (let index = 1; index <= 3; index++) {
                f.edit(initial + 'x'.repeat(index));
                const pending = f.controller.completion({ line: 4999, character: 22 + index });
                await vi.waitFor(() => expect(f.requests).toHaveLength(index));
                f.requests[index - 1].resolve({ status: 'loading' });
                await pending;
            }
            expect(f.syncs.filter(request => request.op.op === 'open')).toHaveLength(1);
            const changes = f.syncs.filter(request => request.op.op === 'change');
            expect(changes).toHaveLength(3);
            expect(changes.every(request => request.op.op === 'change' && request.op.edit.text === 'x' && !('text' in request.op))).toBe(true);
            expect(f.syncs.some(request => request.op.op === 'snapshot')).toBe(false);
            expect(f.requests.every(request => request.input.text === 'held' && !('contents' in request.input))).toBe(true);
        } finally { f.controller.dispose(); }
    });

    it('cancels only the superseded operation and drops its late response', async () => {
        const f = editingFixture();
        try {
            const first = f.controller.completion({ line: 0, character: 2 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            const hover = f.controller.hover({ line: 0, character: 2 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            const latest = f.controller.completion({ line: 0, character: 3 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(3));
            expect(f.requests[0].signal.aborted).toBe(true);
            expect(f.requests[1].signal.aborted).toBe(false);
            f.requests[0].resolve({ status: 'ok', kind: 'completion', items: [], isIncomplete: false });
            expect(await first).toBeNull();
            f.requests[2].resolve({ status: 'ok', kind: 'completion', items: [], isIncomplete: false });
            expect(await latest).toMatchObject({ status: 'ok', kind: 'completion' });
            f.requests[1].resolve({ status: 'ok', kind: 'hover', sections: [] });
            await hover;
            expect(f.controller.getSnapshot()).toMatchObject({ kind: 'hover', status: 'ready' });
        } finally { f.controller.dispose(); }
    });

    it('cancels a request at caller abort and invalidates active editing results on text change', async () => {
        const f = editingFixture();
        try {
            const caller = new AbortController();
            const cancelled = f.controller.completion({ line: 0, character: 2 }, undefined, caller.signal);
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            caller.abort();
            expect(f.requests[0].signal.aborted).toBe(true);
            f.requests[0].resolve({ status: 'loading' });
            expect(await cancelled).toBeNull();
            const stale = f.controller.signatureHelp({ line: 0, character: 7 });
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            f.edit('answer(1)');
            expect(f.requests[1].signal.aborted).toBe(true);
            f.requests[1].resolve({ status: 'ok', kind: 'signatureHelp', help: null });
            expect(await stale).toBeNull();
        } finally { f.controller.dispose(); }
    });

    it('preserves visible ranges and opaque server references without sending a full-document semantic request', async () => {
        const f = editingFixture();
        const range = { start: { line: 200, character: 0 }, end: { line: 230, character: 0 } };
        try {
            const semantic = f.controller.semanticTokens({ range });
            await vi.waitFor(() => expect(f.requests).toHaveLength(1));
            expect(f.requests[0].input).toMatchObject({ kind: 'semanticTokens', range });
            f.requests[0].resolve({ status: 'loading' }); await semantic;
            const resolve = f.controller.completionResolve({ serverId: 'ts', itemId: 'opaque' });
            await vi.waitFor(() => expect(f.requests).toHaveLength(2));
            expect(f.requests[1].input).toMatchObject({ kind: 'completionResolve', serverId: 'ts', itemId: 'opaque' });
            f.requests[1].resolve({ status: 'loading' }); await resolve;
            const project = f.controller.projectDiagnostics();
            await vi.waitFor(() => expect(f.requests).toHaveLength(3));
            expect(f.requests[2].input).toMatchObject({ kind: 'diagnostics', scope: 'project' });
            f.requests[2].resolve({ status: 'loading' }); await project;
        } finally { f.controller.dispose(); }
    });
});

describe('fallback code intelligence controller', () => {
    it('does not notify for an already dismissed view and still dismisses a real search', async () => {
        const f = fixture();
        const notify = vi.fn();
        f.controller.subscribe(notify);
        const idle = f.controller.getSnapshot();
        f.controller.dismiss();
        expect(f.controller.getSnapshot()).toBe(idle);
        expect(notify).not.toHaveBeenCalled();
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.controller.dismiss();
        expect(f.requests[0].signal.aborted).toBe(true);
        const dismissed = f.controller.getSnapshot();
        notify.mockClear();
        f.controller.dismiss();
        expect(f.controller.getSnapshot()).toBe(dismissed);
        expect(notify).not.toHaveBeenCalled();
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot()).toBe(dismissed);
        f.controller.dispose();
    });
    it('resolves the identifier from current text and opens the best definition through the provided file opener', async () => {
        const f = fixture();
        const pending = f.controller.definition({ line: 0, character: 16 });
        await Promise.resolve();
        expect(f.requests[0]?.input).toMatchObject({ path: 'src/current.ts', rootPath: '/repo', kind: 'definition', line: 1, symbol: 'answer' });
        expect(f.controller.getSnapshot().status).toBe('searching');
        f.requests[0].resolve(result);
        await pending;
        expect(f.opened).toEqual(['src/target.ts']);
        expect(f.controller.getSnapshot()).toMatchObject({ status: 'ready', kind: 'definition', result });
        f.controller.dispose();
    });

    it('cancels an older query and discards both late and edited-buffer results', async () => {
        const f = fixture();
        const first = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        const second = f.controller.definition({ line: 0, character: 16 });
        await Promise.resolve();
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await first;
        expect(f.controller.getSnapshot().status).toBe('searching');
        f.setText('const total = different(1);');
        f.requests[1].resolve(result);
        await second;
        expect(f.opened).toEqual([]);
        expect(f.controller.getSnapshot().status).toBe('idle');
        f.controller.dispose();
    });

    it('publishes same-token pointer state once and removes all result custody on Account retirement', async () => {
        const f = fixture();
        const notifications: string[] = [];
        f.controller.subscribe(() => notifications.push(f.controller.getSnapshot().status));
        f.controller.inspect({ line: 0, character: 16 });
        f.controller.inspect({ line: 0, character: 17 });
        expect(notifications).toHaveLength(1);
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.retire();
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot()).toMatchObject({ status: 'unavailable', result: null, selection: null, reason: 'account_unavailable' });
        expect(f.opened).toEqual([]);
        f.controller.dispose();
    });

    it('stops reporting a pending search when the caller cancels it', async () => {
        const f = fixture();
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.controller.cancel();
        expect(f.controller.getSnapshot().status).toBe('idle');
        expect(f.requests[0]?.signal.aborted).toBe(true);
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot().result).toBeNull();
        f.controller.dispose();
    });

    it('refreshes neighboring name chips when the buffer changes around the same selected token', () => {
        const f = fixture();
        f.controller.inspect({ line: 0, character: 16 });
        f.setText('const total = answer(next);');
        f.controller.inspect({ line: 0, character: 16 });
        expect(f.controller.getSnapshot().selection?.names.map(name => name.symbol)).toContain('next');
        f.controller.dispose();
    });

    it('keeps the engine anchor in shared state and refreshes it when the line moves', () => {
        const f = fixture();
        const anchor = { x: 12, y: 28, width: 8, height: 16 };
        f.controller.inspect({ line: 0, character: 16, anchor });
        expect(f.controller.getSnapshot().selection?.anchor).toEqual(anchor);
        f.controller.inspect({ line: 0, character: 16, anchor: { ...anchor, y: 48 } });
        expect(f.controller.getSnapshot().selection?.anchor?.y).toBe(48);
        f.controller.dispose();
    });

    it('keeps reference results tied to their queried name while another name is inspected', async () => {
        const f = fixture();
        const pending = f.controller.references({ line: 0, character: 16 });
        await Promise.resolve();
        f.controller.inspect({ line: 0, character: 7 });
        f.requests[0].resolve(result);
        await pending;
        expect(f.controller.getSnapshot().selection?.identifier.symbol).toBe('total');
        expect(f.controller.getSnapshot().querySelection?.identifier.symbol).toBe('answer');
        f.controller.inspect(null);
        expect(f.controller.getSnapshot()).toMatchObject({ selection: null, querySelection: { identifier: { symbol: 'answer' } }, result });
        f.controller.dismiss();
        expect(f.controller.getSnapshot().querySelection).toBeNull();
        f.controller.dispose();
    });
});

describe('on-demand language intelligence controller', () => {
    it('starts a cold Check problems without a hover and exposes checking through empty startup watches', async () => {
        let finishOpen!: (answer: LanguageIntelligenceSyncResult) => void;
        let finishQuery!: (answer: LanguageIntelligenceQueryResult) => void;
        const operations: string[] = [];
        const queries: string[] = [];
        const watches: Array<{ resolve(answer: LanguageIntelligenceWatchResult): void }> = [];
        const server = { serverId: 'ts', label: 'TypeScript', state: 'starting' as const, loading: false, generation: 'server-g1' };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'answer()', query: async () => result, openLocation() {},
            languageServer: {
                sync: request => {
                    operations.push(request.op.op);
                    return request.op.op === 'open' ? new Promise(resolve => { finishOpen = resolve; })
                        : Promise.resolve({ status: 'ok', generation: 'root-g1', servers: [] });
                },
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    watches.push({ resolve });
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                query: request => { queries.push(request.kind); return new Promise(resolve => { finishQuery = resolve; }); },
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            expect(await controller.outline()).toBeNull();
            expect(operations).toEqual([]);
            const pending = controller.checkProblems();
            expect(controller.getSnapshot()).toMatchObject({ mode: 'server', status: 'loading', kind: 'diagnostics',
                diagnostics: { state: 'checking', count: null } });
            await vi.waitFor(() => expect(operations).toEqual(['open']));
            watches[0].resolve({ status: 'ok', revision: 1, servers: [server], diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers).toEqual([server]));
            expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'checking', count: null });
            const loading = { ...server, state: 'ready' as const, loading: true };
            watches[1].resolve({ status: 'ok', revision: 2, servers: [loading], diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers).toEqual([loading]));
            finishOpen({ status: 'ok', generation: 'root-g1', version: 1, servers: [loading] });
            await vi.waitFor(() => expect(queries).toEqual(['diagnostics']));
            expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'checking', count: null });
            watches[2].resolve({ status: 'ok', revision: 3, servers: [{ ...loading, loading: false }], diagnostics: {
                'a.ts': { ts: { state: 'ready', generation: 'server-g1', version: 1, items: [] } },
            } });
            finishQuery({ status: 'ok', kind: 'diagnostics', diagnostics: [], hasMore: false });
            await pending;
            await vi.waitFor(() => expect(controller.getSnapshot().diagnostics).toMatchObject({ state: 'ready', count: 0 }));
            expect(queries).toEqual(['diagnostics']);
        } finally { controller.dispose(); }
    });

    it.each([1, 2])('revalidates pre-ack root diagnostics version %s once the opened document version is known', async diagnosticVersion => {
        let finishOpen!: (answer: LanguageIntelligenceSyncResult) => void;
        const server = { serverId: 'ts', label: 'TypeScript', state: 'ready' as const, loading: false, generation: 'g1' };
        const diagnostics = { 'a.ts': { ts: { state: 'ready' as const, version: diagnosticVersion, generation: 'g1', items: [{
            serverId: 'ts', path: 'a.ts', severity: 'error' as const, message: 'Root already opted into diagnostics',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        }] } } };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'answer()', query: async () => result, openLocation() {},
            languageServer: {
                sync: request => request.op.op === 'open' ? new Promise(resolve => { finishOpen = resolve; })
                    : Promise.resolve({ status: 'ok', generation: 'root-g1', servers: [] }),
                // Real root watches return a full snapshot without sinceRevision,
                // then park. A different holder already requested Check problems.
                watch: (request, signal) => request.sinceRevision === undefined
                    ? Promise.resolve({ status: 'ok', revision: 1, servers: [server], diagnostics })
                    : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                query: async () => ({ status: 'ok', kind: 'hover', sections: [] }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = controller.hover({ line: 0, character: 2 });
            await vi.waitFor(() => expect(controller.getSnapshot().servers).toEqual([server]));
            expect(selectCodeDiagnostics(controller.getDiagnosticsProjection()).items).toMatchObject([{ message: 'Root already opted into diagnostics' }]);
            finishOpen({ status: 'ok', generation: 'root-g1', version: 1, servers: [server] });
            await pending;
            expect(selectCodeDiagnostics(controller.getDiagnosticsProjection()).items).toMatchObject(diagnosticVersion === 1 ? [{ message: 'Root already opted into diagnostics' }] : []);
        } finally { controller.dispose(); }
    });

    it('publishes startup and project-loading to the asking surface before the first open is acknowledged', async () => {
        let finishOpen!: (answer: LanguageIntelligenceSyncResult) => void;
        const watches: Array<{ resolve(value: LanguageIntelligenceWatchResult): void }> = [];
        const server = { serverId: 'ts', label: 'TypeScript', state: 'starting' as const, loading: false, generation: 'g1' };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'answer()', query: async () => result, openLocation() {},
            languageServer: {
                sync: request => request.op.op === 'open' ? new Promise(resolve => { finishOpen = resolve; })
                    : Promise.resolve({ status: 'ok', generation: 'g1', servers: [] }),
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    watches.push({ resolve });
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                query: async () => ({ status: 'ok', kind: 'hover', sections: [{ serverId: 'ts', label: 'TypeScript', markdown: 'answer(): void' }] }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            expect(controller.getSnapshot().status).toBe('idle');
            expect(await controller.outline()).toBeNull();
            expect(watches).toHaveLength(0);
            const pending = controller.hover({ line: 0, character: 2 });
            expect(controller.getSnapshot()).toMatchObject({ mode: 'server', status: 'loading', kind: 'hover', querySelection: { identifier: { symbol: 'answer' } } });
            await vi.waitFor(() => expect(watches).toHaveLength(1));
            watches[0].resolve({ status: 'ok', revision: 1, servers: [server], diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers).toEqual([server]));
            const loading = { ...server, state: 'ready' as const, loading: true };
            watches[1].resolve({ status: 'ok', revision: 2, servers: [loading], diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers).toEqual([loading]));
            expect(controller.getSnapshot()).toMatchObject({ status: 'loading', kind: 'hover', querySelection: { identifier: { symbol: 'answer' } } });
            finishOpen({ status: 'ok', generation: 'g1', version: 1, servers: [{ ...loading, loading: false }],
                capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: false } });
            await pending;
            expect(controller.getSnapshot()).toMatchObject({ status: 'ready', kind: 'hover', result: { kind: 'hover' } });
        } finally { controller.dispose(); }
    });

    it.each([false, true])('re-asks a loading query after an early ready watch with unrelated failed server %s', async unrelatedFailed => {
        let updateWatch!: (answer: LanguageIntelligenceWatchResult) => void;
        let finishQuery!: (answer: LanguageIntelligenceQueryResult) => void;
        let started!: () => void;
        const began = new Promise<void>(resolve => { started = resolve; });
        let queries = 0;
        const server = { serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: 'g1' };
        const servers = [server, ...(unrelatedFailed ? [{ ...server, serverId: 'other', state: 'crashed' as const }] : [])];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'answer()', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers,
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: false } }),
                query: async () => {
                    queries += 1;
                    if (queries > 1) return { status: 'ok', kind: 'references', locations: [], hasMore: false };
                    started();
                    return new Promise(resolve => { finishQuery = resolve; });
                },
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    updateWatch = resolve;
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = controller.references({ line: 0, character: 2 });
            await began;
            updateWatch({ status: 'ok', revision: 1, servers: servers.map(item => item.serverId === server.serverId ? { ...item, loading: true } : item), diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.[0]?.loading).toBe(true));
            updateWatch({ status: 'ok', revision: 2, servers, diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.[0]?.loading).toBe(false));
            finishQuery({ status: 'loading' });
            await pending;
            await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'));
            expect(queries).toBe(2);
        } finally { controller.dispose(); }
    });

    it('keeps the servers that speak for this file when the root watch reports every server in the root', async () => {
        // A root watch lists every server running in the root; the document's own sync lists only the
        // servers for its language. The file's label and state note must keep naming its own server.
        let updateWatch!: (answer: LanguageIntelligenceWatchResult) => void;
        const novel = { serverId: 'novel', label: 'QA Novel Language', state: 'ready' as const, loading: false, generation: 'g1' };
        const ts = { serverId: 'ts', label: 'TypeScript', state: 'ready' as const, loading: false, generation: 'g1' };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/a.happiernovel', languageId: 'happier-novel',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'use qaGreeting', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers: [novel],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: false } }),
                query: async () => ({ status: 'ok', kind: 'hover', sections: [{ serverId: 'novel', label: 'QA Novel Language', markdown: 'signal' }] }),
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    updateWatch = resolve;
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await controller.hover({ line: 0, character: 6 });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.map(server => server.serverId)).toEqual(['novel']));
            await vi.waitFor(() => expect(updateWatch).toBeTypeOf('function'));
            updateWatch({ status: 'ok', revision: 1, servers: [ts, { ...novel, loading: true }], diagnostics: {} });
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.[0]?.loading).toBe(true));
            expect(controller.getSnapshot().servers?.map(server => server.label)).toEqual(['QA Novel Language']);
        } finally { controller.dispose(); }
    });
    it('drops a pre-restart watch after the replacement snapshot without restoring old-root problems or consuming its revision', async () => {
        let generation = 'g1';
        const watches: Array<{ request: LanguageIntelligenceWatchInput; resolve(value: LanguageIntelligenceWatchResult): void }> = [];
        const server = (value: string) => ({ serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: value });
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const value = 1;', query: async () => result, openLocation() {},
            languageServer: {
                sync: async request => ({ status: 'ok', generation: `root-${generation}`,
                    ...('version' in request.op ? { version: request.op.version } : {}), servers: [server(generation)],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: true } }),
                query: async request => ({ status: 'ok', kind: 'diagnostics', generation: `root-${generation}`, version: request.version, diagnostics: [], hasMore: false }),
                restart: async () => { generation = 'g2'; return { status: 'ok' }; },
                watch: (request, signal) => new Promise((resolve, reject) => {
                    watches.push({ request, resolve });
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
            },
        });
        try {
            await controller.checkProblems();
            expect(watches).toHaveLength(1);
            await controller.restart();
            expect(controller.getSnapshot().servers?.[0]?.generation).toBe('g2');
            watches[0].resolve({ status: 'ok', revision: 10, servers: [server('g1')], diagnostics: {
                'b.ts': { ts: { state: 'ready', version: 1, generation: 'g1', items: [{
                    serverId: 'ts', path: 'b.ts', severity: 'error', message: 'Old generation problem',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                }] } },
            } });
            await vi.waitFor(() => expect(watches).toHaveLength(2));
            expect(controller.getSnapshot().servers?.[0]?.generation).toBe('g2');
            expect(selectCodeDiagnostics(controller.getDiagnosticsProjection()).items).toEqual([]);
            expect(watches[1].request.sinceRevision).toBeUndefined();
        } finally { controller.dispose(); }
    });

    it.each([true, false])('says its servers are restarting while a Restart runs, then shows what came back (restart succeeds: %s)', async (succeeds) => {
        const server = { serverId: 'ts', label: 'TS', state: 'ready' as const, loading: false, generation: 'g1' };
        let finish!: () => void;
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const value = 1;', query: async () => result, openLocation() {},
            languageServer: {
                sync: async request => ({ status: 'ok', generation: 'root', ...('version' in request.op ? { version: request.op.version } : {}),
                    servers: [server], capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: true } }),
                query: async request => ({ status: 'ok', kind: 'diagnostics', generation: 'root', version: request.version, diagnostics: [], hasMore: false }),
                restart: () => new Promise(resolve => { finish = () => resolve(succeeds ? { status: 'ok' } : { status: 'unavailable', reason: 'session_unavailable' }); }),
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
            },
        });
        try {
            await controller.checkProblems();
            const restarting = controller.restart();
            await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            expect(controller.getSnapshot().servers?.map(item => item.state)).toEqual(['restarting']);
            finish();
            await restarting;
            await vi.waitFor(() => expect(controller.getSnapshot().servers?.map(item => item.state)).toEqual(['ready']));
        } finally { controller.dispose(); }
    });

    it.each(['crashed', 'loading'] as const)('keeps a capable server answer authoritative while another server is %s', async other => {
        const server = { serverId: 'lang:server', label: 'Language', state: 'ready' as const, loading: false, generation: 'g1' };
        const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } };
        const symbols = other === 'crashed' ? [{ serverId: server.serverId, name: 'Accurate', kind: 5, range, selectionRange: range }] : [];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'class Box {}', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1,
                    servers: [server, { ...server, serverId: 'lang:other', state: other === 'crashed' ? 'crashed' : 'starting', loading: other === 'loading' }],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none', acceptsExternalChanges: false } }),
                query: async request => request.kind === 'documentSymbols'
                    ? { status: 'ok', kind: 'documentSymbols', generation: 'g1', version: 1, hasMore: false, symbols }
                    : { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false, locations: [] },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await controller.definition({ line: 0, character: 6 });
            const baseline = { status: 'ok' as const, symbols: [{ name: 'Baseline', kind: 'class', line: 1, column: 6, depth: 0 }] };
            const selected = selectDocumentOutline({ baseline, server: await controller.outline() });
            expect(selected).toMatchObject({ status: 'ok', symbols: other === 'crashed' ? [{ name: 'Accurate' }] : [] });
            expect(controller.getSnapshot().servers?.[1]).toMatchObject({ state: other === 'crashed' ? 'crashed' : 'starting', loading: other === 'loading' });
        } finally { controller.dispose(); }
    });

    it('rejects a pending outline after its server crashes into another generation', async () => {
        let finishSymbols!: (answer: LanguageIntelligenceQueryResult) => void;
        let updateWatch!: (answer: LanguageIntelligenceWatchResult) => void;
        let startedSymbols!: () => void;
        const symbolStarted = new Promise<void>(resolve => { startedSymbols = resolve; });
        const server = { serverId: 'lang:server', label: 'Language', state: 'ready' as const, loading: false, generation: 'g1' };
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'class Box {}', query: async () => result, openLocation() {},
            languageServer: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers: [server],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'none', acceptsExternalChanges: false } }),
                query: async request => {
                    if (request.kind !== 'documentSymbols') return { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false, locations: [] };
                    startedSymbols();
                    return new Promise(resolve => { finishSymbols = resolve; });
                },
                watch: (_request, signal) => new Promise((resolve, reject) => {
                    updateWatch = resolve;
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await controller.definition({ line: 0, character: 6 });
            const pending = controller.outline();
            await symbolStarted;
            const observedCrash = new Promise<void>(resolve => {
                const stop = controller.subscribe(() => {
                    if (controller.getSnapshot().servers?.[0]?.state === 'crashed') { stop(); resolve(); }
                });
            });
            updateWatch({ status: 'ok', revision: 1, servers: [{ ...server, state: 'crashed', generation: 'g2' }], diagnostics: {} });
            await observedCrash;
            const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } };
            finishSymbols({ status: 'ok', kind: 'documentSymbols', generation: 'g1', version: 1, hasMore: false,
                symbols: [{ serverId: 'lang:server', name: 'Ghost', kind: 5, range, selectionRange: range }] });
            const baseline = { status: 'ok' as const, symbols: [{ name: 'Box', kind: 'class', line: 1, column: 6, depth: 0 }] };
            expect(selectDocumentOutline({ baseline, server: await pending })).toBe(baseline);
        } finally { controller.dispose(); }
    });

    it('keeps file open and outline passive, starts on the first explicit query, and closes the one document lease', async () => {
        const calls: string[] = [];
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'src/current.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            getText: () => 'const total = answer(1);',
            query: async () => { calls.push('fallback'); return result; },
            openLocation: location => { calls.push(`open:${location.path}`); },
            languageServer: {
                sync: async request => {
                    calls.push(request.op.op);
                    return { status: 'ok', generation: 'g1', version: 1,
                        servers: [{ serverId: 'lang:server', label: 'Language', state: 'ready', loading: false, generation: 'g1' }],
                        capabilities: { hover: true, definition: true, references: true, documentSymbol: true, diagnostics: 'pull', acceptsExternalChanges: true } };
                },
                query: async request => {
                    calls.push(request.kind);
                    return { status: 'ok', kind: 'definition', generation: 'g1', version: 1, hasMore: false,
                        locations: [{ serverId: 'lang:server', path: 'src/server-target.ts', range: result.locations[0].range }] };
                },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        expect(calls).toEqual([]);
        expect(await controller.outline()).toBeNull();
        expect(calls).toEqual([]);
        await controller.definition({ line: 0, character: 16 });
        expect(calls).toEqual(['open', 'definition', 'open:src/server-target.ts']);
        expect(controller.getSnapshot()).toMatchObject({ mode: 'server', status: 'ready' });
        controller.dismiss();
        expect(controller.getSnapshot().servers?.[0]?.serverId).toBe('lang:server');
        expect(controller.getSnapshot().capabilities?.documentSymbol).toBe(true);
        controller.dispose();
        await vi.waitFor(() => expect(calls.filter(call => call === 'close')).toHaveLength(1));
        expect(calls).not.toContain('diagnostics');
    });
});
