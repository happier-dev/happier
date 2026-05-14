import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('workspaceAnchors ops', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('calls the non-durable workspace anchor resolver over machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            resolutions: [{
                id: 'c1',
                filePath: 'src/index.ts',
                originalAnchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
                resolvedAnchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
                status: 'exact',
                confidence: 1,
            }],
        });

        const { resolveWorkspaceAnchors } = await import('./workspaceAnchors');
        const response = await resolveWorkspaceAnchors({
            machineId: 'm1',
            serverId: 's1',
            workspacePath: '/repo',
            comments: [{
                id: 'c1',
                filePath: 'src/index.ts',
                source: 'file',
                anchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
            }],
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 's1',
            method: RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE,
            payload: expect.objectContaining({ workspacePath: '/repo' }),
        }));
        expect(response.success).toBe(true);
    });

    it('fails closed when the daemon returns an unsupported shape', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        const { resolveWorkspaceAnchors } = await import('./workspaceAnchors');

        const response = await resolveWorkspaceAnchors({
            machineId: 'm1',
            workspacePath: '/repo',
            comments: [],
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: 'UNSUPPORTED_RESPONSE',
        });
    });
});
