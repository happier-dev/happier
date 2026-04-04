import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmCommitCreate } from '@/sync/ops/scm/machineScm';
import type { machineScmChangeDiscard } from '@/sync/ops/scm/machineScm';
import type { ScmStashListResponse } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const markWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const unmarkWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const removeWorkspaceScmCommitSelectionPatchSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPatchesSpy = vi.fn();
const refreshSpy = vi.fn(async () => {});
const machineScmStashListSpy = vi.fn(async (): Promise<ScmStashListResponse> => ({
    success: true,
    stashes: [],
    totalCount: 0,
}));
type MachineScmChangeDiscard = typeof machineScmChangeDiscard;
const machineScmChangeDiscardSpy = vi.fn<MachineScmChangeDiscard>(async () => ({ success: true } as any));

type MachineScmCommitCreate = typeof machineScmCommitCreate;
const machineScmCommitCreateSpy = vi.fn<MachineScmCommitCreate>(async () => ({ success: true, commitSha: 'abc' }));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        FlatList: (props: any) => {
            const data = Array.isArray(props.data) ? (props.data as ReadonlyArray<unknown>) : [];
            const header = props.ListHeaderComponent ? props.ListHeaderComponent : null;
            const empty = data.length === 0 && props.ListEmptyComponent ? props.ListEmptyComponent : null;
            const items = data.map((item: unknown, index: number) => React.createElement(
                'FlatListItem',
                { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
                props.renderItem ? props.renderItem({ item, index }) : null,
            ));
            const children = [header, empty, ...items] as React.ReactNode[];
            return React.createElement(
                'FlatList',
                props,
                ...(children as [React.ReactNode, ...React.ReactNode[]]),
            );
        },
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: (props: any) => React.createElement('TextInput', props, props.children),
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (value: any) => value?.default ?? null,
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabledMock,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmCommitCreate: (...args: Parameters<typeof machineScmCommitCreateSpy>) => machineScmCommitCreateSpy(...args),
    machineScmStashList: (...args: Parameters<typeof machineScmStashListSpy>) => machineScmStashListSpy(...args),
    machineScmChangeDiscard: (...args: Parameters<typeof machineScmChangeDiscardSpy>) => machineScmChangeDiscardSpy(...args),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: workspaceSnapshotMock,
        loading: false,
        error: null,
        refresh: refreshSpy,
    }),
}));

let commitSelectionPaths: string[] = [];
let commitSelectionPatches: Array<{ path: string; patch: string }> = [];
let scmCommitStrategySetting: string | null = 'atomic';
let workspaceSnapshotMock: ScmWorkingSnapshot | null = null;
let scmWriteEnabledMock = true;

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');

    const state = {
        markWorkspaceScmCommitSelectionPaths: (...args: any[]) => markWorkspaceScmCommitSelectionPathsSpy(...args),
        unmarkWorkspaceScmCommitSelectionPaths: (...args: any[]) => unmarkWorkspaceScmCommitSelectionPathsSpy(...args),
        removeWorkspaceScmCommitSelectionPatch: (...args: any[]) => removeWorkspaceScmCommitSelectionPatchSpy(...args),
        clearWorkspaceScmCommitSelectionPaths: (...args: any[]) => clearWorkspaceScmCommitSelectionPathsSpy(...args),
        clearWorkspaceScmCommitSelectionPatches: (...args: any[]) => clearWorkspaceScmCommitSelectionPatchesSpy(...args),
        beginWorkspaceScmOperation: () => ({ started: true, operation: { id: 'op-1', startedAt: 1, sessionId: 's', operation: 'commit' } }),
        finishWorkspaceScmOperation: () => true,
        appendWorkspaceScmOperation: () => {},
    };

    return createPartialStorageModuleMock(importOriginal, {
        storage: createStorageStoreMock(state as any),
        useSetting: (key: any) => {
            if (key === 'scmCommitStrategy') return scmCommitStrategySetting;
            return null;
        },
        useWorkspaceScmCommitSelectionPaths: () => commitSelectionPaths,
        useWorkspaceScmCommitSelectionPatches: () => commitSelectionPatches as any,
    });
});

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'p',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readLog: true,
            readBranches: true,
            writeInclude: true,
            writeExclude: true,
            writeDiscard: true,
            writeCommit: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemotePublish: true,
            writeBackout: true,
        } as any,
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [
            {
                path: 'src/a.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 2,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 2,
            pendingRemoved: 1,
        },
    };
}

describe('WorkspaceSourceControlView', () => {
    it('renders the shared branch, review, and remote-action affordances', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
                onOpenReviewAllChanges={() => {}}
            />
        )).tree;

        expect(tree.findByProps({ testID: 'scm-branch-menu-trigger' })).toBeTruthy();
        expect(tree.findByProps({ testID: 'workspace-scm-open-review' })).toBeTruthy();
        expect(tree.findByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.fetch' })).toBeTruthy();
        expect(tree.findByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.pull' })).toBeTruthy();
        expect(tree.findByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.push' })).toBeTruthy();
    });

    it('opens the workspace review surface from the shared toolbar action', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        const onOpenReviewAllChanges = vi.fn();

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
                onOpenReviewAllChanges={onOpenReviewAllChanges}
            />
        )).tree;

        const reviewButton = tree.findByProps({ testID: 'workspace-scm-open-review' });
        act(() => {
            reviewButton.props.onPress();
        });

        expect(onOpenReviewAllChanges).toHaveBeenCalledTimes(1);
    });

    it('uses the live total stash count instead of the raw snapshot stash count', async () => {
        workspaceSnapshotMock = {
            ...createSnapshot(),
            capabilities: {
                ...createSnapshot().capabilities,
                readStash: true,
            } as any,
            stashCount: 17,
        };
        machineScmStashListSpy.mockResolvedValueOnce({
            success: true,
            stashes: [
                { stashRef: 'stash@{0}', kind: 'branch', branch: 'main', createdAt: 1 },
                { stashRef: 'stash@{1}', kind: 'unmanaged', message: 'WIP on main: unmanaged', createdAt: 2 },
            ],
            totalCount: 2,
        });

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
                onOpenStashDetails={() => {}}
            />
        )).tree;

        await act(async () => {
            await Promise.resolve();
        });

        const stashRow = tree.findByProps({ testID: 'workspace-scm-open-stash' });
        const stashRowChildren = React.Children.toArray(stashRow.props.children);
        const trailingSummary = stashRowChildren[1];
        if (!React.isValidElement<{ children?: React.ReactNode }>(trailingSummary)) {
            throw new Error('Unable to find workspace stash summary count container');
        }
        const trailingSummaryChildren = React.Children.toArray(trailingSummary.props.children);
        const trailingCount = trailingSummaryChildren[0];
        if (!React.isValidElement<{ children?: React.ReactNode }>(trailingCount)) {
            throw new Error('Unable to find workspace stash count text');
        }
        expect(trailingCount.props.children).toBe('2');
    });

    it('renders commit composer and stage toggles (atomic)', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        scmWriteEnabledMock = true;

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />
        )).tree;

        expect(tree.findByProps({ testID: 'scm-commit-message' })).toBeTruthy();
        expect(tree.findByProps({ testID: 'scm-commit-submit' })).toBeTruthy();
        expect(tree.findAllByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' })).toHaveLength(0);
    });

    it('hides write controls when source control writes are disabled', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        scmWriteEnabledMock = false;

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />
        )).tree;

        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.fetch' })).toHaveLength(0);
        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.pull' })).toHaveLength(0);
        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.push' })).toHaveLength(0);
        expect(tree.findAllByProps({ testID: 'scm-commit-message' })).toHaveLength(0);
        expect(tree.findAllByProps({ testID: 'scm-commit-submit' })).toHaveLength(0);
        expect(tree.findAllByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' })).toHaveLength(0);
        expect(tree.findAll((node) => typeof node.props?.children === 'string' && String(node.props.children).includes('Enable experimental source control write operations in Settings.'))).toHaveLength(0);
    });

    it('stages a file by updating workspace commit selection (atomic)', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        scmWriteEnabledMock = true;

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />
        )).tree;

        const row = tree.findByProps({ testID: 'scm-change-row-src_a.ts' });
        await act(async () => {
            row.props.onKeyDown({ key: ' ', preventDefault: vi.fn(), stopPropagation: vi.fn() });
            await Promise.resolve();
        });

        expect(markWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalledTimes(1);
        const [scopeArg, pathsArg] = markWorkspaceScmCommitSelectionPathsSpy.mock.calls[0]!;
        expect(scopeArg).toMatchObject({ serverId: 'server', machineId: 'm1', rootPath: '/repo' });
        expect(pathsArg).toEqual(['src/a.ts']);
        expect(removeWorkspaceScmCommitSelectionPatchSpy).toHaveBeenCalledTimes(1);
    });

    it('creates a commit via machine RPC and clears workspace selection', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const renderResult = await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />
        );
        const tree = renderResult.tree;

        const message = tree.findByProps({ testID: 'scm-commit-message' });
        act(() => {
            message.props.onChangeText('Test commit');
        });

        const submit = tree.findByProps({ testID: 'scm-commit-submit' });
        await act(async () => {
            submit.props.onPress();
            await Promise.resolve();
        });

        expect(machineScmCommitCreateSpy).toHaveBeenCalledTimes(1);
        const [machineId, request] = machineScmCommitCreateSpy.mock.calls[0]!;
        expect(machineId).toBe('m1');
        expect(request).toMatchObject({ cwd: '/repo', message: 'Test commit' });
        expect(refreshSpy).toHaveBeenCalled();
        expect(clearWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalled();
        expect(clearWorkspaceScmCommitSelectionPatchesSpy).toHaveBeenCalled();
    });

    it('discards a changed file via machine RPC when the discard button is pressed', async () => {
        workspaceSnapshotMock = createSnapshot();
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        scmWriteEnabledMock = true;
        machineScmChangeDiscardSpy.mockClear();

        const { WorkspaceSourceControlView } = await import('./WorkspaceSourceControlView');

        const tree = (await renderScreen(
            <WorkspaceSourceControlView
                serverId="server"
                machineId="m1"
                rootPath="/repo"
                onOpenFile={() => {}}
            />
        )).tree;

        const discardButton = tree.findByProps({ testID: 'workspace-scm-discard-src_a.ts' });
        await act(async () => {
            discardButton.props.onPress?.({ stopPropagation: vi.fn() });
            await Promise.resolve();
        });

        expect(machineScmChangeDiscardSpy).toHaveBeenCalledTimes(1);
        const firstCall = machineScmChangeDiscardSpy.mock.calls[0];
        expect(firstCall).toBeTruthy();
        const machineId = firstCall?.[0];
        const request = firstCall?.[1];
        expect(machineId).toBe('m1');
        expect(request).toMatchObject({
            cwd: '/repo',
            entries: [{ path: 'src/a.ts', kind: 'modified' }],
        });
        expect(refreshSpy).toHaveBeenCalled();
    });
});
