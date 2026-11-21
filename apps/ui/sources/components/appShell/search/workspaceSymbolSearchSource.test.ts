import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceSymbolSearchSource, type WorkspaceSymbolSearchInput } from './workspaceSymbolSearchSource';
import type { DocumentOutlineServerAnswer } from '@/sync/domains/workspaces/languageIntelligence/documentOutline';

function fixture(serverId: string | null = 'home', serverOutline?: DocumentOutlineServerAnswer | null) {
    let text = 'class Old {}';
    let current = true;
    let flushed = false;
    let flush: () => Promise<void> | void = () => { text = 'class Fresh {\n    constructor() {}\n}'; flushed = true; };
    const input: WorkspaceSymbolSearchInput = {
        target: { kind: 'workspaceFile', path: 'src/box.ts', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
            accountId: 'account', serverId, workspaceRefId: 'project', sessionId: null },
        resolverKey: 'holder-1', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
        accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current, onRetire: () => ({ dispose() {} }) },
        isCurrent: () => current,
        getText: () => { expect(flushed).toBe(true); return text; },
        flushPendingChange: () => flush(),
        ...(serverOutline !== undefined ? { getServerOutline: async () => serverOutline } : {}),
    };
    const source = createWorkspaceSymbolSearchSource(input);
    return { source, input, retire: () => { current = false; }, setFlush: (value: () => Promise<void>) => { flush = value; } };
}

describe('active file symbol source', () => {
    it('keeps same-path managed symbol sources and results distinct', async () => {
        const workspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'checkout-a', managedId: 'guest-a',
            controller: { machineId: 'machine', installationId: 'installation' }, rootPath: '/repo' };
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } };
        const sources = [workspace, { ...workspace, workspaceId: 'checkout-b', managedId: 'guest-b' }].map(address => {
            const { input } = fixture('home', { capable: true, state: 'ready', loading: false,
                symbols: [{ serverId: 'language-server', name: 'Fresh', kind: 5, range, selectionRange: range }] });
            return createWorkspaceSymbolSearchSource({ ...input, target: { ...input.target,
                scope: { ...input.target.scope, workspace: address } } });
        });
        const pages = await Promise.all(sources.map(source => source.resolve('Fresh', new AbortController().signal)));
        expect(sources[0].resolverKey).not.toBe(sources[1].resolverKey);
        expect(pages[0].results[0]?.scopeKey).not.toBe(pages[1].results[0]?.scopeKey);
    });
    it.each(['no_capable_server', 'update_required', 'transport_failed'] as const)('keeps the document baseline explicitly scoped when the project query is %s', async reason => {
        const source = createWorkspaceSymbolSearchSource({ ...fixture().input,
            baselineHint: 'Symbols in box.ts',
            getWorkspaceSymbols: async () => ({ status: 'unavailable', reason }),
        });
        const page = await source.resolve('Fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
        expect(page.resultHint).toBe('Symbols in box.ts');
    });

    it('queries project symbols and preserves each result file and range', async () => {
        const range = { start: { line: 42, character: 8 }, end: { line: 42, character: 14 } };
        const f = fixture();
        const source = createWorkspaceSymbolSearchSource({
            ...f.input,
            getWorkspaceSymbols: async () => ({ status: 'ok', kind: 'workspaceSymbol', hasMore: false,
                symbols: [{ serverId: 'ts', path: 'lib/other.ts', name: 'Remote', kind: 12, range }] }),
        });
        const page = await source.resolve('Remote', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Remote']);
        expect(page.results[0]?.target).toMatchObject({ path: 'lib/other.ts', anchor: { startLine: 43 } });
    });

    it('cancels the previous project query when a new keystroke asks for symbols', async () => {
        const requests: Array<{ query: string; signal: AbortSignal; resolve(value: null): void }> = [];
        const source = createWorkspaceSymbolSearchSource({ ...fixture().input,
            getWorkspaceSymbols: (query, signal) => new Promise(resolve => requests.push({ query, signal, resolve })),
        });
        const first = source.resolve('R', new AbortController().signal).catch(error => error);
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        const second = source.resolve('Re', new AbortController().signal);
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        expect(requests[0].signal.aborted).toBe(true);
        requests[0].resolve(null);
        expect(await first).toMatchObject({ name: 'AbortError' });
        requests[1].resolve(null);
        await second;
    });
    it('uses a passive server answer for rows and preserves an authoritative empty outline', async () => {
        const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
        const answer: DocumentOutlineServerAnswer = { capable: true, state: 'ready', loading: false, symbols: [
            { serverId: 'language-server', name: 'Fresh', kind: 5, range,
                selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
                children: [{ serverId: 'language-server', name: 'constructor', kind: 9, range,
                    selectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 15 } } }],
            },
        ] };
        // The getter is read only after the existing editor's flush, never from disk.
        const page = await fixture('home', answer).source.resolve('constructor', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['constructor']);
        expect(page.results[0]).toMatchObject({ symbol: { kind: 'constructor', line: 2, depth: 1, container: 'Fresh' } });
        expect(page.results[0]?.target).toMatchObject({ anchor: { kind: 'fileLine', startLine: 2 } });
        expect((await fixture('home', { ...answer, symbols: [] }).source.resolve('', new AbortController().signal)).results).toEqual([]);
        expect((await fixture('home', { ...answer, loading: true, symbols: [] }).source.resolve('', new AbortController().signal)).results.map(row => row.title)).toEqual(['Fresh']);
    });

    it('flushes and reads the current holder on demand, then filters outline rows', async () => {
        const f = fixture();
        const page = await f.source.resolve('fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
        expect(page.results[0]).toMatchObject({ symbol: { kind: 'class', line: 1, depth: 0 } });
        expect(page.results[0]?.symbol).not.toHaveProperty('container');
        expect(page.results[0]?.target).toMatchObject({ kind: 'workspaceSymbol', path: 'src/box.ts', anchor: { kind: 'fileLine', startLine: 1 } });
    });

    it('does not publish a result after its holder or Account retires during flush', async () => {
        const f = fixture();
        let finish!: () => void;
        f.setFlush(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.source.resolve('', new AbortController().signal);
        f.retire();
        finish();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('uses the exact workspace scope when the optional navigation Home is absent', async () => {
        const page = await fixture(null).source.resolve('fresh', new AbortController().signal);
        expect(page.results.map(row => row.title)).toEqual(['Fresh']);
        expect(page.results[0]?.target).toMatchObject({ serverId: 'home' });
    });

    it('preserves line anchors for lone CR editor text', async () => {
        const source = createWorkspaceSymbolSearchSource({
            target: { kind: 'workspaceFile', path: 'src/box.ts', scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' },
                accountId: 'account', serverId: 'home', workspaceRefId: 'project', sessionId: null },
            resolverKey: 'holder-cr', language: 'typescript', isDark: false, unavailableHint: 'Unavailable',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            isCurrent: () => true, getText: () => '// first\rclass Fresh {}', flushPendingChange() {},
        });
        const page = await source.resolve('fresh', new AbortController().signal);
        expect(page.results[0]?.target).toMatchObject({ anchor: { kind: 'fileLine', startLine: 2 } });
    });
});
