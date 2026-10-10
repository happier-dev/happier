import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import type { MemorySearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import { searchConversations, hasConversationSearchScanFallback } from './searchConversations';

const rpc = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('@/sync/ops/machineExternalSessions', () => ({ machineExternalSessionsCandidatesList: list }));
const hit = (sessionId: string, time: number, score = 0.5): MemorySearchHitV1 => ({
    sessionId, seqFrom: 1, seqTo: 2, createdAtFromMs: time, createdAtToMs: time, summary: 'quartz match', score,
});
const input = {
    serverId: 'home', accountId: 'account', concurrencyLimit: 2,
    machines: [{ id: 'one', online: true }, { id: 'two', online: true }, { id: 'offline', online: false }],
    query: { v: 1 as const, query: 'quartz', scope: { type: 'global' as const }, mode: 'auto' as const },
};
const status = { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true,
    activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false, embeddingsMode: 'disabled',
    embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null,
    embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false, tier1DbPath: null, deepDbPath: null,
    tier1DbBytes: null, deepDbBytes: null };
beforeEach(() => {
    rpc.mockReset();
    list.mockReset().mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
    rpc.mockImplementation(async (call) => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
        ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true }
        : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status
            : { v: 1, ok: true, hits: [hit(call.machineId, call.machineId === 'one' ? 10 : 30, call.machineId === 'one' ? 1 : 0.1)] });
});
describe('conversation search fan-out', () => {
    it('keeps an empty partial scan pageable and preserves the literal phrase at the source boundary', async () => {
        rpc.mockResolvedValue({ ...DEFAULT_MEMORY_SETTINGS, enabled: false });
        list.mockResolvedValueOnce({ ok: true, candidates: [], contentCoverage: 'partial', nextCursor: 'remaining-file' })
            .mockResolvedValueOnce({ ok: true, candidates: [{ remoteSessionId: 'later', updatedAtMs: 1,
                match: { snippet: '  literal body  ', sourceItemId: 'later-message', messageIndex: 0 } }], contentCoverage: 'complete' });
        const source = { agentId: 'pi', sourceKey: 'local', source: { kind: 'piHome', home: 'user' }, contentSearch: true };
        const request = { ...input, machines: [input.machines[0]], mode: 'standard' as const,
            query: { ...input.query, query: '  literal body  ', corpora: ['external_transcripts' as const],
                externalSource: { agentId: 'pi', sourceKey: 'local' } }, readSources: async () => [source] };
        const first = await searchConversations(request);
        expect(first.hits).toEqual([]);
        expect(first.continuations).toEqual([{ machineId: 'one', sourceKey: 'local', cursor: 'remaining-file' }]);
        const second = await searchConversations({ ...request, continuation: first.continuations![0] });
        expect(second.hits).toMatchObject([{ mode: 'standard', candidate: { remoteSessionId: 'later', match: { sourceItemId: 'later-message' } } }]);
        expect(list.mock.calls.map(([query]) => [query.searchTerm, query.cursor])).toEqual([
            ['  literal body  ', undefined], ['  literal body  ', 'remaining-file'],
        ]);
        expect(second.completedStandardSources).toEqual([{ machineId: 'one', agentId: 'pi', sourceKey: 'local' }]);
    });
    it('does not scan a source without content capability, or a different source from the exact selection', async () => {
        rpc.mockResolvedValue({ ...DEFAULT_MEMORY_SETTINGS, enabled: false });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'standard',
            query: { ...input.query, externalSource: { agentId: 'pi', sourceKey: 'selected' } }, readSources: async () => [
                { agentId: 'pi', sourceKey: 'selected', source: { kind: 'piHome', home: 'user' }, contentSearch: false },
                { agentId: 'pi', sourceKey: 'other', source: { kind: 'piHome', home: 'other' }, contentSearch: true },
            ] });
        expect(list).not.toHaveBeenCalled();
        expect(result.sources?.map(source => source.sourceKey)).toEqual(['selected']);
        expect(result.machines[0].status).toBe('partial');
    });
    it('offers the palette scan only for unready or unknown sources, including before a query', async () => {
        let ready = true;
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : { ...status, sources: ['local', 'work'].map(sourceKey => ({
                source: { type: 'external_transcript', agentId: 'pi', sourceKey },
                state: sourceKey === 'local' || ready ? 'ready' : 'indexing',
            })) });
        const request = { ...input, machines: [input.machines[0]], mode: 'indexed' as const,
            query: { ...input.query, query: '', corpora: ['external_transcripts' as const] },
            readSources: async () => ['local', 'work'].map(sourceKey => ({ agentId: 'pi', sourceKey,
                source: { kind: 'piHome', home: sourceKey }, contentSearch: true })) };
        const indexed = await searchConversations(request);
        expect(indexed.sources?.map(source => source.indexReady)).toEqual([true, true]);
        expect(hasConversationSearchScanFallback(indexed)).toBe(false);
        ready = false;
        expect(hasConversationSearchScanFallback(await searchConversations(request))).toBe(true);
        expect(list).not.toHaveBeenCalled();
        expect(hasConversationSearchScanFallback({ hits: [], machines: [{ machineId: 'one', status: 'ok', standardSearchEnabled: true }] })).toBe(true);
    });
    it('selects the index only for the exact ready source and scans indexing, disabled, error and unknown sources', async () => {
        const sources = ['ready', 'indexing', 'disabled', 'error', 'unknown'].map(sourceKey => ({
            agentId: 'pi', sourceKey, source: { kind: 'piHome' as const, home: sourceKey }, contentSearch: true,
        }));
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? { ...status, sources: [
                ...['ready', 'indexing', 'disabled', 'error'].map(state => ({ source: { type: 'external_transcript', agentId: 'pi', sourceKey: state }, state })),
                { source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'unknown' }, state: 'ready' },
            ] } : { v: 1, ok: true, hits: [] });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'auto',
            query: { ...input.query, corpora: ['external_transcripts'] }, readSources: async () => sources });
        expect(list.mock.calls.map(([request]) => request.source.home)).toEqual(['indexing', 'disabled', 'error', 'unknown']);
        expect(result.machines[0].status).toBe('partial');
    });
    it('reports complete native index coverage when every configured source is ready, including an empty index', async () => {
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? { ...status, sources: [
                { source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local' }, state: 'ready' },
            ] } : { v: 1, ok: true, hits: [] });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'auto',
            query: { ...input.query, corpora: ['external_transcripts'] }, readSources: async () => [
                { agentId: 'pi', sourceKey: 'local', source: { kind: 'piHome', home: 'user' }, contentSearch: true },
            ] });
        expect(list).not.toHaveBeenCalled();
        expect(result.machines[0].status).toBe('ok');
    });
    it('retains same-named native conversations and distinct source identities across machines during a standard scan', async () => {
        rpc.mockResolvedValue({ ...DEFAULT_MEMORY_SETTINGS, enabled: false });
        list.mockImplementation(async request => ({ ok: true, contentCoverage: 'complete', candidates: [{
            remoteSessionId: 'same-native-id', updatedAtMs: request.machineId === 'one' ? 10 : 30,
            match: { sourceItemId: 'message', snippet: 'quartz', messageIndex: 1 },
        }] }));
        const result = await searchConversations({ ...input, mode: 'standard',
            readSources: async () => [{ agentId: 'pi', sourceKey: 'local', key: 'local', source: { kind: 'piHome', home: 'user' }, contentSearch: true }] });
        expect(result.hits.map(row => row.machineId), JSON.stringify({ result, calls: list.mock.calls })).toEqual(['two', 'one']);
        expect(new Set(result.sources?.map(source => source.key)).size).toBe(2);
        expect(result.machines.at(-1)).toMatchObject({ machineId: 'offline', status: 'offline' });
    });
    it('does not mistake global index readiness for per-source freshness in an explicit automatic search', async () => {
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status : { v: 1, ok: true, hits: [{
                type: 'external_transcript', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'pi-local', nativeSessionId: 'removed' },
                sourceItemId: 'old-message', createdAtFromMs: 1, createdAtToMs: 1, summary: 'quartz', score: 0.5,
            }] });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'auto',
            query: { ...input.query, corpora: ['external_transcripts'] }, readSources: async () => [{ agentId: 'pi', sourceKey: 'pi-local', source: { kind: 'piHome', home: 'user' }, contentSearch: true }] });
        expect(result.machines[0].status).toBe('partial');
        expect(list).toHaveBeenCalledOnce();
        expect(result.hits).toEqual([]);
    });
    it('keeps reachable results, reports offline scope, and merges by recency rather than score', async () => {
        const result = await searchConversations(input);
        expect(result.hits.flatMap(row => row.mode === 'indexed' ? [row.hit] : [])).toEqual([hit('two', 30, 0.1), hit('one', 10, 1)]);
        expect(result.machines).toMatchObject([
            { machineId: 'one', status: 'ok', standardSearchEnabled: true },
            { machineId: 'two', status: 'ok', standardSearchEnabled: true },
            { machineId: 'offline', status: 'offline', standardSearchEnabled: false },
        ]);
        expect(rpc.mock.calls.every(([call]) => call.machineId !== 'offline' && call.accountId === 'account')).toBe(true);
    });
    it('drops a late response after query cancellation', async () => {
        const controller = new AbortController();
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status;
            controller.abort();
            return { v: 1, ok: true, hits: [hit('stale', 50)] };
        });
        await expect(searchConversations({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('deduplicates Happier sessions without discarding distinct native conversations', async () => {
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status
                : { v: 1, ok: true, hits: [hit('shared', call.machineId === 'one' ? 20 : 40)] });
        expect((await searchConversations(input)).hits.flatMap(row => row.mode === 'indexed' ? [row.hit] : [])).toEqual([hit('shared', 40)]);
    });
    it('honors standard-search settings and reports a disabled index without scanning', async () => {
        rpc.mockResolvedValue({ ...DEFAULT_MEMORY_SETTINGS, enabled: false,
            conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch, standardSearch: { enabled: false } } });
        const result = await searchConversations({ ...input, machines: [{ id: 'one', online: true }] });
        expect(result).toEqual({ hits: [], machines: [{ machineId: 'one', status: 'disabled-by-settings', standardSearchEnabled: false }] });
    });
    it('retains native source identity and forwards date and paging filters', async () => {
        const native = { type: 'external_transcript', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'pi-local', nativeSessionId: 'native' },
            sourceItemId: 'row-1', createdAtFromMs: 15, createdAtToMs: 15, summary: 'quartz native', score: 0.4 };
        rpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
            ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true, conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['pi'] } } }
            : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status : { v: 1, ok: true, hits: [native], hasMore: true, nextCursor: 'next' });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], query: { ...input.query,
            corpora: ['external_transcripts'], createdAfterMs: 10, createdBeforeMs: 20, cursor: 'page' } });
        expect(result.hits).toEqual([{ machineId: 'one', mode: 'indexed', hit: native }]);
        expect(result.continuations).toEqual([{ machineId: 'one', cursor: 'next' }]);
        expect(result.machines[0].status).toBe('partial');
        expect(rpc.mock.calls.find(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0].payload)
            .toMatchObject({ corpora: ['external_transcripts'], createdAfterMs: 10, createdBeforeMs: 20, cursor: 'page' });
    });
});
