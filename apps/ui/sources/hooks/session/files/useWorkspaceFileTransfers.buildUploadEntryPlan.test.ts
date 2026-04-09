import { describe, expect, it, vi } from 'vitest';

const callDaemonWorkspaceStatFileRpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: unknown[]) => callDaemonWorkspaceStatFileRpcMock(...args),
}));

describe('buildUploadEntryPlan', () => {
    it('detects duplicate target paths within a single upload batch', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: false });

        const { buildUploadEntryPlan } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        const result = await buildUploadEntryPlan({
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            destinationDir: '',
            entries: [
                {
                    kind: 'native',
                    uri: 'file:///tmp/a.txt',
                    name: 'a.txt',
                    sizeBytes: 10,
                    mimeType: 'text/plain',
                    relativePath: 'a.txt',
                },
                {
                    kind: 'native',
                    uri: 'file:///tmp/other/a.txt',
                    name: 'a.txt',
                    sizeBytes: 20,
                    mimeType: 'text/plain',
                    relativePath: 'a.txt',
                },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const paths = result.tasks.map((t) => t.targetPath);
        expect(new Set(paths).size).toBe(paths.length);
    });
});
