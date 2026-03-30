import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let lastScmOperationsInput: any = null;
const invalidateFromUserAndAwaitMock = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshAndAwaitMock = vi.hoisted(() => vi.fn());

vi.mock('react-native-reanimated', () => ({}));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (value: any) => value?.default ?? null,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    textSecondary: '#666',
                    text: '#111',
                },
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(
            importOriginal,
            {
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
                useSessionProjectScmSnapshotError: () => null,
                useSessionProjectScmTouchedPaths: () => [],
            },
        );
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {},
    }),
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
    useFilesScmOperations: (input: any) => {
        lastScmOperationsInput = input;
        return {
            scmOperationBusy: false,
            scmOperationStatus: null,
            commitPreflight: { allowed: true, message: null },
            pullPreflight: { allowed: true, message: null },
            pushPreflight: { allowed: true, message: null },
            runRemoteOperation: vi.fn(),
            createCommitFromMessage: vi.fn(),
            commitMessageGeneratorEnabled: false,
            generateCommitMessageSuggestion: vi.fn(),
        };
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
            mapCapabilitiesToUiPolicy: () => ({ supportedDiffAreas: ['pending'] }),
        }),
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: invalidateFromUserAndAwaitMock,
        invalidateFromAutoRefreshAndAwait: invalidateFromAutoRefreshAndAwaitMock,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: () => React.createElement('CommitTab', { testID: 'session-right-panel-git-commit-tab' }),
}));

vi.mock('./SessionRightPanelGitUpdateTab', () => ({
    SessionRightPanelGitUpdateTab: () => React.createElement('UpdateTab', { testID: 'session-right-panel-git-update-tab' }),
}));

vi.mock('./SessionRightPanelGitHistoryTab', () => ({
    SessionRightPanelGitHistoryTab: () => React.createElement('HistoryTab', { testID: 'session-right-panel-git-history-tab' }),
}));

function createTimeoutCapture() {
    const scheduledTimeouts: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, _delay?: number, ...args: Array<unknown>) => {
        if (typeof callback === 'function') {
            scheduledTimeouts.push(() => {
                callback(...args);
            });
        }
        return 0 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    return {
        scheduledTimeouts,
        setTimeoutSpy,
    };
}

describe('SessionRightPanelGitView (snapshot SWR)', () => {
    it('keeps retrying source-control refresh while the first snapshot is still unavailable', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        const { scheduledTimeouts, setTimeoutSpy } = createTimeoutCapture();
        mockSnapshot = null;
        invalidateFromUserAndAwaitMock.mockReset();
        invalidateFromAutoRefreshAndAwaitMock.mockReset();

        try {
            await renderScreen(React.createElement(SessionRightPanelGitView, { sessionId: 's1', scopeId: 'session:s1' }));

            expect(invalidateFromUserAndAwaitMock).toHaveBeenCalledWith('s1');

            await flushHookEffects({ cycles: 1, turns: 1 });
            expect(invalidateFromAutoRefreshAndAwaitMock).toHaveBeenCalledTimes(1);

            const nextTimeout = scheduledTimeouts.at(-1);
            expect(nextTimeout).toBeDefined();
            nextTimeout?.();
            await flushHookEffects({ cycles: 1, turns: 1 });

            expect(invalidateFromAutoRefreshAndAwaitMock).toHaveBeenCalledTimes(2);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('keeps last-known snapshot content visible while snapshot is revalidating', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const validSnapshot = {
            fetchedAt: 1,
            projectKey: 'm1:/repo',
            repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeCommit: true,
                writeInclude: true,
                writeExclude: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
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

        mockSnapshot = validSnapshot;
        lastScmOperationsInput = null;

        function Wrapper(props: Readonly<{ tick: number }>) {
            return React.createElement(SessionRightPanelGitView, { sessionId: 's1', scopeId: `session:s1:${props.tick}` });
        }

        const screen = await renderScreen(React.createElement(Wrapper, { tick: 0 }));

        expect(screen.findAllByTestId('session-right-panel-git-commit-tab')).toHaveLength(1);
        expect(lastScmOperationsInput?.scmSnapshot).toBe(validSnapshot);

        mockSnapshot = null;
        await screen.update(React.createElement(Wrapper, { tick: 1 }));

        // Should keep the commit surface mounted, rather than falling back to the empty loading state.
        expect(screen.findAllByTestId('session-right-panel-git-commit-tab')).toHaveLength(1);
        expect(lastScmOperationsInput?.scmSnapshot).toBe(validSnapshot);
    });
});
