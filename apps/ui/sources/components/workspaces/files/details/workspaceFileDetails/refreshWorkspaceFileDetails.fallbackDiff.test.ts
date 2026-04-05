import { describe, expect, it, vi } from 'vitest';

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

vi.mock('@/sync/domains/transfers/runtime/transferSubstrate', () => ({
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

describe('refreshWorkspaceFileDetails (fallback diff)', () => {
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
    });
});
