import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { AppPaneProvider, useAppPaneContext } from '../../appShell/panes/AppPaneProvider';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useProjectForSession: () => ({ id: 'p1' }),
            useProjectSessions: () => [],
            storage: { getState: () => ({ sessions: {}, settings: {}, sessionListViewDataByServerId: {} }) },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
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

        await renderScreen(<AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>);

        // Allow mount effects to flush.
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
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

        await renderScreen(<AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>);

        // Allow mount effects to flush.
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
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
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                <Probe />
            </AppPaneProvider>,
        );
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

        const commitSurface = screen.findByTestId('session-rightpanel-git-surface:commit');
        const updateSurface = screen.findByTestId('session-rightpanel-git-surface:update');
        const historySurface = screen.findByTestId('session-rightpanel-git-surface:history');
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

        expect(commitSurface).toBeTruthy();
        expect(updateSurface).toBeTruthy();
        expect(historySurface).toBeTruthy();
        expect(getOpacity(commitSurface!)).toBe(1);
        expect(getOpacity(updateSurface!)).toBe(0);
        expect(getOpacity(historySurface!)).toBe(0);
        expect(getVisibility(commitSurface!)).toBe('visible');
        expect(getVisibility(updateSurface!)).toBe('hidden');
        expect(getVisibility(historySurface!)).toBe('hidden');

        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:update');

        expect(observedState?.scopes?.['session:s1']?.right?.tabState?.git?.activeSubTabId).toBe('update');
        expect(getOpacity(commitSurface!)).toBe(0);
        expect(getOpacity(updateSurface!)).toBe(1);
        expect(getOpacity(historySurface!)).toBe(0);
        expect(getVisibility(commitSurface!)).toBe('hidden');
        expect(getVisibility(updateSurface!)).toBe('visible');
        expect(getVisibility(historySurface!)).toBe('hidden');

        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:history');

        expect(observedState?.scopes?.['session:s1']?.right?.tabState?.git?.activeSubTabId).toBe('history');
        expect(getOpacity(commitSurface!)).toBe(0);
        expect(getOpacity(updateSurface!)).toBe(0);
        expect(getOpacity(historySurface!)).toBe(1);
        expect(getVisibility(commitSurface!)).toBe('hidden');
        expect(getVisibility(updateSurface!)).toBe('hidden');
        expect(getVisibility(historySurface!)).toBe('visible');
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

        const screen = await renderScreen(<AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>);
        // Ensure the initial commit tab render has invoked the hook.
        const initialCalls = useChangedFilesDataSpy.mock.calls.length;
        expect(initialCalls).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('session-rightpanel-git-subtab:history');

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

        const screen = await renderScreen(<AppPaneProvider>
                    <SessionRightPanel sessionId="s1" scopeId="session:s1" />
                </AppPaneProvider>);
        expect(screen.findAllByTestId('scm-commit-message')).toHaveLength(0);
        expect(screen.findAllByTestId('session-rightpanel-git-subtab:update')).toHaveLength(0);
        expect(screen.findAllByTestId('session-rightpanel-git-subtab:history')).toHaveLength(1);
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
        const screen = await renderScreen(<AppPaneProvider>
                    <Harness ref={harnessRef} />
                </AppPaneProvider>);

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
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

        expect(screen.findAllByTestId('session-rightpanel-git-surface:commit').length).toBeGreaterThan(0);
    });
});
