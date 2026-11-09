import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DaemonWorkspaceFileReplacePreviewRequestSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Stopping an operation uses its existing policy confirmation. The modal is
// the genuine UI boundary; accept it while leaving Action admission real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// HTTP and Machine RPC are genuine transport boundaries; Account capture,
// requester-context crypto, Action settings, admission and schemas stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: unknown) => rpc.call(request),
}));
const { machineWorkspaceFileReplaceApply, machineWorkspaceFileReplacePreview } = await import('./machineWorkspaceFileReplace');
const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
const hash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const edits = [{ startUtf16: 0, deleteLength: 3, insertText: 'new', originalText: 'old' }];
const input = { rootPath: '/repo', operation: { kind: 'replace' as const,
    matcher: { query: 'old', replacement: 'new', regex: false, matchCase: true },
    files: [{ path: 'a.ts', expectedHash: hash }, { path: 'b.ts', expectedHash: hash }] } };
const receipt = { ok: true as const, results: [{ path: 'a.ts', status: 'replaced' as const, hash: nextHash, matchCount: 1, edits }], cancelled: ['b.ts'] };
let serverId: string;
let requestId: string | undefined;
let admit: () => Promise<unknown>;
let terminal: () => Promise<unknown>;
let cancelled: () => void;

beforeEach(async () => {
    await homes.reset(); rpc.call.mockReset(); requestId = undefined;
    serverId = await homes.addHome({ name: 'Replace Home', serverUrl: 'https://replace-action.test',
        serverIdentityId: 'srv_replace_action', accountId: 'alice', currentAccount: true, active: false });
    admit = async () => ({ operation: { operationId: 'replace-operation' } });
    terminal = async () => ({ kind: 'found', operation: snapshot() });
    cancelled = () => {};
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://replace-action.test',
        serverIdentityId: 'srv_replace_action', accountId: 'alice', machineId: 'machine', actionId: 'workspace.files.replace', tokenEpoch: 0,
        execute: async (request, context) => {
            expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
            expect(isApprovalRequiredByActionsSettings('workspace.files.replace', { v: 1, actions: {} }, context.invocation)).toBe(false);
            expect(request).toEqual({ machineId: 'machine', ...input });
            requestId = context.requestId;
            return await admit();
        },
    });
    homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
    for (const path of ['GET /v1/machines/machine', '/v1/actions/workspace.files.replace/execution-authorization', '/v1/actions/workspace.files.replace']) {
        homes.answer(serverId, path, { select: async (_body, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Unexpected replace request');
            return { status: response.status, body: await response.json() };
        } });
    }
    rpc.call.mockImplementation(async ({ method }: { method: string }) => {
        if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return await terminal();
        if (method === ACTION_OPERATION_RPC_METHODS_V1.cancel) { cancelled(); return { kind: 'requested' }; }
        return receipt;
    });
});
afterEach(async () => { await homes.reset(); });

function snapshot(overrides: Record<string, unknown> = {}) {
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'replace-operation', revision: 3,
        actionId: 'workspace.files.replace', state: 'succeeded', scope: { accountId: 'alice', machineId: 'machine' },
        title: 'Replace', requestId, createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: receipt, ...overrides });
}
const apply = (signal?: AbortSignal, accountId = 'alice') => machineWorkspaceFileReplaceApply('machine', input, { serverId, accountId, signal });

describe('workspace replace admitted Account carrier', () => {
    const previewInput = { rootPath: '/repo', query: 'old', replacement: 'new', regex: false, matchCase: true };
    const previewReceipt = { ok: true, files: [], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' };
    it('keeps replacement preview a no-prompt read by default', async () => {
        rpc.call.mockResolvedValueOnce(previewReceipt);
        expect(await machineWorkspaceFileReplacePreview('machine', previewInput, { serverId, accountId: 'alice' })).toEqual(previewReceipt);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(rpc.call).toHaveBeenCalledTimes(1);
        expect(DaemonWorkspaceFileReplacePreviewRequestSchema.safeParse(rpc.call.mock.lastCall?.[0]?.payload).success).toBe(true);
        expect(rpc.call.mock.lastCall?.[0]?.payload).toEqual(previewInput);
    });

    it('honors an explicit UI Ask override before replacement preview reads the Machine', async () => {
        rpc.call.mockResolvedValueOnce(previewReceipt);
        await homes.requireUiApproval(serverId, 'workspace.files.replace.preview');
        expect(await machineWorkspaceFileReplacePreview('machine', previewInput, { serverId, accountId: 'alice' })).toMatchObject({
            ok: false, errorCode: 'approval_required', details: { kind: 'approval_request_created', actionId: 'workspace.files.replace.preview', artifactId: expect.any(String) },
        });
        expect(rpc.call).not.toHaveBeenCalled();
        expect(homes.artifacts(serverId).list()).toHaveLength(1);
    });

    it('admits the present user and publishes the exact retained receipt after the authenticated UI invocation', async () => {
        const writes: unknown[] = [];
        const unsubscribe = subscribeAcknowledgedWorkspaceFileWrites({ serverId, accountId: 'alice', machineId: 'machine', rootPath: '/repo' }, 'a.ts', write => writes.push(write));
        try {
            expect(await apply()).toEqual(receipt);
            expect(homes.requestsFor('/v1/actions/workspace.files.replace')).toHaveLength(1);
            expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({ method: ACTION_OPERATION_RPC_METHODS_V2.get,
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice', machineId: 'machine', payload: { operationId: 'replace-operation', waitForTerminal: true }, operationTimeoutMs: null }));
            expect(writes).toEqual([{ path: 'a.ts', hash: nextHash }]);
        } finally { unsubscribe(); }
    });

    it('keeps cancellation cooperative during admission and retains completed-file inverse edits', async () => {
        const cancellation = new AbortController();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        admit = async () => { await gate; return { operation: { operationId: 'replace-operation' } }; };
        let didCancel = false;
        cancelled = () => { didCancel = true; };
        terminal = async () => { await waitForHomeGovernance(() => expect(didCancel).toBe(true)); return { kind: 'found', operation: snapshot() }; };
        const result = apply(cancellation.signal);
        await waitForHomeGovernance(() => expect(requestId).toBeTruthy());
        cancellation.abort(); release();
        expect(await result).toEqual(receipt);
        expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({ method: ACTION_OPERATION_RPC_METHODS_V1.cancel,
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), machineId: 'machine', payload: { operationId: 'replace-operation' } }));
    });

    it('rejects a different Account before any replacement reaches the Machine', async () => {
        expect(await apply(undefined, 'bob')).toMatchObject({ ok: false });
        expect(homes.requestsFor('/v1/actions/workspace.files.replace')).toHaveLength(0);
        expect(rpc.call).not.toHaveBeenCalled();
    });

    it('rejects a terminal receipt from a different request instead of publishing its writes', async () => {
        terminal = async () => ({ kind: 'found', operation: snapshot({ requestId: 'other-request' }) });
        expect(await apply()).toMatchObject({ ok: false });
    });

    it('retains an explicit UI Ask policy and its exact rooted approval before dispatch', async () => {
        await homes.requireUiApproval(serverId, 'workspace.files.replace');
        const pending = await apply();
        expect(pending).toMatchObject({ ok: false, errorCode: 'approval_required', details: {
            kind: 'approval_request_created', actionId: 'workspace.files.replace', artifactId: expect.any(String),
        } });
        const artifacts = homes.artifacts(serverId);
        expect(artifacts.list()).toHaveLength(1);
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifacts.list()[0]!.id)!)))
            .toMatchObject({ status: 'open', actionId: 'workspace.files.replace', actionArgs: { machineId: 'machine', ...input } });
        expect(homes.requestsFor('/v1/actions/workspace.files.replace')).toHaveLength(0);
        expect(rpc.call).not.toHaveBeenCalled();
    });

    it('holds agent replacement in canonical approval custody before dispatch', async () => {
        const result = createDefaultActionExecutor().execute('workspace.files.replace', { machineId: 'machine', ...input }, {
            surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'alice', actionRequestId: 'agent-replace',
            externalActionTarget: { kind: 'machine', machineId: 'machine' },
        });
        const artifacts = homes.artifacts(serverId);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({ status: 'open', actionId: 'workspace.files.replace' });
        expect(homes.requestsFor('/v1/actions/workspace.files.replace')).toHaveLength(0);
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' }, { surface: 'ui', serverId })).toMatchObject({ ok: true });
        expect(await result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    });
});
