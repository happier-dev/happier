import { describe, expect, it, vi } from 'vitest';

import { refreshSessionFileDetails } from './refreshSessionFileDetails';

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: '',
}));

const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: Buffer.from('hello\nworld\n').toString('base64'),
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
    getImageMimeTypeFromPath: () => null,
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

describe('refreshSessionFileDetails (fallback diff)', () => {
    it('returns a synthesized diff for untracked/added files when backend returns empty diff', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionReadFileSpy.mockClear();

        const result = await refreshSessionFileDetails({
            sessionId: 's1',
            filePath: 'src/new.txt',
            diffMode: 'pending',
            sessionPath: '/repo',
            sessionsReady: true,
            fileEntryKind: 'untracked',
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(result.diffContent).toContain('+hello');
        expect(result.diffContent).toContain('+world');
    });
});
