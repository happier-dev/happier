import { beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { storage } from '@/sync/domains/state/storage';
import type { ScmCommitPlanGroupSelection } from '@/sync/domains/scm/diffSummary/commitPlanSelection';
import { useSessionRightPanelGitCommitSelection } from './useSessionRightPanelGitCommitSelection';

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
    const initialState = storage.getState();
    beforeEach(() => {
        storage.setState(initialState, true);
        storage.getState().applySessions([createSessionFixture({ id: 's1' })]);
        storage.getState().clearSessionProjectScmCommitSelectionPaths('s1');
        storage.getState().clearSessionProjectScmCommitSelectionPatches('s1');
    });
    it('makes every selection mutation read-only while a proposal is projected, then restores ordinary selection', async () => {
        const ordinaryPath = 'src/ordinary.ts';
        const proposedFile = scmFile('src/proposed.ts');
        const ordinaryPatch = { path: 'src/partial.ts', patch: '@@ -1 +1 @@\n-old\n+new\n' };
        storage.getState().markSessionProjectScmCommitSelectionPaths('s1', [ordinaryPath]);
        storage.getState().upsertSessionProjectScmCommitSelectionPatch('s1', ordinaryPatch);
        const retainedPatches = storage.getState().getSessionProjectScmCommitSelectionPatches('s1');
        let proposedGroupSelection: ScmCommitPlanGroupSelection | null = { resultId: 'saved', comparisonId: 'pending', groupId: 'one', changeRefs: ['exact'], paths: [proposedFile.fullPath] };
        const hook = await renderHook(() => useSessionRightPanelGitCommitSelection({
            sessionId: 's1', sessionPath: '/repo', scmSnapshot: null, scmWriteEnabled: true, scmCommitStrategy: 'atomic',
            commitSelectionPaths: storage.getState().getSessionProjectScmCommitSelectionPaths('s1'),
            commitSelectionPatches: storage.getState().getSessionProjectScmCommitSelectionPatches('s1'), changedFiles: [proposedFile], proposedGroupSelection,
        }));
        expect(hook.getCurrent().disableSelectAll).toBe(true);
        expect(hook.getCurrent().disableSelectNone).toBe(true);
        const selection = hook.getCurrent();
        for (const mutate of [() => selection.toggleCommitSelectionForFile(proposedFile), selection.bulkSelectAll,
            () => selection.bulkSelectFiles([proposedFile]), () => selection.bulkDeselectFiles([scmFile(ordinaryPath)]), selection.bulkSelectNone]) {
            mutate();
            expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1')).toEqual([ordinaryPath]);
            expect(storage.getState().getSessionProjectScmCommitSelectionPatches('s1')).toEqual(retainedPatches);
        }
        proposedGroupSelection = null;
        await hook.rerender();
        expect(hook.getCurrent().disableSelectAll).toBe(false);
        hook.getCurrent().bulkSelectFiles([proposedFile]);
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1')).toEqual([ordinaryPath, proposedFile.fullPath]);
        hook.getCurrent().bulkSelectNone();
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1')).toEqual([]);
        expect(storage.getState().getSessionProjectScmCommitSelectionPatches('s1')).toEqual([]);
    });
    it('keeps the commit checkboxes meaning staged changes while a proposal is selected (lab WT4-C2: a view state only)', async () => {
        const ordinaryPaths = ['src/ordinary.ts'];
        const files = [scmFile('src/ordinary.ts'), { ...scmFile('src/proposed.ts'), isIncluded: true }, { ...scmFile('src/other-staged.ts'), isIncluded: true }];
        const hook = await renderHook(() => useSessionRightPanelGitCommitSelection({
            sessionId: 's1', sessionPath: '/repo', scmSnapshot: null, scmWriteEnabled: true, scmCommitStrategy: 'git_staging',
            commitSelectionPaths: ordinaryPaths, commitSelectionPatches: [], changedFiles: files,
            proposedGroupSelection: { resultId: 'saved', comparisonId: 'pending', groupId: 'one', changeRefs: ['exact'], paths: ['src/proposed.ts'] },
        }));
        expect(files.filter(hook.getCurrent().isSelectedForCommit).map((file) => file.fullPath)).toEqual(['src/proposed.ts', 'src/other-staged.ts']);
        expect(hook.getCurrent().repositorySelectedCount).toBe(2);
        expect(ordinaryPaths).toEqual(['src/ordinary.ts']);
    });
    it('counts only visible changed files for atomic repository selection totals', async () => {
        const visibleFile = scmFile('src/visible.ts');

        const hook = await renderHook(() => useSessionRightPanelGitCommitSelection({
            sessionId: 's1',
            sessionPath: '/tmp/repo',
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['src/visible.ts', 'src/generated/'],
            commitSelectionPatches: [{ path: 'src/hidden-patch/', patch: '@@ hidden @@' }],
            changedFiles: [visibleFile],
        }));

        expect(hook.getCurrent().repositorySelectedCount).toBe(1);
    });
});
