import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: '',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 1024,
}));

const workspaceReadFileSpy = vi.fn(async (..._args: any[]) => ({
    ok: true,
    contentBase64: Buffer.from('hello\nworld\n').toString('base64'),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
    downloadDaemonWorkspaceFileToBase64: (...args: any[]) => workspaceReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 1024 * 1024, filesPreviewReadTimeoutMs: 25 },
}));

installWorkspaceFileDetailsCommonModuleMocks();

vi.mock('@/scm/utils/filePresentation', () => ({
    getImageMimeTypeFromPath: () => null,
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

describe('refreshWorkspaceFileDetails (fallback diff)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a synthesized diff for untracked/added files when backend returns empty diff', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceReadFileSpy.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/new.txt',
            diffMode: 'pending',
            fileEntryKind: 'untracked',
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(result.diffContent).toContain('+hello');
        expect(result.diffContent).toContain('+world');
        expect(machineScmDiffFileSpy).toHaveBeenCalledWith(
            'm1',
            {
                cwd: '/repo',
                path: 'src/new.txt',
                area: 'pending',
            },
            { serverId: 'srv1' },
        );
    });

    it('returns the sha256 hash for editable text content', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceReadFileSpy.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        expect(result.fileContent?.contentHash).toBe(createHash('sha256').update('hello\nworld\n').digest('hex'));
    });

    it('returns a renderable diff when file preview download stalls', async () => {
        vi.useFakeTimers();
        machineScmDiffFileSpy.mockResolvedValueOnce({
            success: true,
            diff: [
                'diff --git a/src/changed.txt b/src/changed.txt',
                '--- a/src/changed.txt',
                '+++ b/src/changed.txt',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                '',
            ].join('\n'),
        });
        workspaceReadFileSpy.mockImplementationOnce(() => new Promise(() => {}));

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const resultPromise = refreshWorkspaceFileDetails({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/changed.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        await vi.advanceTimersByTimeAsync(25);

        await expect(resultPromise).resolves.toMatchObject({
            status: 'ready',
            error: null,
            fileContent: null,
            fileWriteSupported: false,
        });
        await expect(resultPromise).resolves.toHaveProperty('diffContent', expect.stringContaining('+new'));
    });
});
