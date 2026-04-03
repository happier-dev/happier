import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const markWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const unmarkWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const removeWorkspaceScmCommitSelectionPatchSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPathsSpy = vi.fn();
const clearWorkspaceScmCommitSelectionPatchesSpy = vi.fn();
const refreshSpy = vi.fn(async () => {});

const machineScmCommitCreateSpy = vi.fn(async () => ({ success: true, commitSha: 'abc' }));

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
    return createModalModuleMock().module;
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
            const data = Array.isArray(props.data) ? props.data : [];
            const header = props.ListHeaderComponent ? props.ListHeaderComponent : null;
            const empty = data.length === 0 && props.ListEmptyComponent ? props.ListEmptyComponent : null;
            return React.createElement(
                'FlatList',
                props,
                header,
                empty,
                ...data.map((item, index) => React.createElement(
                    'FlatListItem',
                    { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
                    props.renderItem ? props.renderItem({ item, index }) : null,
                )),
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
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmCommitCreate: (...args: any[]) => machineScmCommitCreateSpy(...args),
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
    it('renders commit composer and stage toggles (atomic)', async () => {
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
            />
        )).tree;

        expect(tree.findByProps({ testID: 'scm-commit-message' })).toBeTruthy();
        expect(tree.findByProps({ testID: 'scm-commit-submit' })).toBeTruthy();
        expect(tree.findByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' })).toBeTruthy();
    });

    it('stages a file by updating workspace commit selection (atomic)', async () => {
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
            />
        )).tree;

        const toggle = tree.findByProps({ testID: 'scm-commit-selection-toggle-src_a.ts' });
        await act(async () => {
            toggle.props.onPress({ stopPropagation: vi.fn() });
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
        expect(machineScmCommitCreateSpy.mock.calls[0]?.[0]).toBe('m1');
        expect(machineScmCommitCreateSpy.mock.calls[0]?.[1]).toMatchObject({ cwd: '/repo', message: 'Test commit' });
        expect(refreshSpy).toHaveBeenCalled();
        expect(clearWorkspaceScmCommitSelectionPathsSpy).toHaveBeenCalled();
        expect(clearWorkspaceScmCommitSelectionPatchesSpy).toHaveBeenCalled();
    });
});
