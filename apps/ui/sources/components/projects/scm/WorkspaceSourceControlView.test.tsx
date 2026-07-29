import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmCommitCreate } from '@/sync/ops/scm/machineScm';
import type { machineScmChangeDiscard } from '@/sync/ops/scm/machineScm';
import type { machineScmRemoteFetch, machineScmRemotePull, machineScmRemotePush } from '@/sync/ops/scm/machineScm';
import type { ScmStashListResponse } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const markWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const unmarkWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const removeWorkspaceScmCommitSelectionPatchSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPatchesSpy = vi.fn();
const refreshSpy = vi.fn(async () => {});
const setScmRemoteConfirmPolicySpy = vi.fn();
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const modalAlertAsyncSpy = vi.hoisted(() => vi.fn(async (...args: Parameters<import('@/modal').IModal['alertAsync']>) => {
    const buttons = args[2];
    buttons?.[1]?.onPress?.();
}));
const machineScmStashListSpy = vi.fn(async (): Promise<ScmStashListResponse> => ({
    success: true,
    stashes: [],
    totalCount: 0,
}));
type MachineScmChangeDiscard = typeof machineScmChangeDiscard;
const machineScmChangeDiscardSpy = vi.fn<MachineScmChangeDiscard>(async () => ({ success: true } as any));
type MachineScmRemoteFetch = typeof machineScmRemoteFetch;
type MachineScmRemotePull = typeof machineScmRemotePull;
type MachineScmRemotePush = typeof machineScmRemotePush;
const machineScmRemoteFetchSpy = vi.fn<MachineScmRemoteFetch>(async () => ({ success: true, stdout: '' }));
const machineScmRemotePullSpy = vi.fn<MachineScmRemotePull>(async () => ({ success: true, stdout: '' }));
const machineScmRemotePushSpy = vi.fn<MachineScmRemotePush>(async () => ({ success: true, stdout: '' }));

type MachineScmCommitCreate = typeof machineScmCommitCreate;
const machineScmCommitCreateSpy = vi.fn<MachineScmCommitCreate>(async () => ({ success: true, commitSha: 'abc' }));


vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
    const React = await import('react');
    return {
        DropdownMenu: (props: any) => React.createElement(
            'DropdownMenu',
            props,
            typeof props.trigger === 'function'
                ? props.trigger({
                    open: false,
                    toggle: vi.fn(),
                    openMenu: vi.fn(),
                    closeMenu: vi.fn(),
                    selectedItem: props.items.find((item: any) => item.id === props.selectedId) ?? null,
                })
                : props.trigger,
        ),
    };
});

vi.mock('@/components/workspaces/scm/changes/ScmChangeOverflowMenu', async () => {
    const React = await import('react');
    return {
        ScmChangeOverflowMenu: (props: any) => React.createElement('ScmChangeOverflowMenu', props),
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: {
            alertAsync: modalAlertAsyncSpy,
            confirm: modalConfirmSpy,
        },
    }).module;
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

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: (props: any) => {
        const data = Array.isArray(props.data) ? props.data : [];
        const items = data.map((item: unknown, index: number) => React.createElement(
            'FlatListItem',
            { key: props.keyExtractor?.(item, index) ?? String(index) },
            props.renderItem?.({ item, index }),
        ));
        return React.createElement('FlatList', props, props.ListHeaderComponent, ...items);
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabledMock,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmCommitCreate: (...args: Parameters<typeof machineScmCommitCreateSpy>) => machineScmCommitCreateSpy(...args),
    machineScmStashList: (...args: Parameters<typeof machineScmStashListSpy>) => machineScmStashListSpy(...args),
    machineScmChangeDiscard: (...args: Parameters<typeof machineScmChangeDiscardSpy>) => machineScmChangeDiscardSpy(...args),
    machineScmRemoteFetch: (...args: Parameters<typeof machineScmRemoteFetchSpy>) => machineScmRemoteFetchSpy(...args),
    machineScmRemotePull: (...args: Parameters<typeof machineScmRemotePullSpy>) => machineScmRemotePullSpy(...args),
    machineScmRemotePush: (...args: Parameters<typeof machineScmRemotePushSpy>) => machineScmRemotePushSpy(...args),
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
let scmRemoteConfirmPolicySetting = 'always';
let scmPushRejectPolicySetting = 'manual';
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
            if (key === 'scmRemoteConfirmPolicy') return scmRemoteConfirmPolicySetting;
            if (key === 'scmPushRejectPolicy') return scmPushRejectPolicySetting;
            return null;
        },
        useSettingMutable: (key: any) => {
            if (key === 'scmRemoteConfirmPolicy') {
                return [scmRemoteConfirmPolicySetting, setScmRemoteConfirmPolicySpy];
            }
            return [null, vi.fn()];
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

function createMultiFileSnapshot(): ScmWorkingSnapshot {
    return {
        ...createSnapshot(),
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
            {
                path: 'src/b.ts',
                previousPath: null,
                kind: 'modified',
                includeStatus: '',
                pendingStatus: '',
                hasIncludedDelta: false,
                hasPendingDelta: true,
                stats: {
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 3,
                    pendingRemoved: 1,
                    isBinary: false,
                },
            },
        ],
        totals: {
            includedFiles: 0,
            pendingFiles: 2,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 5,
            pendingRemoved: 2,
        },
    };
}

function createLargeChangedFilesSnapshot(count = 30): ScmWorkingSnapshot {
    const base = createSnapshot();
    return {
        ...base,
        entries: Array.from({ length: count }, (_, index) => ({
            path: `src/file-${index}.ts`,
            previousPath: null,
            kind: 'modified',
            includeStatus: '',
            pendingStatus: '',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 0,
                isBinary: false,
            },
        })),
        totals: {
            includedFiles: 0,
            pendingFiles: count,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: count,
            pendingRemoved: 0,
        },
    };
}

describe('WorkspaceSourceControlView', () => {
    beforeEach(() => {
        markWorkspaceScmCommitSelectionPathsSpy.mockClear();
        unmarkWorkspaceScmCommitSelectionPathsSpy.mockClear();
        removeWorkspaceScmCommitSelectionPatchSpy.mockClear();
        clearWorkspaceScmCommitSelectionPathsSpy.mockClear();
        clearWorkspaceScmCommitSelectionPatchesSpy.mockClear();
        refreshSpy.mockClear();
        machineScmStashListSpy.mockClear();
        machineScmChangeDiscardSpy.mockClear();
        machineScmCommitCreateSpy.mockClear();
        machineScmRemoteFetchSpy.mockClear();
        machineScmRemotePullSpy.mockClear();
        machineScmRemotePushSpy.mockClear();
        setScmRemoteConfirmPolicySpy.mockClear();
        modalConfirmSpy.mockClear();
        modalAlertAsyncSpy.mockClear();
        scmRemoteConfirmPolicySetting = 'always';
        scmPushRejectPolicySetting = 'manual';
        scmWriteEnabledMock = true;
    });

    it('renders local changed-file affordances without remote update actions', async () => {
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
        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.fetch' })).toHaveLength(0);
        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.pull' })).toHaveLength(0);
        expect(tree.findAllByProps({ accessibilityLabel: 'files.sourceControlOperations.actions.push' })).toHaveLength(0);
    });

    it('keeps changed-file list initial rendering bounded on large repositories', async () => {
        workspaceSnapshotMock = createLargeChangedFilesSnapshot();
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

        const changedFilesList = tree.findByType('FlatList');

        expect(changedFilesList.props.initialNumToRender).toBe(12);
        expect(changedFilesList.props.maxToRenderPerBatch).toBe(12);
        expect(changedFilesList.props.windowSize).toBe(5);
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

        expect(machineScmStashListSpy).toHaveBeenCalledWith('m1', { cwd: '/repo' }, { serverId: 'server' });

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

    it('reveals stage toggles after entering selection mode when write operations are enabled', async () => {
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
        // Stage toggles are opt-in: hidden until the user enters selection mode.
        expect(tree.findAllByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' })).toHaveLength(0);

        const enterSelection = tree.findByProps({ testID: 'scm-commit-enter-selection' });
        act(() => {
            enterSelection.props.onPress();
        });

        expect(tree.findByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' })).toBeTruthy();
    });

    it('renders a commit-adjacent push shortcut when the workspace branch is safely ahead', async () => {
        workspaceSnapshotMock = {
            ...createSnapshot(),
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                remotes: [{ name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' }],
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 0, detached: false },
        };
        commitSelectionPaths = [];
        commitSelectionPatches = [];
        scmCommitStrategySetting = 'atomic';
        scmRemoteConfirmPolicySetting = 'always';
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

        const pushShortcut = tree.findByProps({ testID: 'scm-commit-adjacent-push' });
        expect(pushShortcut.props.accessibilityState).toMatchObject({ disabled: false, busy: false });

        await act(async () => {
            pushShortcut.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalAlertAsyncSpy).toHaveBeenCalledTimes(1);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(machineScmRemotePushSpy).toHaveBeenCalledWith('m1', {
            cwd: '/repo',
            remote: 'origin',
            branch: 'main',
        }, { serverId: 'server' });
        expect(refreshSpy).toHaveBeenCalled();
    });

    it('filters workspace changes to selected-for-commit files and select-all uses the current view', async () => {
        workspaceSnapshotMock = createMultiFileSnapshot();
        commitSelectionPaths = ['src/b.ts'];
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

        const viewModeMenu = tree.findByType('DropdownMenu' as any);
        expect(viewModeMenu.props.selectedId).toBe('repository');
        expect(viewModeMenu.props.items.map((item: { id: string }) => item.id)).toEqual([
            'repository',
            'selected',
        ]);

        act(() => {
            viewModeMenu.props.onSelect('selected');
        });

        const changedFilesList = tree.findByType('FlatList' as any);
        expect(changedFilesList.props.data.map((file: { fullPath: string }) => file.fullPath)).toEqual(['src/b.ts']);

        const currentViewCount = tree.findAll((node) => node.props?.children === '1');
        expect(currentViewCount.length).toBeGreaterThan(0);

        const selectAllButton = tree.findByProps({ accessibilityLabel: 'common.all' });
        act(() => {
            selectAllButton.props.onPress();
        });

        expect(markWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'server', machineId: 'm1', rootPath: '/repo' }),
            ['src/b.ts'],
        );
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

    it('discards a changed file via machine RPC through the overflow menu', async () => {
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

        // Revert now lives in the overflow menu (no inline discard button on the row).
        const overflowMenu = tree
            .findAllByType('ScmChangeOverflowMenu' as never)
            .find((node) => node.props.filePath === 'src/a.ts');
        expect(typeof overflowMenu?.props.onDiscard).toBe('function');

        await act(async () => {
            overflowMenu!.props.onDiscard();
            for (let i = 0; i < 8; i++) {
                await Promise.resolve();
            }
        });

        expect(machineScmChangeDiscardSpy).toHaveBeenCalledTimes(1);
        const firstCall = machineScmChangeDiscardSpy.mock.calls[0];
        expect(firstCall?.[0]).toBe('m1');
        expect(firstCall?.[1]).toMatchObject({
            cwd: '/repo',
            entries: [{ path: 'src/a.ts', kind: 'modified' }],
        });
        expect(refreshSpy).toHaveBeenCalled();
    });
});
