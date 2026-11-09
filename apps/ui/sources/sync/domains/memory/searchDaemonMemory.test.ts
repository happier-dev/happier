import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { MemorySearchQueryV1Schema, MemorySearchResultV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES} from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE } from '@/sync/runtime/sessionMachineRpcErrorCodes';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
// Only HTTP, credentials and Socket acknowledgements are substituted.
const network = await installSessionOpsNetworkBoundary();
// Load the real Sync graph after its transport boundary, outside individual behavior budgets.
await import('./searchDaemonMemory');
const reply = vi.fn<(request: SessionOpsRpcRequest) => Promise<unknown>>();
let home: Awaited<ReturnType<typeof network.addHome>>;
afterAll(() => network.dispose());

describe('searchDaemonMemory', () => {
    const query = {
        serverId: '', accountId: 'account-a', machineId: 'machine-a',
        query: 'fact', scope: { type: 'global' as const }, mode: 'auto' as const,
    };
    const status = MemoryStatusV1Schema.parse({
        v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
        deepIndexReady: true, activeIndexReady: true, embeddingsEnabled: false,
        embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
        embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
        tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
    });
    const transcriptHit = {
        sessionId: 'session-1', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
        summary: 'A matching past Session', score: 0.5,
    };
    const documentHit = {
        type: 'artifact', ref: { kind: 'doc' as const, serverId: '', artifactId: 'doc-1' },
        revision: { headerVersion: 1, bodyVersion: 2 }, location: 'archive', factId: 'fact-1',
        summary: 'A matching archived fact', score: 0.8,
    };


    beforeEach(async () => {
        network.resetRequests();
        reply.mockReset();
        home = await network.addHome('https://memory-daemon.test', query.accountId);
        query.serverId = home.id;
        documentHit.ref.serverId = home.id;
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return null;
        });
        network.setRpcAckResponder(async request => {
            // These are the actual network address and authenticated Account, not an internal call transcript.
            expect(request).toMatchObject({ serverUrl: home.serverUrl, token: home.token, targetId: query.machineId });
            if (request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) MemorySearchQueryV1Schema.parse(request.payload);
            try {
                return { ok: true, result: await reply(request) };
            } catch (error) {
                const errorCode = readRpcErrorCode(error);
                return { ok: false, error: error instanceof Error ? error.message : String(error),
                    ...(errorCode ? { errorCode } : {}) };
            }
        });
    });

    it('negotiates Project support on the selected daemon and never falls back to a global query', async () => {
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const scope = { type: 'project' as const, projectRef: { serverId: home.id, projectKey: 'payments' } };
        reply.mockResolvedValueOnce(status);
        expect(await searchDaemonMemory({ ...query, scope })).toMatchObject({ ok: false, errorCode: 'memory_project_scope_unsupported' });
        expect(reply.mock.calls.map(([request]) => request.method)).toEqual([RPC_METHODS.DAEMON_MEMORY_STATUS]);
        reply.mockReset();
        reply.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, projectSearchSupported: true, documentSearchSupported: true }
            : { v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' }, project: { state: 'partial' } });
        expect(await searchDaemonMemory({ ...query, scope, corpora: ['sessions', 'documents'] })).toMatchObject({
            ok: true, hits: [documentHit], project: { state: 'partial' },
        });
        expect(reply.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0].payload)
            .toMatchObject({ scope });
    });

    it('reads scoped preparation and exact-revision fact coverage, with old peers explicitly unavailable', async () => {
        const { fetchDaemonMemoryDocumentSummary } = await import('./fetchDaemonMemoryStatus');
        const args = { ...query, ref: documentHit.ref, revision: documentHit.revision, scope: { type: 'session' as const, sessionId: 'session-1' } };
        reply.mockResolvedValueOnce({ ...status, documents: { state: 'ready', facts: [
            { ref: documentHit.ref, revision: documentHit.revision, loadedFactCount: 1, indexedFactCount: 5 },
        ] } });
        expect(await fetchDaemonMemoryDocumentSummary(args)).toEqual({ state: 'ready', loadedFactCount: 1, indexedFactCount: 5 });
        expect(reply.mock.calls[0]?.[0]).toMatchObject({
            serverUrl: home.serverUrl, token: home.token, targetId: 'machine-a',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { scope: args.scope },
        });
        reply.mockResolvedValueOnce(status);
        expect(await fetchDaemonMemoryDocumentSummary(args)).toEqual({ state: 'unavailable' });
        reply.mockResolvedValueOnce({ ...status, documents: { state: 'ready', facts: [
            { ref: documentHit.ref, revision: { headerVersion: 1, bodyVersion: 3 }, loadedFactCount: 2, indexedFactCount: 6 },
        ] } });
        expect(await fetchDaemonMemoryDocumentSummary(args)).toEqual({ state: 'pending' });
        reply.mockResolvedValueOnce({ ...status, documents: { state: 'pending' } });
        expect(await fetchDaemonMemoryDocumentSummary(args)).toEqual({ state: 'pending' });
        reply.mockResolvedValueOnce({ ...status, documents: { state: 'unavailable' } });
        expect(await fetchDaemonMemoryDocumentSummary(args)).toEqual({ state: 'unavailable' });
        reply.mockResolvedValueOnce({ ...status, documents: { state: 'ready', facts: [
            { ref: documentHit.ref, revision: documentHit.revision, indexedFactCount: 5 },
        ] } });
        expect(await fetchDaemonMemoryDocumentSummary({ ...args, scope: { type: 'global' } }))
            .toEqual({ state: 'ready', indexedFactCount: 5 });
    });

    it('negotiates document support at the exact Account target before requesting mixed corpora', async () => {
        reply.mockResolvedValueOnce({ ...status, documentSearchSupported: true });
        reply.mockResolvedValueOnce({
            v: 1, ok: true, hits: [documentHit, transcriptHit], documents: { state: 'ready' },
        });
        const controller = new AbortController();
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            ...query, corpora: ['documents', 'sessions'], eligibleSessionIds: [], signal: controller.signal,
        });
        expect(reply.mock.calls[0]?.[0]).toMatchObject({
            serverUrl: home.serverUrl, token: home.token, targetId: 'machine-a',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });
        expect(reply.mock.calls[1]?.[0]).toMatchObject({
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: { corpora: ['documents', 'sessions'] },
        });
        expect(result).toEqual({ v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' } });
        expect(MemorySearchResultV1Schema.parse(result)).toEqual(result);
    });

    it('waits for admitted document status and global search beyond the default transport deadline', async () => {
        const statusIssued = createDeferred<void>();
        const statusResponse = createDeferred<unknown>();
        const searchIssued = createDeferred<void>();
        const searchResponse = createDeferred<unknown>();
        const supportedStatus = { ...status, documentSearchSupported: true };
        const result = { v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' } };
        reply.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) {
                statusIssued.resolve();
                return statusResponse.promise;
            }
            searchIssued.resolve();
            return searchResponse.promise;
        });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const controller = new AbortController();
        vi.useFakeTimers();
        let settled = false;
        const outcome = searchDaemonMemory({ ...query, corpora: ['documents', 'sessions'], signal: controller.signal })
            .then(value => ({ value }), error => ({ error }));
        void outcome.then(() => { settled = true; });
        try {
            await waitForHomeGovernance(() => expect(reply.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_MEMORY_STATUS)).toBe(true));
            await statusIssued.promise;
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
            expect(settled).toBe(false);
            statusResponse.resolve(supportedStatus);
            await waitForHomeGovernance(() => expect(reply.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(true));
            await searchIssued.promise;
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
            expect(settled).toBe(false);
            searchResponse.resolve(result);
            expect(await outcome).toEqual({ value: result });
        } finally {
            controller.abort();
            statusResponse.resolve(supportedStatus);
            searchResponse.resolve(result);
            await outcome;
            vi.useRealTimers();
        }
    });

    it('preserves old-peer transcripts and reports unavailable documents without sending an ignorable corpus field', async () => {
        reply.mockResolvedValueOnce(status);
        reply.mockResolvedValueOnce({ v: 1, ok: true, hits: [transcriptHit] });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] });
        expect(reply.mock.calls[1]?.[0].payload).not.toHaveProperty('corpora');
        expect(result).toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
    });

    it('never replaces an unsupported documents-only request with transcript search', async () => {
        reply.mockResolvedValueOnce(status);
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({ ...query, corpora: ['documents'] });
        expect(reply.mock.calls.map(([call]) => call.method))
            .toEqual([RPC_METHODS.DAEMON_MEMORY_STATUS]);
        expect(result).toEqual({ v: 1, ok: true, hits: [], documents: { state: 'unavailable' } });
    });

    it('does not label a document-capable peer transcript-only response as complete', async () => {
        reply.mockResolvedValueOnce({ ...status, documentSearchSupported: true });
        reply.mockResolvedValueOnce({ v: 1, ok: true, hits: [transcriptHit] });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        expect(await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
    });

    it('cancels after a capability probe without submitting the search', async () => {
        const controller = new AbortController();
        reply.mockImplementationOnce(async () => {
            controller.abort();
            return { ...status, documentSearchSupported: true };
        });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({ ...query, corpora: ['documents'], signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(reply.mock.calls.map(([call]) => call.method))
            .toEqual([RPC_METHODS.DAEMON_MEMORY_STATUS]);
    });

    it('treats a missing old-peer status method as document unavailability while keeping Session search', async () => {
        reply.mockImplementation(async request => {
            // The real transport retries a missing method after refreshing its binding.
            if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) throw Object.assign(new Error('No status method'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            });
            return { v: 1, ok: true, hits: [transcriptHit] };
        });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        expect(await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
        expect(network.requests.find(request => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.payload)
            .not.toHaveProperty('corpora');
    });
    it('calls daemon memory search through server-scoped machine RPC and parses hits', async () => {
        reply.mockResolvedValueOnce({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-1',
                seqFrom: 2,
                seqTo: 4,
                createdAtFromMs: 10,
                createdAtToMs: 20,
                summary: 'Vector cache summary',
                score: 0.72,
            }],
        });

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: home.id,
            accountId: 'account-a',
            machineId: 'machine-a',
            query: ' vector cache ',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 20,
            timeoutMs: 1500,
        });
        const remainingBudget = network.requests.find(request => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.timeoutMs;
        expect(remainingBudget).toBeGreaterThan(0);
        expect(remainingBudget).toBeLessThanOrEqual(1500);

        expect(network.requests).toContainEqual({
            serverUrl: home.serverUrl,
            token: home.token,
            targetId: 'machine-a',
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: {
                v: 1,
                query: 'vector cache',
                scope: { type: 'global' },
                mode: 'auto',
                maxResults: 20,
            },
            timeoutMs: expect.any(Number),
        });
        expect(result).toEqual({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-1',
                seqFrom: 2,
                seqTo: 4,
                createdAtFromMs: 10,
                createdAtToMs: 20,
                summary: 'Vector cache summary',
                score: 0.72,
            }],
        });
    });

    it('normalizes an affirmed missing daemon search method into a non-fatal result', async () => {
        reply.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        }));

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: home.id,
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(result).toMatchObject({
            v: 1,
            ok: false,
            errorCode: 'memory_index_missing',
        });
    });

    it('preserves temporary search routing failures for retry', async () => {
        reply.mockRejectedValue(Object.assign(new Error('Discovery failed'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory(query)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    });

    it('preserves a temporary document-support probe failure without downgrading the requested corpora', async () => {
        reply.mockRejectedValue(Object.assign(new Error('Discovery failed'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        expect(network.requests.some(request => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toBe(false);
        reply.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS
            ? { ...status, documentSearchSupported: true }
            : { v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' } });
        await expect(searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .resolves.toMatchObject({ ok: true, hits: [documentHit], documents: { state: 'ready' } });
        expect(network.requests.find(request => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.payload)
            .toMatchObject({ corpora: ['sessions', 'documents'] });
    });

    it.each(['read', 'write'] as const)('keeps memory settings %s retryable until the method is affirmed missing', async operation => {
        const { fetchDaemonMemorySettings, writeDaemonMemorySettings } = await import('./fetchDaemonMemorySettings');
        const { DEFAULT_MEMORY_SETTINGS } = await import('@happier-dev/protocol/memory/memorySettings');
        const invoke = () => operation === 'read' ? fetchDaemonMemorySettings(query)
            : writeDaemonMemorySettings({ ...query, settings: DEFAULT_MEMORY_SETTINGS });
        reply.mockRejectedValue(Object.assign(new Error('Discovery failed'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        await expect(invoke()).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        reply.mockRejectedValue(Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }));
        await expect(invoke()).resolves.toEqual({ supported: false, settings: DEFAULT_MEMORY_SETTINGS });
    });

    it('preserves machine-target unavailability as a transport/reachability outcome', async () => {
        const unavailable = Object.assign(new Error('Machine target is offline'), {
            rpcErrorCode: SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE,
        });
        reply.mockRejectedValueOnce(unavailable);

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({
            serverId: home.id,
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        })).rejects.toMatchObject({ rpcErrorCode: SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE });
    });

    it('sends contextual Session eligibility and rejects unfiltered legacy hits', async () => {
        reply.mockResolvedValueOnce({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'active-session',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Legacy daemon ignored eligibility',
                score: 1,
            }, {
                sessionId: 'archived-session',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Eligible archived result',
                score: 0.9,
            }],
        });

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: home.id,
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            eligibleSessionIds: ['archived-session'],
            maxResults: 20,
        });

        expect(reply).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ eligibleSessionIds: ['archived-session'] }),
        }));
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: 'archived-session' })],
        }));
    });

    it('cancels an issued search through the real machine RPC rather than publishing its late response', async () => {
        const issued = createDeferred<void>();
        const response = createDeferred<unknown>();
        reply.mockImplementationOnce(async () => { issued.resolve(); return response.promise; });
        const controller = new AbortController();
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        vi.useFakeTimers();
        const pending = searchDaemonMemory({ ...query, signal: controller.signal });
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        try {
            await waitForHomeGovernance(() => expect(reply).toHaveBeenCalledOnce());
            await issued.promise;
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
            controller.abort();
            expect(await outcome).toMatchObject({ error: { name: 'AbortError' } });
        } finally {
            response.resolve({ v: 1, ok: true, hits: [transcriptHit] });
            await outcome;
            vi.useRealTimers();
        }
    });

    it('reports an already-aborted request without issuing a machine RPC', async () => {
        const controller = new AbortController();
        controller.abort();

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({
            serverId: home.id,
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(reply).not.toHaveBeenCalled();
    });
});
