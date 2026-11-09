import { describe, expect, it, vi } from 'vitest';
import type { LanguageIntelligenceSyncResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { createCodeIntelligenceDocument, type CodeIntelligenceServerPort } from './codeIntelligenceDocument';

describe('language document custody', () => {
    it('keeps an unchanged query current when another operation resynchronizes an equal acknowledgement', async () => {
        let finishProject!: (value: import('@happier-dev/protocol/machines/languageIntelligence').LanguageIntelligenceQueryResult) => void;
        let hoverRequests = 0;
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true,
            onSync() {}, onWatch() {}, onUnavailable() {},
            port: {
                // The Machine can acknowledge the same admitted document revision
                // after a sibling operation reacquires its unchanged snapshot.
                sync: async () => ({ status: 'ok', generation: 'g1', version: 5, servers: [] }),
                query: async request => {
                    if (request.kind === 'diagnostics') return new Promise(resolve => { finishProject = resolve; });
                    if (++hoverRequests === 1) return { status: 'error', errorCode: 'stale_query' };
                    return { status: 'ok', kind: 'hover', sections: [] };
                },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = holder.query('diagnostics', undefined, new AbortController().signal, true, { scope: 'project' });
            await vi.waitFor(() => expect(finishProject).toBeTypeOf('function'));
            expect(await holder.query('hover', { line: 0, character: 2 }, new AbortController().signal)).toMatchObject({ status: 'ok' });
            finishProject({ status: 'ok', kind: 'diagnostics', diagnostics: [], hasMore: false, version: 5, generation: 'g1' });
            expect(await pending).toMatchObject({ status: 'ok', kind: 'diagnostics' });
        } finally { holder.dispose(); }
    });

    it('drops an in-flight answer after acknowledged edits even when the original text is restored', async () => {
        let text = 'answer()';
        let version = 0;
        let finishQuery!: (value: import('@happier-dev/protocol/machines/languageIntelligence').LanguageIntelligenceQueryResult) => void;
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => text, getUnsaved: () => true, isCurrent: () => true,
            onSync() {}, onWatch() {}, onUnavailable() {},
            port: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: ++version, servers: [] }),
                query: async () => new Promise(resolve => { finishQuery = resolve; }),
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = holder.query('hover', { line: 0, character: 2 }, new AbortController().signal);
            await vi.waitFor(() => expect(finishQuery).toBeTypeOf('function'));
            text = 'changed()';
            await holder.synchronize();
            text = 'answer()';
            await holder.synchronize();
            finishQuery({ status: 'ok', kind: 'hover', sections: [] });
            expect(await pending).toEqual({ status: 'error', errorCode: 'stale_query' });
        } finally { holder.dispose(); }
    });

    it('drops a resynchronized query when the buffer moves again while its retry is in flight', async () => {
        let text = 'answer()';
        let finishRetry!: (value: import('@happier-dev/protocol/machines/languageIntelligence').LanguageIntelligenceQueryResult) => void;
        let requests = 0;
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => text, getUnsaved: () => true, isCurrent: () => true, onSync() {}, onWatch() {}, onUnavailable() {},
            port: {
                sync: async request => ({ status: 'ok', generation: 'g1',
                    ...('version' in request.op ? { version: request.op.version } : {}), servers: [] }),
                query: async () => {
                    if (++requests === 1) return { status: 'error', errorCode: 'document_out_of_sync' };
                    return new Promise(resolve => { finishRetry = resolve; });
                },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = holder.query('hover', { line: 0, character: 2 }, new AbortController().signal);
            await vi.waitFor(() => expect(requests).toBe(2));
            text = 'different()';
            finishRetry({ status: 'ok', kind: 'hover', sections: [] });
            expect(await pending).toEqual({ status: 'error', errorCode: 'stale_query' });
        } finally { holder.dispose(); }
    });
    it.each(['throw', 'unavailable'] as const)('resumes diagnostic delivery after a healthy watch disconnects (%s) and the next query succeeds', async (failure) => {
        let disconnect!: () => void;
        let watches = 0;
        const received: number[] = [];
        const unavailable: string[] = [];
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true, onSync() {},
            onWatch: answer => { received.push(answer.revision); }, onUnavailable: reason => { unavailable.push(reason); },
            port: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1, servers: [] }),
                query: async () => ({ status: 'ok', kind: 'hover', sections: [] }),
                watch: (_request, signal) => {
                    watches++;
                    if (watches === 1) return Promise.resolve({ status: 'ok', revision: 1, servers: [], diagnostics: {} });
                    if (watches === 2) return new Promise((resolve, reject) => {
                        disconnect = () => failure === 'throw' ? reject(new Error('Disconnected'))
                            : resolve({ status: 'unavailable', reason: 'session_unavailable' });
                    });
                    // Connectivity can recover while the first re-park is still failing.
                    // The successful query must restore delivery even without another edit.
                    if (watches === 3) return Promise.reject(new Error('Reconnect still pending'));
                    if (watches === 4) return Promise.resolve({ status: 'ok', revision: 3, servers: [], diagnostics: {
                        'a.ts': { ts: { state: 'ready', version: 1, generation: 'g1', items: [{ serverId: 'ts', path: 'a.ts',
                            severity: 'error', message: 'Fresh after recovery', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }] } },
                    } });
                    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
                },
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            await holder.query('hover', { line: 0, character: 2 }, new AbortController().signal);
            await vi.waitFor(() => expect(received).toEqual([1]));
            disconnect();
            await vi.waitFor(() => expect(unavailable).toEqual([failure === 'throw' ? 'transport_failed' : 'session_unavailable']));
            expect(await holder.query('hover', { line: 0, character: 2 }, new AbortController().signal)).toMatchObject({ status: 'ok' });
            await vi.waitFor(() => expect(received).toEqual([1, 3]));
        } finally { holder.dispose(); }
    });

    it('restores watch delivery at open acknowledgement if the startup watch ended early', async () => {
        let finishOpen!: (answer: LanguageIntelligenceSyncResult) => void;
        let watches = 0;
        const received: number[] = [];
        const unavailable: string[] = [];
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true, onSync() {},
            onWatch: answer => { received.push(answer.revision); }, onUnavailable: reason => { unavailable.push(reason); },
            port: {
                sync: request => request.op.op === 'open' ? new Promise(resolve => { finishOpen = resolve; })
                    : Promise.resolve({ status: 'ok', generation: 'g1', servers: [] }),
                query: async () => ({ status: 'ok', kind: 'hover', sections: [] }),
                watch: (_request, signal) => {
                    watches++;
                    if (watches === 1) return Promise.reject(new Error('Startup transport disconnected'));
                    if (watches === 2) return Promise.resolve({ status: 'ok', revision: 5, servers: [], diagnostics: {} });
                    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
                },
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = holder.query('hover', { line: 0, character: 2 }, new AbortController().signal);
            await vi.waitFor(() => expect(unavailable).toEqual(['transport_failed']));
            finishOpen({ status: 'ok', generation: 'g1', version: 1, servers: [] });
            await pending;
            await vi.waitFor(() => expect(received).toEqual([5]));
        } finally { holder.dispose(); }
    });

    it('closes a sent lease without waiting for startup, but never closes a queued unsent lease', async () => {
        let markOpened!: () => void;
        let finishOpen!: (value: LanguageIntelligenceSyncResult) => void;
        const opened = new Promise<void>(resolve => { markOpened = resolve; });
        let closes = 0;
        const port: CodeIntelligenceServerPort = {
            sync: async request => {
                if (request.op.op === 'open') { markOpened(); return new Promise(resolve => { finishOpen = resolve; }); }
                if (request.op.op === 'close') closes++;
                return { status: 'ok', generation: 'g1', servers: [] };
            },
            query: async () => ({ status: 'loading' }), watch: async () => ({ status: 'loading' }), restart: async () => ({ status: 'ok' }),
        };
        const input = { rootPath: '/repo', path: 'a.ts', languageId: 'typescript', port,
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true, onSync() {}, onWatch() {}, onUnavailable() {} };
        const holder = createCodeIntelligenceDocument(input);
        const request = holder.query('hover', { line: 0, character: 2 }, new AbortController().signal);
        await opened;
        holder.dispose();
        await vi.waitFor(() => expect(closes).toBe(1));
        finishOpen({ status: 'unavailable', reason: 'session_unavailable' });
        expect(await request).toBeNull();
        const unsent = createCodeIntelligenceDocument(input);
        const abandoned = unsent.query('hover', { line: 0, character: 2 }, new AbortController().signal);
        unsent.dispose();
        expect(await abandoned).toBeNull();
        expect(closes).toBe(1);
    });

    it('cancels the transport of a passive symbol query when its holder closes', async () => {
        let observedSignal: AbortSignal | undefined;
        let finishQuery!: () => void;
        let markQuery!: () => void;
        const queryStarted = new Promise<void>(resolve => { markQuery = resolve; });
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.ts', languageId: 'typescript',
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true, onSync() {}, onWatch() {}, onUnavailable() {},
            port: {
                sync: async () => ({ status: 'ok', generation: 'g1', version: 1,
                    servers: [{ serverId: 'example', label: 'Example', state: 'ready', loading: false, generation: 'g1' }] }),
                query: (_request, signal) => { observedSignal = signal; markQuery(); return new Promise(resolve => {
                    finishQuery = () => resolve({ status: 'ok', kind: 'documentSymbols', symbols: [], hasMore: false });
                }); },
                watch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        const pending = holder.query('documentSymbols', undefined, new AbortController().signal);
        await queryStarted;
        holder.dispose();
        expect(observedSignal?.aborted).toBe(true);
        finishQuery();
        expect(await pending).toBeNull();
    });

    it('watches while startup is pending, then releases that watch if no server can open without disabling fallback', async () => {
        let finishOpen!: (answer: LanguageIntelligenceSyncResult) => void;
        let watchSignal: AbortSignal | undefined;
        const holder = createCodeIntelligenceDocument({ rootPath: '/repo', path: 'a.txt', languageId: 'text',
            getText: () => 'answer()', getUnsaved: () => false, isCurrent: () => true, onSync() {}, onWatch() {}, onUnavailable() {},
            port: {
                sync: request => request.op.op === 'open' ? new Promise(resolve => { finishOpen = resolve; })
                    : Promise.resolve({ status: 'ok', generation: 'g1', servers: [] }),
                query: async () => ({ status: 'loading' }),
                watch: (_request, signal) => {
                    watchSignal = signal;
                    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
                },
                restart: async () => ({ status: 'ok' }),
            },
        });
        try {
            const pending = holder.query('definition', { line: 0, character: 2 }, new AbortController().signal);
            await vi.waitFor(() => expect(watchSignal).toBeDefined());
            expect(watchSignal?.aborted).toBe(false);
            finishOpen({ status: 'unavailable', reason: 'no_capable_server' });
            expect(await pending).toEqual({ status: 'unavailable', reason: 'no_capable_server' });
            expect(watchSignal?.aborted).toBe(true);
            expect(await holder.query('references', { line: 0, character: 2 }, new AbortController().signal))
                .toEqual({ status: 'unavailable', reason: 'no_capable_server' });
        } finally { holder.dispose(); }
    });
});
