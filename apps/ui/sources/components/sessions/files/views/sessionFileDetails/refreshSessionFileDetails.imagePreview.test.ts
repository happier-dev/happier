import { describe, expect, it, vi } from 'vitest';

import { refreshSessionFileDetails } from './refreshSessionFileDetails';

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'Binary files a/src/image.png and b/src/image.png differ',
}));

const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionReadFile: (...args: any[]) => sessionReadFileSpy(...args),
}));

vi.mock('@/hooks/session/files/sessionPathState', () => ({
    resolveSessionPathState: () => ({ status: 'ready', sessionPath: '/repo', homeDir: null }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => true,
    isKnownBinaryPath: () => true,
    getImageMimeTypeFromPath: (path: string) => (path.endsWith('.png') ? 'image/png' : null),
}));

vi.mock('@/scm/diff/looksLikeUnifiedDiff', () => ({
    looksLikeUnifiedDiff: () => false,
}));

describe('refreshSessionFileDetails (image preview)', () => {
    it('returns an inline image preview payload for known image files', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionReadFileSpy.mockClear();

        const result = await refreshSessionFileDetails({
            sessionId: 's1',
            filePath: 'src/image.png',
            diffMode: 'pending',
            sessionPath: '/repo',
            sessionsReady: true,
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBeNull();
        expect(result.diffContent).toBeNull();
        expect(result.fileContent?.isBinary).toBe(true);
        expect(result.fileContent?.binaryMime).toBe('image/png');
        expect(typeof result.fileContent?.binaryBase64).toBe('string');
        expect(sessionReadFileSpy).toHaveBeenCalledTimes(1);
    });
});
