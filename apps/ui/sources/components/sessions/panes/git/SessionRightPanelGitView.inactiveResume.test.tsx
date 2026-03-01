import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionResumeProvider } from '@/components/sessions/model/SessionResumeContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedInactiveProps: any = null;
const emitSessionResumeRequestSpy = vi.hoisted(() => vi.fn());
const loadCommitHistorySpy = vi.hoisted(() => vi.fn());
let machineReachable = false;
let sessionPath: string | null = '/repo';
let projectPath: string | null = '/repo';

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
        loadCommitHistory: loadCommitHistorySpy,
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
    useProjectForSession: () => (
        projectPath
            ? { key: { machineId: 'm1', path: projectPath } }
            : null
    ),
    useProjectSessions: () => [],
    useAllMachines: () => (
        machineReachable
            ? [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
            : [{ id: 'm1', active: false, activeAt: 1, metadata: { host: 'mbp', platform: 'darwin', happyCliVersion: '0', happyHomeDir: '/tmp/.h', homeDir: '/tmp' } }]
    ),
    useSession: () => ({ active: false, metadata: { machineId: 'm1', path: sessionPath } }),
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

vi.mock('@/components/sessions/model/sessionResumeRequests', () => ({
    emitSessionResumeRequest: (sessionId: string) => emitSessionResumeRequestSpy(sessionId),
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
    beforeEach(() => {
        sessionPath = '/repo';
        projectPath = '/repo';
        loadCommitHistorySpy.mockReset();
    });

    it('provides a resume action when session is inactive', async () => {
        capturedInactiveProps = null;
        machineReachable = false;
        sessionPath = null;
        projectPath = null;
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
        machineReachable = false;
        sessionPath = null;
        projectPath = null;
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

    it('shows unavailable state when session is inactive but machine is reachable', async () => {
        capturedInactiveProps = null;
        machineReachable = true;

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        expect(capturedInactiveProps).toBeNull();
        expect(tree.root.findAllByType('SourceControlUnavailableState').length).toBe(1);
    });

    it('shows unavailable state when machine appears offline but machine RPC target is available', async () => {
        capturedInactiveProps = null;
        machineReachable = false;
        sessionPath = '/repo';
        projectPath = '/repo';

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        expect(capturedInactiveProps).toBeNull();
        expect(tree.root.findAllByType('SourceControlUnavailableState').length).toBe(1);
    });

    it('loads commit history when project path is available even if session metadata path is missing', async () => {
        capturedInactiveProps = null;
        machineReachable = true;
        sessionPath = null;
        projectPath = '/repo';

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        await act(async () => {
            renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        expect(loadCommitHistorySpy).toHaveBeenCalledWith({ reset: true });
    });
});
