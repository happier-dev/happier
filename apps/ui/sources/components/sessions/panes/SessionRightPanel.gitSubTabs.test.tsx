import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    };
});

const invalidateFromUserAndAwaitSpy = vi.fn();
const loadCommitHistorySpy = vi.fn();
const useChangedFilesDataSpy = vi.fn();
let sessionPathMock: string | null = '/workspace';
let scmSnapshotMock: any = null;
let scmWriteEnabledMock = true;

function buildScmSnapshotMock(capabilities: any) {
    return {
        repo: { isRepo: true },
        hasConflicts: false,
        entries: [],
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        capabilities,
    };
}

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabledMock,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: (...args: any[]) => useChangedFilesDataSpy(...args),
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
        createCommitFromMessage: vi.fn(async () => ({ ok: true })),
    }),
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
    scmStatusSync: { invalidateFromUserAndAwait: invalidateFromUserAndAwaitSpy },
}));

vi.mock('@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard', () => ({
    ScmCommitComposerCard: (props: any) => React.createElement('ScmCommitComposerCard', props),
}));

vi.mock('@/components/sessions/files/SourceControlOperationsPanel', () => ({
    SourceControlOperationsPanel: (props: any) => React.createElement('SourceControlOperationsPanel', props),
}));

vi.mock('@/components/sessions/files/SourceControlOperationsHistorySection', () => ({
    SourceControlOperationsHistorySection: (props: any) => React.createElement('SourceControlOperationsHistorySection', props),
}));

vi.mock('@/components/sessions/files/SourceControlOperationsLogSection', () => ({
    SourceControlOperationsLogSection: (props: any) => React.createElement('SourceControlOperationsLogSection', props),
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => React.createElement('ChangedFilesList', props),
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: (props: any) => React.createElement('SourceControlBranchSummary', props),
}));

vi.mock('@/components/sessions/sourceControl/commitSelection/ScmChangesSelectionHeaderRow', () => ({
    ScmChangesSelectionHeaderRow: (props: any) => React.createElement('ScmChangesSelectionHeaderRow', props),
}));

vi.mock('@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton', () => ({
    ScmCommitSelectionToggleButton: (props: any) => React.createElement('ScmCommitSelectionToggleButton', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeDiscardButton', () => ({
    ScmChangeDiscardButton: (props: any) => React.createElement('ScmChangeDiscardButton', props),
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeOverflowMenu', () => ({
    ScmChangeOverflowMenu: (props: any) => React.createElement('ScmChangeOverflowMenu', props),
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: (props: any) => React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/scm/scmAttribution', () => ({
    getDefaultChangedFilesViewMode: () => 'session',
}));

vi.mock('@/scm/settings/commitStrategy', () => ({
    SCM_COMMIT_STRATEGIES: ['atomic', 'atomic-per-file', 'working-copy'] as const,
    isAtomicCommitStrategy: () => true,
}));

vi.mock('@/scm/operations/commitSelectionHints', () => ({
    countCommitSelectionItems: () => 0,
}));

vi.mock('@/scm/operations/applyFileStageAction', () => ({
    applyFileStageAction: vi.fn(async () => {}),
}));

vi.mock('@/scm/operations/applyBulkFileStageAction', () => ({
    applyBulkFileStageAction: vi.fn(async () => {}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: () => {},
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal', () => ({
    computeExpandedPathsForReveal: (args: any) => args.expandedPaths,
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));

vi.mock('@/sync/domains/state/storage', () => {
    const state = {
        clearSessionProjectScmCommitSelectionPaths: vi.fn(),
        clearSessionProjectScmCommitSelectionPatches: vi.fn(),
        getSessionRepositoryTreeExpandedPaths: vi.fn(() => []),
        setSessionRepositoryTreeExpandedPaths: vi.fn(),
    };

    return {
        useLocalSetting: (key: string) => {
            if (key === 'detailsPaneTabsBehavior') return 'preview';
            if (key === 'uiMultiPanePanelsEnabled') return true;
            return undefined;
        },
        useSession: () => ({ active: true, metadata: { path: sessionPathMock, machineId: 'm1' } }),
        useMachine: () => null,
        useSessionProjectScmSnapshot: () => scmSnapshotMock,
        useSessionProjectScmSnapshotError: () => null,
        useSessionProjectScmTouchedPaths: () => [],
        useSessionProjectScmOperationLog: () => [],
        useSessionProjectScmInFlightOperation: () => null,
        useSessionProjectScmCommitSelectionPaths: () => [],
        useSessionProjectScmCommitSelectionPatches: () => [],
        useSetting: (key: string) => {
            if (key === 'scmCommitStrategy') return 'atomic';
            if (key === 'scmRemoteConfirmPolicy') return 'always';
            if (key === 'scmPushRejectPolicy') return 'reject';
            return undefined;
        },
        useProjectForSession: () => ({ id: 'p1' }),
        useProjectSessions: () => [],
        storage: { getState: () => state },
    };
});

describe('SessionRightPanel git sub-tabs', () => {
    beforeEach(() => {
        useChangedFilesDataSpy.mockReset();
        useChangedFilesDataSpy.mockImplementation(() => ({
            attributionReliability: 'explicit',
            scmStatusFiles: null,
            allRepositoryChangedFiles: [],
            sessionAttributedFiles: [],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
        }));
    });

    it('refreshes SCM snapshot and commit history when mounted', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        invalidateFromUserAndAwaitSpy.mockClear();
        loadCommitHistorySpy.mockClear();
        sessionPathMock = '/workspace';
        scmSnapshotMock = buildScmSnapshotMock({
            readLog: true,
            writeCommit: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeDiscard: true,
            writeInclude: true,
            writeExclude: true,
        });

        await act(async () => {
            renderer.create(
                <AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>
            );
        });

        // Allow mount effects to flush.
        await act(async () => {
            await Promise.resolve();
        });

        expect(invalidateFromUserAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(loadCommitHistorySpy).toHaveBeenCalledWith({ reset: true });
    });

    it('refreshes SCM snapshot even when sessionPath is missing', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        invalidateFromUserAndAwaitSpy.mockClear();
        loadCommitHistorySpy.mockClear();
        sessionPathMock = null;
        scmSnapshotMock = buildScmSnapshotMock({
            readLog: true,
            writeCommit: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeDiscard: true,
            writeInclude: true,
            writeExclude: true,
        });

        await act(async () => {
            renderer.create(
                <AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>
            );
        });

        // Allow mount effects to flush.
        await act(async () => {
            await Promise.resolve();
        });

        expect(invalidateFromUserAndAwaitSpy).toHaveBeenCalledWith('s1');
        expect(loadCommitHistorySpy).not.toHaveBeenCalled();
    });

    it('shows commit surface by default and hides it on update/history', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        let observedState: any = null;
        useChangedFilesDataSpy.mockImplementation(() => ({
            attributionReliability: 'explicit',
            scmStatusFiles: {
                includedFiles: [],
                pendingFiles: [],
                changeSetModel: 'index',
                branch: 'main',
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: false,
                totalIncluded: 0,
                totalPending: 0,
            },
            allRepositoryChangedFiles: [],
            sessionAttributedFiles: [],
            repositoryOnlyFiles: [],
            suppressedInferredCount: 0,
        }));
        const Probe = () => {
            const { state } = useAppPaneContext();
            observedState = state;
            return null;
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            scmWriteEnabledMock = true;
            scmSnapshotMock = buildScmSnapshotMock({
                readLog: true,
                writeCommit: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                writeDiscard: true,
                writeInclude: true,
                writeExclude: true,
            });
            tree = renderer.create(
                <AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                    <Probe />
                </AppPaneProvider>
            );
        });

        const findHostSurfaceView = (testID: string) => {
            return tree.root.find((node) => (node.type as unknown) === 'View' && node.props?.testID === testID);
        };

        const getOpacity = (node: renderer.ReactTestInstance) => {
            const style = node.props.style;
            const styles = Array.isArray(style) ? style : [style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && 'opacity' in entry) {
                    return (entry as any).opacity;
                }
            }
            return undefined;
        };

        const commitSurface = findHostSurfaceView('session-rightpanel-git-surface:commit');
        const updateSurface = findHostSurfaceView('session-rightpanel-git-surface:update');
        const historySurface = findHostSurfaceView('session-rightpanel-git-surface:history');
        const getVisibility = (node: renderer.ReactTestInstance) => {
            const style = node.props.style;
            const styles = Array.isArray(style) ? style : [style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && 'visibility' in entry) {
                    return (entry as any).visibility;
                }
            }
            return undefined;
        };

        expect(getOpacity(commitSurface)).toBe(1);
        expect(getOpacity(updateSurface)).toBe(0);
        expect(getOpacity(historySurface)).toBe(0);
        expect(getVisibility(commitSurface)).toBe('visible');
        expect(getVisibility(updateSurface)).toBe('hidden');
        expect(getVisibility(historySurface)).toBe('hidden');

        const updateTab = tree.root.findByProps({ testID: 'session-rightpanel-git-subtab:update' });
        await act(async () => {
            updateTab.props.onPress();
        });

        expect(observedState?.scopes?.['session:s1']?.right?.tabState?.git?.activeSubTabId).toBe('update');
        expect(getOpacity(commitSurface)).toBe(0);
        expect(getOpacity(updateSurface)).toBe(1);
        expect(getOpacity(historySurface)).toBe(0);
        expect(getVisibility(commitSurface)).toBe('hidden');
        expect(getVisibility(updateSurface)).toBe('visible');
        expect(getVisibility(historySurface)).toBe('hidden');

        const historyTab = tree.root.findByProps({ testID: 'session-rightpanel-git-subtab:history' });
        await act(async () => {
            historyTab.props.onPress();
        });

        expect(observedState?.scopes?.['session:s1']?.right?.tabState?.git?.activeSubTabId).toBe('history');
        expect(getOpacity(commitSurface)).toBe(0);
        expect(getOpacity(updateSurface)).toBe(0);
        expect(getOpacity(historySurface)).toBe(1);
        expect(getVisibility(commitSurface)).toBe('hidden');
        expect(getVisibility(updateSurface)).toBe('hidden');
        expect(getVisibility(historySurface)).toBe('visible');
        expect(tree.root.findAllByType('SourceControlOperationsHistorySection' as any).length).toBe(1);
    });

    it('does not repeatedly recompute changed files data when switching away from commit', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        useChangedFilesDataSpy.mockClear();
        scmWriteEnabledMock = true;
        sessionPathMock = '/workspace';
        scmSnapshotMock = buildScmSnapshotMock({
            readLog: true,
            writeCommit: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeDiscard: true,
            writeInclude: true,
            writeExclude: true,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>
            );
        });

        // Ensure the initial commit tab render has invoked the hook.
        const initialCalls = useChangedFilesDataSpy.mock.calls.length;
        expect(initialCalls).toBeGreaterThan(0);

        const historyTab = tree.root.findByProps({ testID: 'session-rightpanel-git-subtab:history' });
        await act(async () => {
            historyTab.props.onPress();
        });

        // Switching away should not thrash changed-files computations.
        expect(useChangedFilesDataSpy.mock.calls.length).toBeLessThanOrEqual(initialCalls + 1);
    });

    it('hides update tab and commit composer when SCM write operations are disabled', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        scmWriteEnabledMock = false;
        scmSnapshotMock = buildScmSnapshotMock({
            readLog: true,
            writeCommit: false,
            writeRemoteFetch: false,
            writeRemotePull: false,
            writeRemotePush: false,
            writeDiscard: false,
            writeInclude: false,
            writeExclude: false,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>
            );
        });

        expect(tree.root.findAllByType('ScmCommitComposerCard' as any).length).toBe(0);
        expect(tree.root.findAllByProps({ testID: 'session-rightpanel-git-subtab:update' } as any).length).toBe(0);
        expect(tree.root.findAllByProps({ testID: 'session-rightpanel-git-subtab:history' } as any).length).toBe(1);
    });

    it('does not crash when SCM snapshot loads after mount', async () => {
        const { SessionRightPanelGitView } = await import('./git/SessionRightPanelGitView');

        type HarnessHandle = { bump: () => void };
        const Harness = React.forwardRef<HarnessHandle>((_props, ref) => {
            const [scopeId, setScopeId] = React.useState('session:s1');
            React.useImperativeHandle(ref, () => ({ bump: () => setScopeId((prev) => `${prev}:bump`) }), []);
            return <SessionRightPanelGitView sessionId="s1" scopeId={scopeId} />;
        });

        scmSnapshotMock = null;
        const harnessRef = React.createRef<HarnessHandle>();
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AppPaneProvider>
                    <Harness ref={harnessRef} />
                </AppPaneProvider>
            );
        });

        await act(async () => {
            await Promise.resolve();
        });

        scmSnapshotMock = {
            ...buildScmSnapshotMock({
                readLog: true,
                writeCommit: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                writeDiscard: true,
                writeInclude: true,
                writeExclude: true,
            }),
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        };

        await act(async () => {
            harnessRef.current?.bump();
        });

        expect(tree.root.findAllByType('SourceControlUnavailableState' as any).length).toBe(0);
    });
});
