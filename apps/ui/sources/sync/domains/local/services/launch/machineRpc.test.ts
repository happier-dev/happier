import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

const snapshot = {
    v: 1 as const,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [],
};

const startResponse = {
    protocolVersion: 1 as const,
    machineId: 'machine_1',
    targetId: 'target_1',
    status: 'succeeded' as const,
    snapshot: {
        ...snapshot,
        updatedAt: 2_000,
        targets: [{
            id: 'target_1',
            source: 'managed_service' as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            title: 'Managed preview',
            confidence: 'medium' as const,
            state: 'starting' as const,
            actions: [],
        }],
    },
};

describe('local service launcher machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('fetches daemon-owned launcher snapshots through machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, snapshot });
        const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, snapshot });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            payload: { machineId: 'machine_1', sessionId: 'session_1' },
        });
    });

    it('fails closed for unavailable and mismatched daemon launcher responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                snapshot: { ...snapshot, machineId: 'machine_2' },
            });
        const { fetchLocalServiceLauncherSnapshotViaMachineRpc } = await import('./machineRpc');

        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(fetchLocalServiceLauncherSnapshotViaMachineRpc({
            machineId: 'machine_1',
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });

    it('starts daemon-owned launcher targets through machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(startResponse);
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');

        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            targetId: 'target_1',
            sessionId: 'session_1',
            workspaceId: 'workspace_1',
        })).resolves.toEqual({ ok: true, response: startResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload: {
                machineId: 'machine_1',
                targetId: 'target_1',
                sessionId: 'session_1',
                workspaceId: 'workspace_1',
            },
        });
    });

    it('opens a launcher preview through the LSV-1 leaf machine RPC method', async () => {
        const openPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'opened' as const,
            targetId: 'target_1',
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(openPreviewResponse);
        const { openLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(openLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            targetId: 'target_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, response: openPreviewResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
            payload: { machineId: 'machine_1', targetId: 'target_1', sessionId: 'session_1' },
        });
    });

    it('registers a launcher preview through the LSV-1 leaf machine RPC method', async () => {
        const registerPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'registered' as const,
            targetId: 'inventory:entry_1',
            previewId: 'preview_1',
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(registerPreviewResponse);
        const { registerLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(registerLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'inventory:entry_1',
        })).resolves.toEqual({ ok: true, response: registerPreviewResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: undefined,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
            payload: { machineId: 'machine_1', targetId: 'inventory:entry_1' },
        });
    });

    it('clears launcher history through the LSV-1 leaf machine RPC method', async () => {
        const historyClearResponse = {
            protocolVersion: 1 as const,
            cleared: 2,
            snapshot,
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(historyClearResponse);
        const { clearLocalServiceLauncherHistoryViaMachineRpc } = await import('./machineRpc');

        await expect(clearLocalServiceLauncherHistoryViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            sessionId: 'session_1',
        })).resolves.toEqual({ ok: true, response: historyClearResponse });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
            payload: { machineId: 'machine_1', sessionId: 'session_1' },
        });
    });

    it('fails launcher leaves closed for unavailable daemon responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        });
        const { openLocalServiceLauncherPreviewViaMachineRpc } = await import('./machineRpc');

        await expect(openLocalServiceLauncherPreviewViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    });

    it('fails closed for unavailable and mismatched daemon launcher start responses', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                error: 'RPC method not available',
            })
            .mockResolvedValueOnce({
                ...startResponse,
                targetId: 'target_2',
            });
        const { startLocalServiceLauncherTargetViaMachineRpc } = await import('./machineRpc');

        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        await expect(startLocalServiceLauncherTargetViaMachineRpc({
            machineId: 'machine_1',
            targetId: 'target_1',
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});
