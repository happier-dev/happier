import { describe, expect, it, vi } from 'vitest';

import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'diff --git a/src/big.txt b/src/big.txt\n--- a/src/big.txt\n+++ b/src/big.txt\n@@\n+big\n',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 11,
}));

const workspaceReadFileSpy = vi.fn(async (..._args: any[]) => ({
    ok: true,
    contentBase64: 'Ymln', // "big"
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
    downloadDaemonWorkspaceFileToBase64: (...args: any[]) => workspaceReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 10 },
}));

installWorkspaceFileDetailsCommonModuleMocks({
    text: () => ({
        t: (key: string) => key,
        tLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    }),
});

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
    getImageMimeTypeFromPath: () => null,
}));

vi.mock('@/scm/diff/fallbackUnifiedDiff', () => ({
    buildAddedFileUnifiedDiff: () => 'diff --git a/src/big.txt b/src/big.txt\n--- a/src/big.txt\n+++ b/src/big.txt\n@@\n+big\n',
    decodeUtf8Base64: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
}));

vi.mock('@/scm/diff/looksLikeUnifiedDiff', () => ({
    looksLikeUnifiedDiff: () => true,
}));

vi.mock('@/scm/diff/extractUnifiedDiffForSingleFile', () => ({
    extractUnifiedDiffForSingleFile: (input: { patch: string }) => input.patch,
}));

describe('refreshWorkspaceFileDetails (stat size limit)', () => {
    it('returns an error without reading when the file is too large to preview', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceStatFileSpy.mockClear();
        workspaceReadFileSpy.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/big.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBe('files.fileTooLargeToPreview');
        expect(result.fileContent).toBeNull();
        expect(result.fileWriteSupported).toBe(false);
        expect(workspaceReadFileSpy).toHaveBeenCalledTimes(0);
    });
});
