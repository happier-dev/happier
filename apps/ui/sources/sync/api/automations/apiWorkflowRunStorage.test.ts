import { afterEach, expect, it, vi } from 'vitest';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { createWorkflowRunAccountStorage } from './apiWorkflowRunStorage';
import type { ServerFetch } from '@/sync/http/client';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

// Public capability discovery and captured HTTP are network boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));
afterEach(() => { runtimeFetch.mockReset(); vi.restoreAllMocks(); });

it('shares only admitted read bytes across invocation transports and leaves cancellation and writes independent', async () => {
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const { createCapturedServerReadTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport');
    const { createServerFetchForActiveServer } = await import('@/sync/http/client');
    const home = await upsertAndActivateServer({ serverUrl: 'https://workflow-storage-sharing.test', scope: 'tab' });
    const profile = getServerProfileById(home.id);
    if (!profile) throw new Error('Expected the activated Home profile');
    const credentials = { token: 'captured-token' };
    const readTransport = createCapturedServerReadTransport({ serverId: home.id, profile, credentials });
    const held = createDeferred<void>();
    let reads = 0;
    let writes = 0;
    runtimeFetch.mockImplementation(async (input, init) => {
        if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
        const operation = JSON.parse(String(init.body));
        if (operation.operation === 'delete') { writes++; return Response.json({ deleted: true }); }
        reads++;
        await held.promise;
        return Response.json({ runs: [], nextCursor: 'opaque+/=cursor' });
    });
    const first = createWorkflowRunAccountStorage({ credentials, serverId: home.id,
        request: createServerFetchForActiveServer(), readTransport, assertCurrent: () => {} });
    const second = createWorkflowRunAccountStorage({ credentials, serverId: home.id,
        request: createServerFetchForActiveServer(), readTransport, assertCurrent: () => {} });
    const controller = new AbortController();
    // Native AbortSignal implementations need not expose this newer convenience method.
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const departed = first.execute({ operation: 'list', request: { projection: 'membership' } },
        { signal: controller.signal }).catch(error => {
            if (error instanceof Error && error.name === 'AbortError') return 'aborted';
            throw error;
        });
    void departed.catch(() => {});
    const live = second.execute({ operation: 'list', request: { projection: 'membership' } });
    try {
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        expect(reads).toBe(1);
        controller.abort();
        held.resolve();
        expect(await departed).toBe('aborted');
        await expect(live).resolves.toEqual({ runs: [], nextCursor: 'opaque+/=cursor' });
        await Promise.all([first.execute({ operation: 'delete', runId: 'one' }), second.execute({ operation: 'delete', runId: 'one' })]);
        expect(writes).toBe(2);
        await second.execute({ operation: 'list', request: { projection: 'membership', cursor: 'opaque+/=cursor' } });
        expect(reads).toBe(2);
    } finally { held.resolve(); await Promise.allSettled([departed, live]); }
});

it('witnesses a Run deletion only after issuing its captured HTTP request', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const response = createDeferred<Response>();
    const request = vi.fn<ServerFetch>((_path, _init, options) => {
        options?.onIssued?.();
        return response.promise;
    });
    let issued = false;
    const owner = createWorkflowAccountRunActionOwner({
        storage: createWorkflowRunAccountStorage({ credentials: { token: 'token' }, serverId: 'captured-home',
            request, assertCurrent: () => {} }),
        definitions: { get: async () => { throw new Error('Deleting history does not open its definition'); } },
        resolveAccountId: async () => 'account-a',
        resolveEncryption: async () => { throw new Error('Deleting history does not open its content'); },
        normalizeAbsolutePath: path => path,
        randomBytes: () => { throw new Error('Deleting history does not generate keys'); },
    });
    const deletion = owner.execute({ actionId: 'workflow.run.delete', input: { runId, expectedRevision: 1 },
        context: { surface: 'ui', authority: 'present_user', onTransportIssued: () => {
            expect(request).toHaveBeenCalledTimes(1);
            issued = true;
        } } });
    await vi.waitFor(() => expect(issued).toBe(true));
    response.resolve(Response.json({ runId, deleted: true }));
    await expect(deletion).resolves.toEqual({ runId, deleted: true });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ operation: 'delete', runId, expectedRevision: 1 });
    const controller = new AbortController();
    controller.abort();
    const onTransportIssued = vi.fn();
    await expect(owner.execute({ actionId: 'workflow.run.delete', input: { runId, expectedRevision: 1 },
        context: { surface: 'ui', authority: 'present_user', signal: controller.signal, onTransportIssued } })).rejects.toThrow();
    expect(onTransportIssued).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
});

it('keeps a received storage failure visible through real Account review transport and recovery', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const rootId = '22222222-2222-4222-8222-222222222222';
    const leafId = '33333333-3333-4333-8333-333333333333';
    const accountId = 'review-owner';
    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'answer',
            document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a',
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!accepted.ok) throw new Error(accepted.error.code);
    const run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, state: 'waiting_for_review', revision: 11 });
    const row = (id: string, root: boolean) => {
        const index = createWorkflowInvocationIndexFixture({ id, runId, sequence: root ? '0' : '1',
            parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0', contentRevision: root ? '0' : '1',
            lifecycle: root ? 'running' : 'waiting_for_review' });
        return { index, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
                sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
            progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'wait', attempt: '0',
                logicalInvocationRecordId: id, invocationPath: { blockId: root ? '$root' : 'answer', scope: [] } },
        })), parentRevision: 11 };
    };
    const held = row(leafId, false);
    const snapshot = { run, checkpointEnvelope: null, resultEnvelope: null,
        keyCensus: { runId, ownerAccountId: accountId, access: 'edit', encryptionMode: 'plain', visibleTeamId: null,
            ownerAccountCurrentness: witness, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] },
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
        })) };
    const storage = createWorkflowRunAccountStorage({ credentials: { token: 'recipient-token' }, serverId: 'captured-home',
        assertCurrent: () => {}, request: async (_path, init) => {
            const input = JSON.parse(String(init?.body));
            if (input.operation === 'get') return Response.json(snapshot);
            if (input.operation === 'invocations.get') return Response.json({ invocation: input.invocationId === rootId ? row(rootId, true) : held });
            if (input.operation === 'invocations.current') return Response.json({ invocation: held, parentRevision: 11 });
            if (input.operation === 'invocations.complete_review') return Response.json({ error: 'storage_unavailable' }, { status: 503 });
            throw new Error(`Unexpected HTTP operation: ${input.operation}`);
        } });
    const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => 'review-recipient',
        resolveEncryption: async () => ({ kind: 'available', witness }),
        definitions: { get: async () => { throw new Error('Frozen review must not read a definition'); } },
        normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain Run is keyless'); } });
    await expect(owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { runId,
        invocation: { recordId: leafId }, expectedContentRevision: '1', mode: 'use_result', value: 'Exact answer' },
        context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' } }))
        .rejects.toMatchObject({ code: 'storage_unavailable', status: 503 });
    expect(held.index).toMatchObject({ lifecycle: 'waiting_for_review', contentRevision: '1' });
});

it('rejects worker publication and unknown operations before any Account request', async () => {
    const request = vi.fn();
    const storage = createWorkflowRunAccountStorage({ credentials: { token: 'token' }, serverId: 'captured-home', request, assertCurrent: () => {} });
    for (const operation of ['admit', 'invocations.recover', 'invocations.fact', 'transition', 'unknown']) {
        await expect(storage.execute({ operation })).rejects.toMatchObject({ code: 'run_access_denied' });
    }
    await expect(storage.execute({ operation: 'get', publisherMachineId: 'machine' })).rejects.toMatchObject({ code: 'run_access_denied' });
    await expect(storage.execute({ operation: 'get' }, { publisherMachineId: 'machine' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(request).not.toHaveBeenCalled();
    expect(runtimeFetch).not.toHaveBeenCalled();
});

it('uses captured ordinary credentials and propagates canonical transport errors', async () => {
    const home = await upsertAndActivateServer({ serverUrl: 'https://workflow-storage-api.test', scope: 'tab' });
    runtimeFetch.mockRejectedValue(new Error('unexpected_capability_probe'));
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'run_not_found' }), { status: 404 }));
    const storage = createWorkflowRunAccountStorage({ credentials: { token: 'captured-token' }, serverId: home.id, request, assertCurrent: () => {} });
    await expect(storage.execute({ operation: 'get', runId: 'run-id' })).rejects.toMatchObject({ code: 'run_not_found', status: 404 });
    expect(request).toHaveBeenCalledWith('/v3/automations/runs/workflow-storage', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ operation: 'get', runId: 'run-id' }),
        headers: { Authorization: 'Bearer captured-token', 'Content-Type': 'application/json' },
    }), { includeAuth: false, recoveryRead: 'unbounded' });
    expect(runtimeFetch).not.toHaveBeenCalled();
});
