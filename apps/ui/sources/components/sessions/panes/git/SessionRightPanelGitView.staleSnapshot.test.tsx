import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let mockSnapshotError: { message: string; at: number; errorCode?: string } | null = null;
const invalidateFromUserAndAwaitMock = vi.hoisted(() => vi.fn(async () => {}));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ActivityIndicator: 'ActivityIndicator',
            Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
            AppState: { addEventListener: () => ({ remove: () => {} }) },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => null,
            useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', homeDir: '/tmp' } }],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useMachine: () => ({ online: true }),
            useSession: () => ({ active: true, metadata: { machineId: 'm1', path: '/repo' } }),
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmOperationLog: () => [],
            useSessionProjectScmSnapshot: () => mockSnapshot,
            useSessionProjectScmSnapshotError: () => mockSnapshotError,
            useSessionRealtimeScmTranscriptConsumer: () => {},
            useSessionProjectScmTouchedPaths: () => [],
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ scopeState: {} }),
}));

vi.mock('./useSessionRightPanelGitTabState', () => ({
    useSessionRightPanelGitTabState: () => ({
        activeGitSubTab: 'commit',
        setActiveGitSubTab: vi.fn(),
        commitDraftMessage: '',
        setCommitDraftMessage: vi.fn(),
    }),
}));

vi.mock('./useSessionRightPanelGitOpenDetails', () => ({
    useSessionRightPanelGitOpenDetails: () => ({
        openFileInDetails: vi.fn(),
        openFileInDetailsPinned: vi.fn(),
        openCommitInDetails: vi.fn(),
    }),
}));

vi.mock('@/hooks/session/files/useScmCommitHistory', () => ({
    useScmCommitHistory: () => ({
        historyEntries: [],
        historyLoading: false,
        historyHasMore: false,
        loadCommitHistory: vi.fn(),
    }),
}));

vi.mock('@/hooks/session/files/useFilesScmOperations', () => ({
    useFilesScmOperations: () => ({
        scmOperationBusy: false,
        scmOperationStatus: null,
        commitPreflight: { allowed: true, message: null },
        pullPreflight: { allowed: true, message: null },
        pushPreflight: { allowed: true, message: null },
        runRemoteOperation: vi.fn(),
        createCommitFromMessage: vi.fn(),
        commitMessageGeneratorEnabled: false,
        generateCommitMessageSuggestion: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
    }),
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => {
    const scmUiBackendRegistry = {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
            mapCapabilitiesToUiPolicy: () => ({ supportedDiffAreas: ['pending'] }),
        }),
    };
    return { scmUiBackendRegistry, createScmUiBackendRegistry: () => scmUiBackendRegistry };
});

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: invalidateFromUserAndAwaitMock,
        invalidateFromAutoRefreshAndAwait: vi.fn(async () => {}),
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: () => React.createElement('CommitTab', { testID: 'session-right-panel-git-commit-tab' }),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmUpdateTab', () => ({
    WorkspaceScmUpdateTab: () => React.createElement('UpdateTab', { testID: 'session-right-panel-git-update-tab' }),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmHistoryTab', () => ({
    WorkspaceScmHistoryTab: () => React.createElement('HistoryTab', { testID: 'session-right-panel-git-history-tab' }),
}));

function createSnapshot(isRepo: boolean) {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/repo',
        repo: isRepo
            ? { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' }
            : { isRepo: false, rootPath: null, backendId: null, mode: null },
        capabilities: {
            readStatus: true,
            readLog: true,
            writeCommit: true,
            supportedDiffAreas: ['included', 'pending'],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
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

async function render() {
    const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
    return renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
}

// Assertions about the notice use `findHostByTestId`: a component that takes a `testID` and then
// renders `null` still matches `findByTestId` by props, so the absence case would pass for the
// wrong reason. Host lookups are the same query restricted to the nodes that actually painted.
/**
 * `F-SCM-2`: the error branch was `if (!effectiveScmSnapshot && scmSnapshotError)`, and
 * `scmStatusSync`'s catch stores the error WITHOUT clearing the snapshot. So after the first
 * successful read the pane could never report a failure again — the user reads stale content,
 * including a stale "not under source control", as if it were current.
 */
describe('SessionRightPanelGitView (stale snapshot)', () => {
    beforeEach(() => {
        invalidateFromUserAndAwaitMock.mockClear();
    });

    it('surfaces a failing refresh while keeping the cached repository content visible', async () => {
        mockSnapshot = createSnapshot(true);
        mockSnapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };

        const screen = await render();

        expect(screen.findHostByTestId('session-rightpanel-git-stale')).not.toBeNull();
        expect(screen.findByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
        expect(screen.findHostByTestId('session-rightpanel-git-unavailable')).toBeNull();

        await screen.pressByTestIdAsync('session-rightpanel-git-stale-action');
        expect(invalidateFromUserAndAwaitMock).toHaveBeenCalledWith('s1');
    });

    it('surfaces a failing refresh over a cached "not a repository" answer', async () => {
        mockSnapshot = createSnapshot(false);
        mockSnapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };

        const screen = await render();

        expect(screen.findHostByTestId('session-rightpanel-git-stale')).not.toBeNull();
        expect(screen.getTextContent()).toContain('files.notUnderSourceControl');
    });

    it('stays quiet when the snapshot is current', async () => {
        mockSnapshot = createSnapshot(true);
        mockSnapshotError = null;

        const screen = await render();

        expect(screen.findHostByTestId('session-rightpanel-git-stale')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-git-surface:commit')).not.toBeNull();
    });
});
