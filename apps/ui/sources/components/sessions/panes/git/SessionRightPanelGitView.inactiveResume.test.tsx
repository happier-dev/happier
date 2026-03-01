import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedInactiveProps: any = null;
const emitSessionResumeRequestSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (value: any) => value,
    },
}));

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
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    __esModule: true,
    useSetting: () => null,
    useProjectForSession: () => null,
    useProjectSessions: () => [],
    useMachine: () => ({ online: true }),
    useSession: () => ({ active: false, metadata: { machineId: 'm1', path: '/repo' } }),
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSessionProjectScmCommitSelectionPatches: () => [],
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmOperationLog: () => [],
    useSessionProjectScmSnapshot: () => null,
    useSessionProjectScmSnapshotError: () => ({ message: 'RPC method not available', at: 1 }),
    useSessionProjectScmTouchedPaths: () => [],
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    SourceControlSessionInactiveState: (props: any) => {
        capturedInactiveProps = props;
        return React.createElement('SourceControlSessionInactiveState', props);
    },
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/components/sessions/model/sessionResumeRequests', () => ({
    emitSessionResumeRequest: (sessionId: string) => emitSessionResumeRequestSpy(sessionId),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
        }),
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: vi.fn(),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionRightPanelGitView (inactive session resume)', () => {
    it('provides a resume action when session is inactive', async () => {
        capturedInactiveProps = null;
        const onResumeSession = vi.fn(async () => true);

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        await act(async () => {
            renderer.create(
                <SessionResumeProvider onResumeSession={onResumeSession}>
                    <SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />
                </SessionResumeProvider>,
            );
        });

        expect(capturedInactiveProps).toBeTruthy();
        expect(typeof capturedInactiveProps.onOpenSession).toBe('function');
    });

    it('falls back to emitting a resume request when no resume provider is available', async () => {
        capturedInactiveProps = null;
        emitSessionResumeRequestSpy.mockClear();

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        await act(async () => {
            renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        expect(capturedInactiveProps).toBeTruthy();
        expect(typeof capturedInactiveProps.onOpenSession).toBe('function');
        (capturedInactiveProps.onOpenSession as any)();
        expect(emitSessionResumeRequestSpy).toHaveBeenCalledWith('s1');
    });
});
