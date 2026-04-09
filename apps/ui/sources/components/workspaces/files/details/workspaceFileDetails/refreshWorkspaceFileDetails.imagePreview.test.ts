import { describe, expect, it, vi } from 'vitest';

import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'diff --git a/image.png b/image.png\n--- a/image.png\n+++ b/image.png\n@@\n+binary\n',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 10,
}));

const pngBase64 = 'iVBORw0KGgo=';
const workspaceReadFileSpy = vi.fn(async (..._args: any[]) => ({
    ok: true,
    contentBase64: pngBase64,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
    downloadDaemonWorkspaceFileToBase64: (...args: any[]) => workspaceReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 1024 * 1024 },
}));

installWorkspaceFileDetailsCommonModuleMocks();

vi.mock('@/scm/utils/filePresentation', () => ({
    getImageMimeTypeFromPath: () => 'image/png',
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

vi.mock('@/scm/diff/looksLikeUnifiedDiff', () => ({
    looksLikeUnifiedDiff: () => true,
}));

describe('refreshWorkspaceFileDetails (image preview)', () => {
    it('returns binary preview metadata for image files', async () => {
        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'image.png',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
        expect(result.fileContent?.isBinary).toBe(true);
        expect(result.fileContent?.binaryMime).toBe('image/png');
        expect(result.fileContent?.binaryBase64).toBe(pngBase64);
    });
});
