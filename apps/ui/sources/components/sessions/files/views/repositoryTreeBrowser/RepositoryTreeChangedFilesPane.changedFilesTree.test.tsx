import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmStatusEntriesWindowState } from '@/scm/entries/scmStatusEntriesWindow';
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

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

installSessionFilesViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => `${key}(${String(params?.count ?? '')})`,
        });
    },
    reactNative: async () => {
        const ReactModule = (await import('react')).default ?? (await import('react'));
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            FlatList: ({ data, renderItem, keyExtractor }: any) =>
                ReactModule.createElement('FlatList', null, (data ?? []).map((item: any, index: number) =>
                    ReactModule.createElement(
                        ReactModule.Fragment,
                        { key: keyExtractor?.(item, index) ?? index },
                        renderItem({ item, index }),
                    ))),
            Platform: {
                select: (value: any) => value?.default ?? null,
                OS: 'web',
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useProjectForSession: () => repositoryProject,
            useProjectSessions: () => ['s1'],
            useSessionProjectScmTouchedPaths: () => [],
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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.title, props.rightElement),
}));
vi.mock('@/components/ui/media/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, Icon: 'Icon' };
});
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/sessions/files/repositoryTree/useScmTreeBadgeIndex', () => ({
    useScmTreeBadgeIndex: () => null,
}));
vi.mock('@/components/sessions/files/FilesToolbar', () => ({
    FilesToolbar: (props: any) => React.createElement('FilesToolbar', props),
}));
vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => React.createElement('ChangedFilesList', props),
}));
vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => React.createElement('ChangedFilesReview', props),
}));
vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (input: unknown) => changedFilesDataSpy(input),
}));
vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: (sessionId: string) => derivedSessionChangeSetSpy(sessionId),
}));

function makeDirectoryEntry(path: string, untrackedFileCount: number): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind: 'untracked',
        includeStatus: '?',
        pendingStatus: '?',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            isBinary: false,
        },
        isDirectory: true,
        untrackedFileCount,
    } as ScmWorkingEntry;
}

function makeSummarySnapshot(entries: ScmWorkingEntry[]): ScmWorkingSnapshot {
    return {
        projectKey: 'p1',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/workspace', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: false,
            writeCommitLineSelection: false,
            writeBackout: false,
            writeRemoteFetch: false,
            writeRemotePull: false,
            writeRemotePush: false,
            worktreeCreate: false,
            changeSetModel: 'index',
            supportedDiffAreas: ['pending'],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries,
        entriesPresentation: 'omitted',
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 30_000,
            changedFiles: 30_000,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    } as ScmWorkingSnapshot;
}

function windowState(entries: readonly ScmWorkingEntry[]): ScmStatusEntriesWindowState {
    return {
        mode: 'window',
        status: 'ready',
        entries,
        fallbackEntries: null,
        expansions: new Map(),
        truncated: false,
    } as ScmStatusEntriesWindowState;
}

describe('RepositoryTreeChangedFilesPane repository view', () => {
    it('renders a collapsed untracked directory row with its file count instead of dropping it', async () => {
        const directoryEntry = makeDirectoryEntry('D/', 30_000);
        const snapshot = makeSummarySnapshot([directoryEntry]);

        changedFilesDataSpy.mockReturnValue({
            attributionReliability: 'low',
            showTurnViewToggle: false,
            showSessionViewToggle: false,
            scmStatusFiles: null,
            changedFilesCount: 30_000,
            shouldShowAllFiles: false,
            allRepositoryChangedFiles: [],
            turnAttributedFiles: [],
            turnRepositoryOnlyFiles: [],
            sessionAttributedFiles: [],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
            entriesWindow: {
                state: windowState([directoryEntry]),
                expandDirectory: vi.fn(),
                collapseDirectory: vi.fn(),
                loadMoreExpanded: vi.fn(),
            },
        });
        derivedSessionChangeSetSpy.mockReturnValue({
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            providerDiffByPath: null,
        });

        const { RepositoryTreeChangedFilesPane } = await import('./RepositoryTreeChangedFilesPane');

        const screen = await renderScreen(<RepositoryTreeChangedFilesPane
            sessionId="s1"
            scmSnapshot={snapshot}
            searchQuery=""
            onSearchQueryChange={vi.fn()}
            onShowAllRepositoryFiles={vi.fn()}
            onOpenFile={vi.fn()}
        />);

        const text = screen.getTextContent();
        expect(text).toContain('D/');
        expect(text).toContain('files.changedFilesDirectoryFileCount(30000)');
    });
});

void createThemeFixture;
