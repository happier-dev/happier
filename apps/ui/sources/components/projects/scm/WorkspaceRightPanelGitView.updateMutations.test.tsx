import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const beginWorkspaceScmOperationMock = vi.hoisted(() => vi.fn());
const finishWorkspaceScmOperationMock = vi.hoisted(() => vi.fn(() => true));
const appendWorkspaceScmOperationMock = vi.hoisted(() => vi.fn());
const machineScmRemoteAddMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true })));
const machineScmHostingRepositoryDescribePublishTargetsMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({
    success: false,
    error: 'not configured',
})));
const machineScmHostingRepositoryPublishMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true })));

let workspaceSnapshotMock: ScmWorkingSnapshot | null = null;
let capturedRemotesProps: any = null;
let capturedPublishProps: any = null;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (value: any) => value?.default ?? null,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: workspaceSnapshotMock,
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmCommitHistory', () => ({
    useWorkspaceScmCommitHistory: () => ({
        historyEntries: [],
        historyLoading: false,
        historyHasMore: false,
        loadCommitHistory: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: createStorageStoreMock({
            beginWorkspaceScmOperation: beginWorkspaceScmOperationMock,
            finishWorkspaceScmOperation: finishWorkspaceScmOperationMock,
            appendWorkspaceScmOperation: appendWorkspaceScmOperationMock,
        } as any),
        useSetting: () => null,
    });
});

vi.mock('@/components/workspaces/scm/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
}));

vi.mock('@/hooks/workspaces/scm/buildWorkspaceChangedFilesData', () => ({
    buildWorkspaceChangedFilesData: () => ({ scmStatusFiles: null }),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmSubTabsBar', () => ({
    WorkspaceScmSubTabsBar: (props: any) => React.createElement('WorkspaceScmSubTabsBar', props),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmUpdateTab', () => ({
    WorkspaceScmUpdateTab: (props: any) => React.createElement('WorkspaceScmUpdateTab', props, props.children),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmHistoryTab', () => ({
    WorkspaceScmHistoryTab: () => React.createElement('WorkspaceScmHistoryTab'),
}));

vi.mock('@/components/projects/scm/WorkspaceSourceControlView', () => ({
    WorkspaceSourceControlView: () => React.createElement('WorkspaceSourceControlView'),
}));

vi.mock('@/components/projects/scm/WorkspaceSourceControlBranchMenu', () => ({
    WorkspaceSourceControlBranchMenu: () => React.createElement('WorkspaceSourceControlBranchMenu'),
}));

vi.mock('@/components/workspaces/scm/update/SourceControlRemotesSection', () => ({
    SourceControlRemotesSection: (props: any) => {
        capturedRemotesProps = props;
        return React.createElement('SourceControlRemotesSection');
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlPublishRepositorySection', () => ({
    SourceControlPublishRepositorySection: (props: any) => {
        capturedPublishProps = props;
        return React.createElement('SourceControlPublishRepositorySection');
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlBranchIntegrationSection', () => ({
    SourceControlBranchIntegrationSection: () => React.createElement('SourceControlBranchIntegrationSection'),
}));

vi.mock('@/components/projects/scm/executeWorkspaceScmRemoteOperation', () => ({
    executeWorkspaceScmRemoteOperation: vi.fn(async () => {}),
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmRemoteAdd: (...args: any[]) => machineScmRemoteAddMock(...args),
    machineScmRemoteSetUrl: vi.fn(async () => ({ success: true })),
    machineScmRemoteRemove: vi.fn(async () => ({ success: true })),
    machineScmBranchMerge: vi.fn(async () => ({ success: true })),
    machineScmBranchRebase: vi.fn(async () => ({ success: true })),
    machineScmBranchOperationContinue: vi.fn(async () => ({ success: true })),
    machineScmBranchOperationAbort: vi.fn(async () => ({ success: true })),
    machineScmHostingRepositoryDescribePublishTargets: (...args: any[]) => machineScmHostingRepositoryDescribePublishTargetsMock(...args),
    machineScmHostingRepositoryPublish: (...args: any[]) => machineScmHostingRepositoryPublishMock(...args),
    machineScmPullRequestOpenCompose: vi.fn(async () => ({ success: true, url: 'https://example.com/compare' })),
    machineScmPullRequestOpenOrReuse: vi.fn(async () => ({ success: true, pullRequest: null, reused: false, nextAction: { kind: 'none' } })),
    machineScmRepositoryInit: vi.fn(async () => ({ success: true })),
}));

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'server-1:machine-1:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [],
            worktrees: [],
        },
        capabilities: {
            readLog: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemoteAdd: true,
            writeRemoteSetUrl: true,
            writeRemoteRemove: true,
            writeBranchMerge: true,
            writeBranchRebase: true,
            writeBranchOperationControl: true,
        } as any,
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

describe('WorkspaceRightPanelGitView update mutations', () => {
    beforeEach(() => {
        workspaceSnapshotMock = createSnapshot();
        capturedRemotesProps = null;
        capturedPublishProps = null;
        beginWorkspaceScmOperationMock.mockReset();
        finishWorkspaceScmOperationMock.mockClear();
        appendWorkspaceScmOperationMock.mockClear();
        machineScmRemoteAddMock.mockClear();
        machineScmHostingRepositoryDescribePublishTargetsMock.mockClear();
        machineScmHostingRepositoryPublishMock.mockClear();
    });

    it('routes remote add through the workspace SCM operation lock before invoking the RPC', async () => {
        beginWorkspaceScmOperationMock.mockReturnValue({
            started: false,
            reason: 'operation_in_flight',
            inFlight: {
                id: 'lock-1',
                startedAt: 1,
                sessionId: 'other-session',
                operation: 'pull',
            },
        });

        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(
            <WorkspaceRightPanelGitView
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />,
        );

        await act(async () => {
            screen.findByType('WorkspaceScmSubTabsBar').props.onSelectSubTab('update');
        });

        const response = await capturedRemotesProps.onAddRemote({
            name: 'origin',
            fetchUrl: 'git@example.com:repo.git',
        });

        expect(beginWorkspaceScmOperationMock).toHaveBeenCalledWith(
            expect.objectContaining({
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            }),
            'remote_add',
        );
        expect(machineScmRemoteAddMock).not.toHaveBeenCalled();
        expect(response).toEqual({
            success: false,
            error: 'Another source-control operation is already running (pull).',
        });
    });

    it('describes repository publish targets through the detected hosting provider', async () => {
        workspaceSnapshotMock = {
            ...createSnapshot(),
            capabilities: {
                ...createSnapshot().capabilities,
                readHostingRepositoryPublishTargets: true,
                writeHostingRepositoryPublish: true,
            } as ScmWorkingSnapshot['capabilities'],
            hostingProvider: {
                id: 'scm.gitlab',
                kind: 'gitlab',
                displayName: 'GitLab',
                baseUrl: 'https://gitlab.com',
                nameWithOwner: 'happier-dev/happier',
                repositoryWebUrl: 'https://gitlab.com/happier-dev/happier',
                remoteName: 'origin',
                urlSafety: { allowedSchemes: ['https:'] },
            },
        };

        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(
            <WorkspaceRightPanelGitView
                serverId="server-1"
                machineId="machine-1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />,
        );

        await act(async () => {
            screen.findByType('WorkspaceScmSubTabsBar').props.onSelectSubTab('update');
        });
        await capturedPublishProps.onDescribePublishTargets();

        expect(machineScmHostingRepositoryDescribePublishTargetsMock).toHaveBeenCalledWith('machine-1', {
            cwd: '/repo',
            providerKind: 'gitlab',
        });
    });
});
