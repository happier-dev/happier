import { describe, expect, it, vi } from 'vitest';

import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'diff --git a/src/big.txt b/src/big.txt\n--- a/src/big.txt\n+++ b/src/big.txt\n@@\n+big\n',
}));

const sessionStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 11,
    modifiedMs: 1,
}));

const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: 'Ymln', // "big"
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionStatFile: (...args: any[]) => sessionStatFileSpy(...args),
    sessionReadFile: (...args: any[]) => sessionReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 10 },
}));

vi.mock('@/hooks/session/files/sessionPathState', () => ({
    resolveSessionPathState: () => ({ status: 'ready', sessionPath: '/repo', homeDir: null }),
}));

installSessionFileDetailsCommonModuleMocks({
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

describe('refreshSessionFileDetails (stat size limit)', () => {
    it('returns an error without reading when the file is too large to preview', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionStatFileSpy.mockClear();
        sessionReadFileSpy.mockClear();

        const { refreshSessionFileDetails } = await import('./refreshSessionFileDetails');
        const result = await refreshSessionFileDetails({
            sessionId: 's1',
            filePath: 'src/big.txt',
            diffMode: 'pending',
            sessionPath: '/repo',
            sessionsReady: true,
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBe('files.fileTooLargeToPreview');
        expect(result.fileContent).toBeNull();
        expect(result.fileWriteSupported).toBe(false);
        expect(sessionReadFileSpy).toHaveBeenCalledTimes(0);
    });
});
