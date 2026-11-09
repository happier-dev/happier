import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { preflightWorkspaceDestinationReplacement } from './sessionHandoffs';

const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

describe('session handoff UI request client', () => {
    it.each([undefined, 'owned-handoff-request'])('admits an uncancelled handoff with its transport operation identity (%s)', async actionRequestId => {
        // The remote coordinator requires a transport request id as its operation id;
        // a same-named semantic payload field does not populate RPC context.
        machineRpc.mockImplementationOnce(async request => request.requestId ? {
            ok: true,
            handoffId: request.requestId,
            status: { handoffId: request.requestId, status: 'completed', phase: 'finalizing', recoveryActions: [] },
            workspace: { kind: 'none' },
        } : { ok: false, errorCode: 'invalid_input', error: 'invalid_input' });
        const { startSessionHandoff } = await import('./sessionHandoffs');
        const result = await startSessionHandoff({ sourceMachineId: 'source-1', sessionId: 'session-1',
            targetMachineId: 'target-1', serverId: 'srv_fx14_owned', workspaceAction: { kind: 'none' },
            ...(actionRequestId ? { actionRequestId } : {}) });
        expect(result).toMatchObject({ ok: true, result: { handoffId: actionRequestId ?? expect.any(String) } });
    });

    it.each(['returned', 'thrown'] as const)('preserves the target preflight refusal and repair reason (%s)', async mode => {
        const refusal = { errorCode: 'workspace_root_unsafe', error: 'Workspace target parent cannot be inspected' };
        if (mode === 'returned') machineRpc.mockResolvedValueOnce(refusal);
        else machineRpc.mockRejectedValueOnce(Object.assign(new Error(refusal.error), { rpcErrorCode: refusal.errorCode }));
        await expect(preflightWorkspaceDestinationReplacement({ serverId: 'srv_fx14_owned', targetMachineId: 'target-1',
            targetPath: '/worker/copies/project', operationId: 'create-worker', workspaceAction: { kind: 'none' },
            destinationIntent: 'materialize_from_source_workspace' })).resolves.toEqual({
            type: 'error', result: { ok: false, ...refusal },
        });
    });

    it.each(['cancelled', 'unsupported', 'malformed'] as const)('distinguishes preflight %s from an unreachable target', async failure => {
        const abort = new AbortController();
        if (failure === 'cancelled') {
            abort.abort();
            machineRpc.mockRejectedValueOnce(new Error('Request cancelled'));
        } else if (failure === 'unsupported') {
            machineRpc.mockRejectedValueOnce(Object.assign(new Error('Method not found'), { rpcErrorCode: 'RPC_METHOD_NOT_FOUND' }));
        } else machineRpc.mockResolvedValueOnce({ type: 'not_required', unexpected: true });
        await expect(preflightWorkspaceDestinationReplacement({ serverId: 'srv_fx14_owned', targetMachineId: 'target-1',
            targetPath: '/worker/project', operationId: 'create-worker', workspaceAction: { kind: 'none' },
            destinationIntent: 'materialize_from_source_workspace', signal: abort.signal })).resolves.toMatchObject({
            type: 'error', result: { ok: false, errorCode: failure === 'unsupported' ? 'workspace_sync_update_required'
                : failure === 'malformed' ? 'invalid_response' : 'cancelled' },
        });
    });

    it('keeps the no-copy policy on the source coordinator request', async () => {
        machineRpc.mockResolvedValue({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Missing native history' });
        const { startSessionHandoff } = await import('./sessionHandoffs');
        await expect(startSessionHandoff({ sourceMachineId: 'source-1', sessionId: 'session-1', targetMachineId: 'target-1', serverId: 'srv_fx14_owned', stateTransfer: 'existing', workspaceAction: { kind: 'none' } })).resolves.toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ stateTransfer: 'existing' }) }));
    });
    beforeEach(async () => {
        machineRpc.mockReset();
        const serverUrl = 'https://fx14-owned.example.test';
        const profile = await upsertServerProfile({ serverUrl, name: 'Owned Home' });
        await setServerProfileIdentityForUrl(serverUrl, 'srv_fx14_owned');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, { token })).toBe(true);
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            // The Action Machine is read by id through the Machine rows reader (a532f4a1e0).
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, id => (
                id === 'source-1' ? createPlainMachineRowFixture({ id, accountId: 'owner' }) : null));
            throw new Error(`Unexpected boundary: ${path}`);
        });
    });
    afterEach(resetRuntimeFetch);

    it('sends one coordinator request and returns its terminal result without client phase work', async () => {
        const policyFields = {
            v: 1 as const,
            selection: 'git_worktree' as const,
            extraIgnorePatterns: [],
            extraIncludePatterns: [],
        };
        machineRpc.mockResolvedValueOnce({
            ok: true,
            handoffId: 'handoff-1',
            status: { handoffId: 'handoff-1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            workspace: { kind: 'relationship', relationshipId: 'relationship-1', created: true },
        });
        const { startSessionHandoff } = await import('./sessionHandoffs');
        await expect(startSessionHandoff({
            sourceMachineId: 'source-1',
            sessionId: 'session-1',
            targetMachineId: 'target-1',
            serverId: 'srv_fx14_owned',
            workspaceAction: {
                kind: 'create_relationship',
                mode: 'keep_synced',
                contentPolicy: {
                    ...policyFields,
                    policyDigest: computeWorkspaceSyncPolicyDigest(policyFields),
                },
                flushBeforeCommit: true,
            },
            actionRequestId: 'handoff-action-1',
            handoffTargetReplacementApproval: {
                v: 1,
                consequences: ['replace_nonempty_workspace_target'],
                serverId: 'srv_fx14_owned',
                machineId: 'target-1',
                canonicalRoot: '/target/repo',
                rootFingerprint: 'a'.repeat(64),
                operationId: 'handoff-action-1',
            },
            handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1',
            handoffTargetReplacementApprovalActionInput: {
                sessionId: 'session-1',
                targetMachineId: 'target-1',
                targetPath: '/target/repo',
            },
        })).resolves.toMatchObject({ ok: true, result: { handoffId: 'handoff-1' } });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'source-1',
            method: 'daemon.sessionHandoff.start.v3',
            serverId: 'srv_fx14_owned',
            payload: expect.objectContaining({
                sessionId: 'session-1',
                targetMachineId: 'target-1',
                accountServerId: 'srv_fx14_owned',
                workspaceAction: expect.objectContaining({
                    kind: 'create_relationship',
                    mode: 'keep_synced',
                }),
                actionRequestId: 'handoff-action-1',
                handoffTargetReplacementApproval: expect.objectContaining({ operationId: 'handoff-action-1' }),
                handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1',
                handoffTargetReplacementApprovalActionInput: {
                    sessionId: 'session-1',
                    targetMachineId: 'target-1',
                    targetPath: '/target/repo',
                },
            }),
        }));
        // Source transcript storage is the source daemon's own derivation, made
        // from owner metadata before any stop or export. The client sends no
        // competing answer for it to agree with.
        expect(machineRpc.mock.calls[0]?.[0]?.payload).not.toHaveProperty('sessionStorageMode');
    });

    it('exposes typed status and cancellation requests as thin owner commands', async () => {
        machineRpc
            .mockResolvedValueOnce({ status: { handoffId: 'handoff-1', status: 'awaiting_recovery', phase: 'finalizing', recoveryActions: [] } })
            .mockResolvedValueOnce({ status: { handoffId: 'handoff-1', status: 'aborted', phase: 'finalizing', recoveryActions: [] } });
        const { getSessionHandoffStatus, cancelSessionHandoff } = await import('./sessionHandoffs');
        await expect(getSessionHandoffStatus({ machineId: 'target-1', handoffId: 'handoff-1', serverId: 'srv_fx14_owned' })).resolves.toMatchObject({ ok: true, status: { status: 'awaiting_recovery' } });
        await expect(cancelSessionHandoff({ machineId: 'target-1', handoffId: 'handoff-1', serverId: 'srv_fx14_owned' })).resolves.toMatchObject({ ok: true, status: { status: 'aborted' } });
        expect(machineRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'daemon.sessionHandoff.status.get.v3', payload: { handoffId: 'handoff-1' } }));
        expect(machineRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'daemon.sessionHandoff.abort.v3', payload: { handoffId: 'handoff-1', reason: 'user_cancelled' } }));
    });

    it('canonicalizes a valid predecessor start response to an explicit none workspace outcome', async () => {
        machineRpc.mockResolvedValueOnce({
            handoffId: 'handoff-legacy',
            targetPath: '/target/workspace',
            endpointCandidates: [],
            status: {
                handoffId: 'handoff-legacy',
                sessionId: 'session-1',
                sourceMachineId: 'source-1',
                targetMachineId: 'target-1',
                status: 'completed',
                phase: 'finalizing',
                transportStrategy: 'server_routed_stream',
                recoveryActions: [],
            },
        });
        const { startSessionHandoff } = await import('./sessionHandoffs');

        await expect(startSessionHandoff({
            sourceMachineId: 'source-1',
            sessionId: 'session-1',
            targetMachineId: 'target-1',
            serverId: 'srv_fx14_owned',
            workspaceAction: { kind: 'none' },
        })).resolves.toMatchObject({
            ok: true,
            result: { workspace: { kind: 'none' } },
        });
    });

    it('requires an update when a predecessor response cannot report a requested workspace outcome', async () => {
        machineRpc.mockResolvedValueOnce({
            handoffId: 'handoff-legacy',
            targetPath: '/target/workspace',
            endpointCandidates: [],
            status: {
                handoffId: 'handoff-legacy',
                sessionId: 'session-1',
                sourceMachineId: 'source-1',
                targetMachineId: 'target-1',
                status: 'completed',
                phase: 'finalizing',
                transportStrategy: 'server_routed_stream',
                recoveryActions: [],
            },
        });
        const { startSessionHandoff } = await import('./sessionHandoffs');

        await expect(startSessionHandoff({
            sourceMachineId: 'source-1',
            sessionId: 'session-1',
            targetMachineId: 'target-1',
            serverId: 'srv_fx14_owned',
            workspaceAction: {
                kind: 'relationship',
                relationshipId: 'relationship-1',
                flushBeforeCommit: true,
            },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'workspace_sync_update_required',
        });
    });

    it('returns the typed update requirement when an older source daemon lacks the current workspace handoff method', async () => {
        machineRpc.mockRejectedValueOnce(Object.assign(
            new Error('RPC method not available'),
            { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        ));
        const { startSessionHandoff } = await import('./sessionHandoffs');

        await expect(startSessionHandoff({
            sourceMachineId: 'source-1',
            sessionId: 'session-1',
            targetMachineId: 'target-1',
            serverId: 'srv_fx14_owned',
            workspaceAction: {
                kind: 'relationship',
                relationshipId: 'relationship-1',
                flushBeforeCommit: true,
            },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'workspace_sync_update_required',
        });
    });

    it('does not reinterpret a missing handoff method as workspace skew when no workspace operation was requested', async () => {
        machineRpc.mockRejectedValueOnce(Object.assign(
            new Error('RPC method not available'),
            { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        ));
        const { startSessionHandoff } = await import('./sessionHandoffs');

        await expect(startSessionHandoff({
            sourceMachineId: 'source-1',
            sessionId: 'session-1',
            targetMachineId: 'target-1',
            serverId: 'srv_fx14_owned',
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        });
    });

    it('reports the existing-state update requirement without retrying as transfer on an older source daemon', async () => {
        machineRpc.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { startSessionHandoff } = await import('./sessionHandoffs');
        await expect(startSessionHandoff({ sourceMachineId: 'source-1', sessionId: 'session-1', targetMachineId: 'target-1', serverId: 'srv_fx14_owned', stateTransfer: 'existing', workspaceAction: { kind: 'none' } })).resolves.toMatchObject({ ok: false, errorCode: 'handoff_existing_state_update_required' });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        expect(machineRpc.mock.calls[0]?.[0]?.payload.stateTransfer).toBe('existing');
    });
});
