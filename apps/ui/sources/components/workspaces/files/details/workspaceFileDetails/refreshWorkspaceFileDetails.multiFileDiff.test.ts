import { describe, expect, it, vi } from 'vitest';

import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@\n+hello\n\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@\n+world\n',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 10,
}));

const workspaceReadFileSpy = vi.fn(async (..._args: any[]) => ({
    ok: true,
    contentBase64: Buffer.from('hello\n').toString('base64'),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
    downloadDaemonWorkspaceFileToBase64: (...args: any[]) => workspaceReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 1024 * 1024 },
}));

installWorkspaceFileDetailsCommonModuleMocks();

vi.mock('@/scm/utils/filePresentation', () => ({
    getImageMimeTypeFromPath: () => null,
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

vi.mock('@/scm/diff/looksLikeUnifiedDiff', () => ({
    looksLikeUnifiedDiff: () => true,
}));

describe('refreshWorkspaceFileDetails (multi-file diff)', () => {
    it('extracts the unified diff for a single file when backend returns a multi-file patch', async () => {
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'b.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/b.txt b/b.txt');
        expect(result.diffContent).not.toContain('diff --git a/a.txt b/a.txt');
    });
});
