import { describe, expect, it, vi } from 'vitest';

import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: [
        'diff --git a/src/a.txt b/src/a.txt',
        'index 1111111..2222222 100644',
        '--- a/src/a.txt',
        '+++ b/src/a.txt',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
        'diff --git a/src/new.txt b/src/new.txt',
        'index 3333333..4444444 100644',
        '--- a/src/new.txt',
        '+++ b/src/new.txt',
        '@@ -1,1 +1,1 @@',
        '-before',
        '+after',
        '',
    ].join('\n'),
}));

const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: Buffer.from('hello\nworld\n').toString('base64'),
}));

installSessionFileDetailsCommonModuleMocks();

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionStatFile: vi.fn(async () => ({ success: true, exists: true, kind: 'file', sizeBytes: 1024, modifiedMs: 1 })),
    sessionReadFile: (...args: any[]) => sessionReadFileSpy(...args),
}));

vi.mock('@/hooks/session/files/sessionPathState', () => ({
    resolveSessionPathState: () => ({ status: 'ready', sessionPath: '/repo', homeDir: null }),
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    getImageMimeTypeFromPath: () => null,
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

const { refreshSessionFileDetails } = await import('./refreshSessionFileDetails');

describe('refreshSessionFileDetails (multi-file diff)', () => {
    it('extracts the requested file diff when backend returns a combined patch', async () => {
        sessionScmDiffFileSpy.mockClear();

        const result = await refreshSessionFileDetails({
            sessionId: 's1',
            filePath: 'src/new.txt',
            diffMode: 'pending',
            sessionPath: '/repo',
            sessionsReady: true,
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(result.diffContent).not.toContain('diff --git a/src/a.txt b/src/a.txt');
        expect((String(result.diffContent ?? '').match(/^diff --git /gm) ?? []).length).toBe(1);
    });
});
