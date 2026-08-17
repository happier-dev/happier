import { describe, expect, it, vi } from 'vitest';

import type { UploadConflictStrategy } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';

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

    it('forwards cancellation through collision preflight and leaves no upload plan after it aborts', async () => {
        const controller = new AbortController();
        callDaemonWorkspaceStatFileRpcMock.mockImplementation(async (params: Readonly<{ signal?: AbortSignal | null }>) => {
            expect(params.signal).toBe(controller.signal);
            controller.abort();
            return { success: true, exists: false };
        });

        const { buildUploadEntryPlan } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');
        await expect(buildUploadEntryPlan({
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            destinationDir: 'workspace/files',
            entries: [{
                kind: 'native',
                uri: 'file:///tmp/a.txt',
                name: 'a.txt',
                sizeBytes: 10,
                mimeType: 'text/plain',
                relativePath: 'a.txt',
            }],
            signal: controller.signal,
        })).resolves.toEqual({ ok: false, error: 'Upload canceled' });
    });

    it('returns cancellation without waiting for a pending conflict prompt', async () => {
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValue({ success: true, exists: true });
        const controller = new AbortController();
        let beginConflictPrompt: (() => void) | undefined;
        let receivedSignal: AbortSignal | null | undefined;
        const conflictPromptStarted = new Promise<void>((resolve) => {
            beginConflictPrompt = resolve;
        });
        const { buildUploadEntryPlan } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

        const pending = buildUploadEntryPlan({
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            destinationDir: 'workspace/files',
            entries: [{
                kind: 'native',
                uri: 'file:///tmp/a.txt',
                name: 'a.txt',
                sizeBytes: 10,
                mimeType: 'text/plain',
                relativePath: 'a.txt',
            }],
            onResolveConflicts: (params) => {
                receivedSignal = params.signal;
                beginConflictPrompt?.();
                return new Promise<UploadConflictStrategy>(() => {});
            },
            signal: controller.signal,
        });

        await conflictPromptStarted;
        controller.abort();

        await expect(pending).resolves.toEqual({ ok: false, error: 'Upload canceled' });
        expect(receivedSignal).toBe(controller.signal);
    });
});
