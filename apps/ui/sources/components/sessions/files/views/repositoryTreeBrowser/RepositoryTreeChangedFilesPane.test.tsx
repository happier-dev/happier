import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionFilesViewCommonModuleMocks } from '../sessionFilesViewsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const changedFilesDataSpy = vi.fn();
const derivedSessionChangeSetSpy = vi.fn();
const repositoryProject: Project = {
    id: 'p1',
    key: { machineId: 'machine-1', path: '/workspace' },
    sessionIds: ['s1'],
    createdAt: 1,
    updatedAt: 1,
};

function findChipByLabel(screen: Awaited<ReturnType<typeof renderScreen>>, label: string) {
    return screen.findAll((node) => node.props?.label === label)[0] ?? null;
}

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

installSessionFilesViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useProjectForSession: () => repositoryProject,
            useProjectSessions: () => ['s1'],
            useSessionProjectScmTouchedPaths: () => ['session-changes-qa-root.txt'],
            useSessionProjectScmOperationLog: () => [],
            useSetting: (key: string) => {
                if (key === 'scmReviewMaxFiles') return 25;
                if (key === 'scmReviewMaxChangedLines') return 2000;
                return null;
            },
            importOriginal,
        });
    },
});

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (input: unknown) => changedFilesDataSpy(input),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (sessionId: string) => derivedSessionChangeSetSpy(sessionId),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => React.createElement('ChangedFilesList', props),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => React.createElement('ChangedFilesReview', props),
}));

describe('RepositoryTreeChangedFilesPane', () => {
    it('surfaces scoped view selection in the repository browser changed-files pane and can switch to review mode', async () => {
        changedFilesDataSpy.mockReturnValue({
            attributionReliability: 'high',
            showTurnViewToggle: true,
            showSessionViewToggle: true,
            scmStatusFiles: null,
            changedFilesCount: 1,
            shouldShowAllFiles: false,
            allRepositoryChangedFiles: [{ fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }],
            turnAttributedFiles: [{ file: { fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }, confidence: 'high' }],
            turnRepositoryOnlyFiles: [],
            sessionAttributedFiles: [{ file: { fullPath: 'session-changes-qa-root.txt', fileName: 'session-changes-qa-root.txt' }, confidence: 'high' }],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
        });
        derivedSessionChangeSetSpy.mockReturnValue({
            latestTurnScopedChangeSet: { sessionId: 's1', files: [{ filePath: 'session-changes-qa-root.txt' }] },
            sessionChangeSet: { sessionId: 's1', files: [{ filePath: 'session-changes-qa-root.txt' }] },
            latestTurnDiffByPath: new Map([['session-changes-qa-root.txt', 'diff --git a/session-changes-qa-root.txt b/session-changes-qa-root.txt']]),
            providerDiffByPath: new Map([['session-changes-qa-root.txt', 'diff --git a/session-changes-qa-root.txt b/session-changes-qa-root.txt']]),
        });

        const onShowAllRepositoryFiles = vi.fn();
        const { RepositoryTreeChangedFilesPane } = await import('./RepositoryTreeChangedFilesPane');

        const screen = await renderScreen(<RepositoryTreeChangedFilesPane
                    sessionId="s1"
                    scmSnapshot={null}
                    searchQuery=""
                    onSearchQueryChange={vi.fn()}
                    onShowAllRepositoryFiles={onShowAllRepositoryFiles}
                    onOpenFile={vi.fn()}
                />);

        expect(screen.getTextContent()).toContain('files.toolbar.view');
        expect(screen.getTextContent()).not.toContain('files.toolbar.turnView');
        expect(screen.getTextContent()).not.toContain('files.toolbar.sessionView');
        expect(screen.findAllByType('ChangedFilesList' as any)).toHaveLength(1);
        expect(screen.findAllByType('ChangedFilesReview' as any)).toHaveLength(0);

        const reviewToggle = findChipByLabel(screen, 'files.toolbar.review');
        expect(reviewToggle).toBeTruthy();

        await pressTestInstanceAsync(reviewToggle, 'files.toolbar.review');

        expect(screen.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);

        const allRepositoryFilesToggle = findChipByLabel(screen, 'files.toolbar.allRepositoryFiles');
        expect(allRepositoryFilesToggle).toBeTruthy();

        await pressTestInstanceAsync(allRepositoryFilesToggle, 'files.toolbar.allRepositoryFiles');

        expect(onShowAllRepositoryFiles).toHaveBeenCalledTimes(1);
    });
});
