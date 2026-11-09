import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import type { MemorySearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemorySearchQueryV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { SearchConversationsResultV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ConversationSearchHit, ConversationSearchResult, ConversationSearchSource } from './searchConversations';
import { createDeferred } from '@/dev/testkit';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Substitute only the serialized daemon response. Account routing, transport,
// memory/source adapters and request/response validation run in production code.
const rpc = vi.fn<(call: { method: string; machineId: string; payload: unknown }) => Promise<unknown>>();
const list = vi.fn();
const requests = installSessionActionRpcBoundary(request => {
    const separator = request.method.indexOf(':');
    const machineId = request.method.slice(0, separator);
    const method = request.method.slice(separator + 1);
    if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
        return list({ ...(request.params as Record<string, unknown>), machineId });
    }
    return rpc({ machineId, method, payload: request.params });
});
await loadSyncSingletonForTests();
const { searchConversations, hasConversationSearchScanFallback, isConversationSearchOnDemandOff, mergeConversationSearchHits } = await import('./searchConversations');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const hit = (sessionId: string, time: number, score = 0.5): MemorySearchHitV1 => ({
    sessionId, seqFrom: 1, seqTo: 2, createdAtFromMs: time, createdAtToMs: time, summary: 'quartz match', score,
});
const input = {
    serverId: 'home', accountId: 'account',
    machines: [{ id: 'one', online: true }, { id: 'two', online: true }, { id: 'offline', online: false }],
    query: { v: 1 as const, query: 'quartz', scope: { type: 'global' as const }, mode: 'auto' as const },
};
const status = { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true,
    activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false, embeddingsMode: 'disabled',
    embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null,
    embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false, tier1DbPath: null, deepDbPath: null,
    tier1DbBytes: null, deepDbBytes: null };
beforeEach(async () => {
    await homes.reset();
    requests.length = 0;
    input.serverId = await homes.addHome({ name: 'Search owner Home', serverUrl: 'https://search-owner.test', accountId: 'account' });
    const machines = input.machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId: 'account' }));
    homes.answer(input.serverId, '/v1/machines', { body: machines });
    for (const machine of machines) homes.answer(input.serverId, `/v1/machines/${machine.id}`, { body: { machine } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://search-owner.test', accountId: 'account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    rpc.mockReset();
    list.mockReset().mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
    rpc.mockImplementation(async (call) => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET
        ? { ...DEFAULT_MEMORY_SETTINGS, enabled: true }
        : call.method === RPC_METHODS.DAEMON_MEMORY_STATUS ? status
            : { v: 1, ok: true, hits: [hit(call.machineId, call.machineId === 'one' ? 10 : 30, call.machineId === 'one' ? 1 : 0.1)] });
});
afterEach(async () => { await connection?.dispose(); connection = undefined; });
describe('conversation search fan-out', () => {
    it('keeps a transient status failure partial without a fallback search while healthy peers return hits', async () => {
        const healthy = rpc.getMockImplementation()!;
        rpc.mockImplementation(async call => {
            if (call.machineId === 'one' && call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) {
                throw Object.assign(new Error('Status transport unavailable'), { rpcErrorCode: 'RPC_REQUEST_TIMEOUT' });
            }
            return healthy(call);
        });
        const result = await searchConversations({ ...input, machines: input.machines.slice(0, 2) });
        expect(result.machines).toMatchObject([
            { machineId: 'one', status: 'partial', standardSearchEnabled: true },
            { machineId: 'two', status: 'ok', standardSearchEnabled: true },
        ]);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)
            .map(([call]) => call.machineId)).toEqual(['two']);
        expect(result.hits).toEqual([{ machineId: 'two', mode: 'indexed', hit: hit('two', 30, 0.1) }]);
    });
    it.each(['ceiling', 'denied', 'unchanged', 'advance'] as const)('admits only arriving Session hits across unrelated peer progress and freshly qualifies changed ranges (%s)', async change => {
        const { searchConversationsForAccount } = await import('@/sync/ops/searchConversations');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        const peer = createDeferred<void>();
        const pages: ConversationSearchResult[] = [];
        let ceiling = 2;
        let denied = false;
        homes.answer(input.serverId, '/v2/sessions/shared', { select: () => denied ? { status: 404, body: { error: 'Session not found' } } : ({ body: {
            session: createPlainSessionWithDisplayRecordFixture({ id: 'shared', seq: ceiling }),
        } }) });
        homes.answer(input.serverId, '/v2/sessions/fresh-session', { body: {
            session: createPlainSessionWithDisplayRecordFixture({ id: 'fresh-session', seq: 2 }),
        } });
        // The batch HTTP fixture composes these same per-target responses.
        // Access projection negotiation may add a query string to later reads.
        const reads = (id: string) => homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === `/v2/sessions/${id}`).length;
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) {
                if (call.machineId === 'two') await peer.promise;
                return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            }
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status;
            return { v: 1, ok: true, hits: call.machineId === 'one' ? [hit('shared', 10)]
                : [change === 'unchanged' ? hit('shared', 10) : { ...hit('shared', 20), seqTo: 3 }, hit('fresh-session', 30)] };
        });
        const pending = searchConversationsForAccount({ query: input.query, machineIds: ['one', 'two'],
            mode: 'indexed', providers: { homeSessions: false, daemonEnabled: true }, accountLifetime: accountLifetime!,
            retryUnreachableMachines: true, source: { agentId: 'acme.archive', sourceKey: 'archive',
                source: { kind: 'archive' }, contentSearch: true }, onProgress: page => pages.push(page) });
        try {
            await vi.waitFor(() => expect(pages.at(-1)?.machines).toContainEqual(expect.objectContaining({ machineId: 'one', status: 'ok' })));
            expect(pages.at(-1)?.hits).toEqual([{ machineId: 'one', mode: 'indexed', hit: hit('shared', 10) }]);
            // This Machine's partial/final status publications carry no new hit.
            expect(reads('shared')).toBe(1);
            if (change === 'ceiling') ceiling = 1;
            else if (change === 'denied') denied = true;
            else if (change === 'advance') ceiling = 3;
            peer.resolve();
            const result = await pending;
            expect(result.hits).toEqual([{ machineId: 'two', mode: 'indexed', hit: hit('fresh-session', 30) },
                ...(change === 'unchanged' ? [{ machineId: 'one', mode: 'indexed', hit: hit('shared', 10) }]
                    : change === 'advance' ? [{ machineId: 'two', mode: 'indexed', hit: { ...hit('shared', 20), seqTo: 3 } }] : [])]);
            expect(reads('shared')).toBe(change === 'unchanged' ? 1 : 2);
            expect(reads('fresh-session')).toBe(1);
        } finally { peer.resolve(); await pending; }
    });
    it('publishes native-only hits without a Session visibility request', async () => {
        const { searchConversationsForAccount } = await import('@/sync/ops/searchConversations');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        const native = { type: 'external_transcript' as const,
            source: { type: 'external_transcript' as const, agentId: 'acme.archive', sourceKey: 'archive', nativeSessionId: 'native-session' },
            sourceItemId: 'native-message', createdAtFromMs: 10, createdAtToMs: 10, summary: 'quartz native match', score: 0.5 };
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true,
                conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                    indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status;
            return { v: 1, ok: true, hits: [native] };
        });
        const pages: ConversationSearchResult[] = [];
        const result = await searchConversationsForAccount({ query: { ...input.query, corpora: ['external_transcripts'] }, machineIds: ['one'],
            mode: 'indexed', providers: { homeSessions: false, daemonEnabled: true }, accountLifetime: accountLifetime!,
            retryUnreachableMachines: true, source: { agentId: 'acme.archive', sourceKey: 'archive',
                source: { kind: 'archive' }, contentSearch: true }, onProgress: page => pages.push(page) });
        expect(result.hits).toEqual([{ machineId: 'one', mode: 'indexed', hit: native }]);
        expect(pages.at(-1)?.hits).toEqual(result.hits);
        expect(homes.requests.filter(request => /\/v2\/sessions\/(?:read-batch|native-session)(?:\?|$)/.test(request.path))).toEqual([]);
    });
    it.each(['cancel', 'retire'] as const)('fences a pending Session admission when the captured operation is %s', async reason => {
        const { searchConversationsForAccount } = await import('@/sync/ops/searchConversations');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        const response = createDeferred<void>();
        homes.answer(input.serverId, '/v2/sessions/one', { respondAfter: response.promise, body: {
            session: createPlainSessionWithDisplayRecordFixture({ id: 'one', seq: 2 }),
        } });
        const controller = new AbortController();
        const pages: ConversationSearchResult[] = [];
        const pending = searchConversationsForAccount({ query: input.query, machineIds: ['one'],
            mode: 'indexed', providers: { homeSessions: false, daemonEnabled: true }, accountLifetime: accountLifetime!,
            retryUnreachableMachines: true, source: { agentId: 'acme.archive', sourceKey: 'archive',
                source: { kind: 'archive' }, contentSearch: true }, signal: controller.signal, onProgress: page => pages.push(page) });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await vi.waitFor(() => expect(homes.requests.some(request => new URL(request.path, request.serverUrl).pathname === '/v2/sessions/one')).toBe(true));
            if (reason === 'cancel') controller.abort();
            else { await connection!.dispose(); connection = undefined; }
            const published = pages.length;
            response.resolve();
            await cancelled;
            expect(pages).toHaveLength(published);
            expect(pages.flatMap(page => page.hits)).toEqual([]);
        } finally { controller.abort(); response.resolve(); await cancelled; }
    });
    it('starts every reachable daemon independently and publishes healthy and offline Machines behind stalled peers', async () => {
        const machines = Array.from({ length: 120 }, (_, index) => ({ id: `fanout-${index}`, online: true }));
        const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId: 'account' }));
        homes.answer(input.serverId, '/v1/machines', { body: rows });
        for (const machine of rows) homes.answer(input.serverId, `/v1/machines/${machine.id}`, { body: { machine } });
        let release!: () => void;
        const stalled = new Promise<void>(resolve => { release = resolve; });
        const blockedIds = new Set(machines.slice(0, 4).map(machine => machine.id));
        const healthy = rpc.getMockImplementation()!;
        rpc.mockImplementation(async call => {
            if (blockedIds.has(call.machineId) && call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) await stalled;
            return healthy(call);
        });
        const pages: ConversationSearchResult[] = [];
        const controller = new AbortController();
        const pending = searchConversations({ ...input,
            machines: [...machines, { id: 'offline', online: false }], signal: controller.signal,
            authorize: async hits => hits.filter(row => row.mode !== 'indexed' || !('sessionId' in row.hit) || row.hit.sessionId !== 'fanout-4'),
            onProgress: page => pages.push(page) });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await vi.waitFor(() => expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET)).toHaveLength(120));
            await vi.waitFor(() => expect(pages.at(-1)?.machines.filter(machine => machine.status === 'ok')).toHaveLength(116));
            expect(pages.at(-1)?.machines).toContainEqual({ machineId: 'offline', status: 'offline' });
            expect(pages.at(-1)?.hits).toHaveLength(115);
            expect(pages.at(-1)?.machines.map(machine => machine.machineId)).toEqual([...machines.slice(4).map(machine => machine.id), 'offline']);
            expect(rpc.mock.calls.some(([call]) => call.machineId === 'offline')).toBe(false);
            controller.abort();
            const published = pages.length;
            release();
            await cancelled;
            expect(pages).toHaveLength(published);
        } finally { controller.abort(); release(); await cancelled; }
    });
    it('reports an unread standard-search setting as unknown through the strict Action result', async () => {
        const healthy = rpc.getMockImplementation()!;
        rpc.mockImplementation(async call => {
            if (call.machineId === 'two' && call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) {
                throw Object.assign(new Error('private transport message'), { rpcErrorCode: 'RPC_REQUEST_TIMEOUT' });
            }
            return healthy(call);
        });
        const result = await searchConversations(input);
        const unread = result.machines.find(machine => machine.machineId === 'two')!;
        expect(unread.status).toBe('partial');
        expect(unread).not.toHaveProperty('standardSearchEnabled');
        expect(isConversationSearchOnDemandOff(result, 'two')).toBe(false);
        expect(hasConversationSearchScanFallback({ hits: [], machines: [unread] })).toBe(false);
        expect(SearchConversationsResultV1Schema.parse(result)).toEqual(result);
        expect(result.machines.find(machine => machine.machineId === 'one')).toMatchObject({ standardSearchEnabled: true });
        expect(JSON.stringify(result)).not.toContain('private transport message');
    });
    it('keeps healthy Machine hits when another Machine loses its RPC outcome', async () => {
        const healthy = rpc.getMockImplementation()!;
        rpc.mockImplementation(async call => {
            if (call.machineId === 'two') throw Object.assign(new Error('private transport message'), {
                rpcErrorCode: 'RPC_OUTCOME_UNKNOWN',
            });
            return healthy(call);
        });
        const result = await searchConversations(input);
        expect(result.hits).toMatchObject([{ machineId: 'one', hit: { sessionId: 'one' } }]);
        expect(result.machines).toMatchObject([
            { machineId: 'one', status: 'ok' },
            { machineId: 'two', status: 'partial' },
            { machineId: 'offline', status: 'offline' },
        ]);
        expect(JSON.stringify(result)).not.toContain('private transport message');
    });
    it('keeps native identity scoped to its Machine and Agent and preserves distinct candidates within the owning source', () => {
        const row = { machineId: 'one', mode: 'standard', agentId: 'codex', sourceKey: 'first', source: { kind: 'codexHome', home: 'user' },
            candidate: { remoteSessionId: 'native', candidateKey: 'first-candidate', updatedAtMs: 10,
                match: { sourceItemId: 'message', snippet: 'quartz', messageIndex: 0 } } } satisfies ConversationSearchHit;
        const second = { ...row, sourceKey: 'second', candidate: { ...row.candidate, candidateKey: 'second-candidate', updatedAtMs: 20 } };
        const otherCandidate = { ...row, candidate: { ...row.candidate, candidateKey: 'different-project-candidate' } };
        expect(mergeConversationSearchHits([row, second, otherCandidate, { ...row, machineId: 'two' }, { ...row, agentId: 'claude' }]))
            .toEqual([row, otherCandidate, { ...row, machineId: 'two' }, { ...row, agentId: 'claude' }]);
        const sources = [row, second].map(value => ({ machineId: value.machineId, agentId: value.agentId,
            sourceKey: value.sourceKey, source: value.source, contentSearch: true }));
        // A continuation may discover the first source's copy after a newer
        // second-source hit was already visible. Configured ownership still wins.
        expect(mergeConversationSearchHits([second, row], sources)).toEqual([row]);
    });
    it('assigns a native conversation to its first source while retaining source continuations and unique conversations', async () => {
        const sources = ['user', 'connectedService'].map(sourceKey => ({ agentId: 'codex', sourceKey,
            source: { kind: 'codexHome' as const, home: sourceKey,
                ...(sourceKey === 'connectedService' ? { connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' } : {}) }, contentSearch: true }));
        list.mockImplementation(async request => ({ ok: true, contentCoverage: 'partial', nextCursor: `${request.source.home}-cursor`,
            candidates: [
                { remoteSessionId: 'same-native-session', candidateKey: `${request.source.home}-candidate`, updatedAtMs: request.source.home === 'user' ? 10 : 20,
                    match: { snippet: 'quartz', sourceItemId: `${request.source.home}-message`, messageIndex: 0 } },
                { remoteSessionId: `${request.source.home}-only`, updatedAtMs: 5,
                    match: { snippet: 'quartz', sourceItemId: 'message', messageIndex: 0 } },
            ] }));
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'standard',
            query: { ...input.query, corpora: ['external_transcripts'] }, readSources: async () => sources,
            authorize: async rows => [...rows].reverse() });
        expect(result.hits).toHaveLength(3);
        expect(result.hits[0]).toMatchObject({ sourceKey: 'user', candidate: { remoteSessionId: 'same-native-session' } });
        expect(result.continuations).toEqual([
            { machineId: 'one', sourceKey: 'user', cursor: 'user-cursor' },
            { machineId: 'one', sourceKey: 'connectedService', cursor: 'connectedService-cursor' },
        ]);
        expect(result.machines).toMatchObject([{ status: 'partial' }]);
    });
    it('still merges an indexed and scanned copy of the same native match in either recency order', () => {
        const indexed = { machineId: 'one', mode: 'indexed', hit: {
            type: 'external_transcript', source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' },
            sourceItemId: 'message', createdAtFromMs: 10, createdAtToMs: 10, summary: 'quartz', score: 1,
        } } satisfies ConversationSearchHit;
        const scanned = { machineId: 'one', mode: 'standard', agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig' },
            candidate: { remoteSessionId: 'native', candidateKey: 'project-native', updatedAtMs: 20,
                match: { sourceItemId: 'message', snippet: 'quartz', messageIndex: 0 } },
        } satisfies ConversationSearchHit;
        expect(mergeConversationSearchHits([indexed, scanned])).toEqual([scanned]);
        const newerIndexed = { ...indexed, hit: { ...indexed.hit, createdAtToMs: 30 } };
        expect(mergeConversationSearchHits([scanned, newerIndexed])).toEqual([newerIndexed]);
    });
    it('keeps a failed source beside a successful source on the same Machine and scopes its Retry', async () => {
        const sources = ['failed', 'healthy'].map(sourceKey => ({ agentId: 'claude', sourceKey,
            source: { kind: 'claudeConfig' as const, configDir: `/native/${sourceKey}` }, contentSearch: true }));
        list.mockImplementation(async request => request.source.configDir === '/native/failed'
            ? { ok: false, errorCode: 'agent_error', retryable: true, error: 'private source path' }
            : { ok: true, candidates: [{ remoteSessionId: 'healthy-hit', updatedAtMs: 1,
                match: { snippet: 'quartz', sourceItemId: 'message', messageIndex: 0 } }], contentCoverage: 'complete' });
        const request = { ...input, machines: [input.machines[0]], mode: 'standard' as const,
            query: { ...input.query, corpora: ['external_transcripts' as const] }, readSources: async () => sources };
        const result = await searchConversations(request);
        expect(result).toMatchObject({ hits: [{ sourceKey: 'healthy' }], failures: [{ machineId: 'one', agentId: 'claude',
            sourceKey: 'failed', errorCode: 'agent_error', retryable: true }], machines: [{ status: 'partial' }] });
        list.mockClear().mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'complete' });
        const retried = await searchConversations({ ...request, retrySource: result.failures![0] });
        expect(retried.failures).toBeUndefined();
        expect(retried.completedStandardSources).toEqual([{ machineId: 'one', agentId: 'claude', sourceKey: 'failed' }]);
        expect(list.mock.calls.map(([call]) => call.source.configDir)).toEqual(['/native/failed']);
    });
    it('publishes indexed Session hits while fresh document admission is pending and retains them on document failure', async () => {
        let releaseDocuments!: () => void;
        const documents = new Promise<void>(resolve => { releaseDocuments = resolve; });
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { ...status, documentSearchSupported: true };
            const query = MemorySearchQueryV1Schema.parse(call.payload);
            if (query.corpora?.includes('documents')) {
                await documents;
                throw new Error('Document admission transport unavailable');
            }
            return { v: 1, ok: true, hits: [hit('known-session', 10)] };
        });
        const onProgress = vi.fn();
        const pending = searchConversations({ ...input, machines: [input.machines[0]],
            query: { ...input.query, corpora: ['sessions', 'documents'] }, onProgress });
        try {
            await vi.waitFor(() => expect(onProgress.mock.calls.some(([page]) => page.hits.some(
                (row: { hit: { sessionId?: string } }) => row.hit.sessionId === 'known-session',
            ))).toBe(true));
            expect(onProgress.mock.calls.at(-1)?.[0].machines).toMatchObject([{ documents: 'pending', status: 'partial' }]);
        } finally { releaseDocuments(); }
        const result = await pending;
        expect(result.hits).toMatchObject([{ hit: { sessionId: 'known-session' } }]);
        expect(result.machines).toMatchObject([{ documents: 'unavailable', status: 'partial' }]);
    });
    it('keeps an explicit native scan reachable when the ready memory index fails', async () => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true,
                conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
                    indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['claude'] } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { ...status, sources: [{
                source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'native' }, state: 'ready',
            }] };
            throw new Error('Memory index read failed');
        });
        list.mockResolvedValue({ ok: true, candidates: [{ remoteSessionId: 'native-session', updatedAtMs: 1,
            match: { snippet: 'amber orchard', sourceItemId: 'message', messageIndex: 0 } }], contentCoverage: 'complete' });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'auto',
            query: { ...input.query, query: 'amber orchard', corpora: ['external_transcripts'] },
            readSources: async () => [{ agentId: 'claude', sourceKey: 'native', source: { kind: 'claudeConfig' }, contentSearch: true }] });
        expect(result.hits).toMatchObject([{ mode: 'standard', agentId: 'claude', candidate: { remoteSessionId: 'native-session' } }]);
        expect(result.sources).toMatchObject([{ indexReady: false }]);
        // A successful native page does not claim the failed index was searched.
        expect(result.machines).toMatchObject([{ machineId: 'one', status: 'partial', standardSearchEnabled: true }]);
    });
    it('issues an explicit retry to an unreachable machine and returns its recovered results', async () => {
        const result = await searchConversations({ ...input, machines: [{ id: 'one', online: false }],
            retryUnreachableMachines: true });
        expect(result.machines).toMatchObject([{ machineId: 'one', status: 'ok' }]);
        expect(result.hits).toMatchObject([{ machineId: 'one', hit: { sessionId: 'one' } }]);
    });
    it('orders asynchronous authorization so an older page cannot overwrite newer progress', async () => {
        let startSecond!: () => void;
        let finishAuthorization!: () => void;
        let authorizationStarted!: () => void;
        const second = new Promise<void>(resolve => { startSecond = resolve; });
        const authorization = new Promise<void>(resolve => { finishAuthorization = resolve; });
        const started = new Promise<void>(resolve => { authorizationStarted = resolve; });
        let secondAnswered = false;
        let firstAuthorization = true;
        const published: number[] = [];
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status;
            if (call.machineId === 'two') { await second; secondAnswered = true; }
            return { v: 1, ok: true, hits: [hit(call.machineId, 10)] };
        });
        const pending = searchConversations({ ...input, machines: input.machines.slice(0, 2),
            authorize: async rows => {
                if (firstAuthorization) { firstAuthorization = false; authorizationStarted(); await authorization; }
                return rows;
            }, onProgress: page => published.push(page.hits.length) });
        try {
            await started;
            startSecond();
            await vi.waitFor(() => expect(secondAnswered).toBe(true));
            expect(published).toEqual([]);
            finishAuthorization();
            await pending;
            expect(published[0]).toBe(1);
            expect(published.at(-1)).toBe(2);
            expect(published).toEqual([...published].sort());
        } finally { startSecond(); finishAuthorization(); await pending; }
    });
    it('publishes authorized results without waiting for a slower machine and fences cancellation', async () => {
        let releaseSlow!: () => void;
        const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
        const controller = new AbortController();
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status;
            if (call.machineId === 'two') await slow;
            return { v: 1, ok: true, hits: [hit(call.machineId, 10), hit('denied', 50)] };
        });
        const onProgress = vi.fn();
        const pending = searchConversations({ ...input, signal: controller.signal, onProgress,
            authorize: async rows => rows.filter(row => row.mode !== 'indexed' || !('sessionId' in row.hit) || row.hit.sessionId !== 'denied') });
        // Attach the rejection handler before cancelling the still-pending operation.
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        try {
            await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
            expect(onProgress.mock.calls.at(-1)?.[0].hits).toEqual([{ machineId: 'one', mode: 'indexed', hit: hit('one', 10) }]);
            controller.abort();
            const publications = onProgress.mock.calls.length;
            releaseSlow();
            await cancelled;
            expect(onProgress).toHaveBeenCalledTimes(publications);
        } finally { controller.abort(); releaseSlow(); await cancelled; }
    });
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
            { machineId: 'offline', status: 'offline' },
        ]);
        expect(requests.every(request => !request.method.startsWith('offline:'))).toBe(true);
        const admissions = homes.requests.filter(request => request.path.startsWith('/v1/machines/'));
        expect(admissions.length).toBeGreaterThan(0);
        expect(admissions.every(request => request.serverId === input.serverId && request.token !== null)).toBe(true);
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
    it('does not report Search on demand off when its settings read fails, and reads the setting again on retry', async () => {
        const source = { agentId: 'claude', sourceKey: 'native', source: { kind: 'claudeConfig' }, contentSearch: true };
        const request = { ...input, machines: [input.machines[0]], mode: 'standard' as const,
            query: { ...input.query, corpora: ['external_transcripts' as const] }, readSources: async () => [source] };
        rpc.mockRejectedValueOnce(new Error('Settings transport unavailable'));
        const unavailable = await searchConversations(request);
        expect(unavailable.machines).toMatchObject([{ status: 'partial' }]);
        expect(isConversationSearchOnDemandOff(unavailable, 'one')).toBe(false);
        expect(list).not.toHaveBeenCalled();

        list.mockResolvedValue({ ok: true, candidates: [{ remoteSessionId: 'native', updatedAtMs: 1,
            match: { snippet: 'quartz', sourceItemId: 'message', messageIndex: 0 } }], contentCoverage: 'complete' });
        const recovered = await searchConversations(request);
        expect(recovered.hits).toMatchObject([{ mode: 'standard', candidate: { remoteSessionId: 'native' } }]);
        expect(recovered.machines).toMatchObject([{ status: 'ok', standardSearchEnabled: true }]);
        expect(isConversationSearchOnDemandOff(recovered, 'one')).toBe(false);
    });
    it.each(['indexing', 'read-failed', 'ready', 'sessions-read-failed'] as const)('reports a positively disabled standard fallback only when the native index needs it (%s)', async state => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true,
                conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch, standardSearch: { enabled: false },
                    indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: ['claude'] } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { ...status, sources: [{
                source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'native' }, state: state === 'indexing' ? 'indexing' : 'ready',
            }] };
            if (state === 'read-failed' || state === 'sessions-read-failed') throw new Error('Index transport unavailable');
            return { v: 1, ok: true, hits: [] };
        });
        const result = await searchConversations({ ...input, machines: [input.machines[0]], mode: 'auto',
            query: { ...input.query, corpora: state === 'sessions-read-failed' ? ['sessions'] : ['external_transcripts'] },
            readSources: async () => [{ agentId: 'claude', sourceKey: 'native', source: { kind: 'claudeConfig' }, contentSearch: true }] });
        const needsBlockedFallback = state === 'indexing' || state === 'read-failed';
        expect(result.machines).toMatchObject([{ status: state === 'ready' ? 'ok' : needsBlockedFallback ? 'disabled-by-settings' : 'partial', standardSearchEnabled: false }]);
        expect(isConversationSearchOnDemandOff(result, 'one')).toBe(needsBlockedFallback);
        expect(list).not.toHaveBeenCalled();
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
    it('publishes a completed source and its continuation while a second source runs', async () => {
        // Loading the real adapter belongs to setup, not the progress assertion.
        await import('@/sync/ops/machineExternalSessions');
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const controller = new AbortController();
        const pages: ConversationSearchResult[] = [];
        rpc.mockImplementation(async call => {
            expect(call.method).toBe(RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET);
            return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
        });
        list.mockImplementation(async (payload: Record<string, unknown>) => {
            if (payload.agentId === 'codex') await slow;
            return { ok: true, candidates: [{ remoteSessionId: payload.agentId, updatedAtMs: 10,
                match: { sourceItemId: 'message', snippet: 'design lab', messageIndex: 0 } }],
                contentCoverage: 'partial', nextCursor: `${String(payload.agentId)}-next` };
        });
        const pending = searchConversations({ serverId: input.serverId, accountId: 'account',
            machines: [{ id: 'one', online: true }], mode: 'standard', signal: controller.signal,
            query: { v: 1, query: 'design lab', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
            readSources: async (): Promise<readonly ConversationSearchSource[]> => [
                { agentId: 'claude', sourceKey: 'claude', source: { kind: 'claudeConfig' as const }, contentSearch: true },
                { agentId: 'codex', sourceKey: 'codex', source: { kind: 'codexHome' as const, home: 'user' as const }, contentSearch: true },
            ], onProgress: page => pages.push(page) });
        try {
            await vi.waitFor(() => expect(pages.some(page => page.hits.length === 1), JSON.stringify({ pages,
                methods: rpc.mock.calls.map(([call]) => call.method) })).toBe(true));
            const first = pages.find(page => page.hits.length === 1)!;
            expect(first.hits[0]).toMatchObject({ mode: 'standard', agentId: 'claude', candidate: { remoteSessionId: 'claude' } });
            expect(first.continuations).toEqual([{ machineId: 'one', sourceKey: 'claude', cursor: 'claude-next' }]);
            expect(first.machines).toMatchObject([{ machineId: 'one', status: 'partial' }]);
            release();
            const final = await pending;
            expect(final.hits).toHaveLength(2);
            // A published page is an immutable snapshot, not the shared work arrays.
            expect(first.hits).toHaveLength(1);
            expect(first.continuations).toHaveLength(1);
        } finally { release(); controller.abort(); await pending.catch(() => undefined); }
    });
});
