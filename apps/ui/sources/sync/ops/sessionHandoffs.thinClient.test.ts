import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

describe('session handoff UI request client', () => {
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
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/machines') return Response.json([{ id: 'source-1', kind: 'persistent', active: true,
                revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
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
            errorCode: 'UNEXPECTED',
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
