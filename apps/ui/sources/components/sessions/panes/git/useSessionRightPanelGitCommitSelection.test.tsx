import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useSessionRightPanelGitCommitSelection } from './useSessionRightPanelGitCommitSelection';

vi.mock('@/scm/operations/applyBulkFileStageAction', () => ({
    applyBulkFileStageAction: vi.fn(),
}));

vi.mock('@/scm/operations/applyFileStageAction', () => ({
    applyFileStageAction: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            clearSessionProjectScmCommitSelectionPaths: vi.fn(),
            clearSessionProjectScmCommitSelectionPatches: vi.fn(),
        }),
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: vi.fn(),
}));

function scmFile(fullPath: string): ScmFileStatus {
    const parts = fullPath.split('/');
    const fileName = parts.at(-1) || fullPath;
    return {
        fullPath,
        fileName,
        filePath: parts.slice(0, -1).join('/'),
        status: 'modified',
        isIncluded: false,
        linesAdded: 1,
        linesRemoved: 0,
    };
}

describe('useSessionRightPanelGitCommitSelection', () => {
    it('counts only visible changed files for atomic repository selection totals', async () => {
        const visibleFile = scmFile('src/visible.ts');

        const hook = await renderHook(() => useSessionRightPanelGitCommitSelection({
            sessionId: 's1',
            sessionPath: '/tmp/repo',
            scmSnapshot: { capabilities: {} } as any,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['src/visible.ts', 'src/generated/'],
            commitSelectionPatches: [{ path: 'src/hidden-patch/', patch: '@@ hidden @@' } as any],
            changedFiles: [visibleFile],
        }));

        expect(hook.getCurrent().repositorySelectedCount).toBe(1);
    });
});
