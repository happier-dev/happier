import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotMock: ScmWorkingSnapshot | null = null;
let errorMock: { message: string; errorCode: string | null } | null = null;
const refreshSpy = vi.fn(async () => {});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

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

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: snapshotMock,
        loading: false,
        error: errorMock,
        refresh: refreshSpy,
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('./WorkspaceSourceControlView', () => ({
    WorkspaceSourceControlView: () => React.createElement('WorkspaceSourceControlViewStub'),
}));

function createSnapshot(isRepo: boolean): ScmWorkingSnapshot {
    return {
        projectKey: 'p',
        fetchedAt: 1,
        repo: isRepo
            ? { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' }
            : { isRepo: false, rootPath: null, backendId: null, mode: null },
        capabilities: { readLog: true } as any,
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
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
    } as unknown as ScmWorkingSnapshot;
}

async function render() {
    const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
    return renderScreen(
        <WorkspaceRightPanelGitView
            serverId="s1"
            machineId="m1"
            rootPath="/repo"
            onOpenFile={() => {}}
        />,
    );
}

// Assertions about the notice use `findHostByTestId`: a component that takes a `testID` and then
// renders `null` still matches `findByTestId` by props, so the absence case would pass for the
// wrong reason. Host lookups are the same query restricted to the nodes that actually painted.
/**
 * `F-SCM-2`: `if (error && !snapshot)` was the ONLY place this surface reported a snapshot
 * failure, so a stored snapshot — which `useWorkspaceScmSnapshotController`'s catch leaves in
 * place — made every later refresh failure invisible. The user reads stale content as current.
 */
describe('WorkspaceRightPanelGitView (stale snapshot)', () => {
    it('surfaces a failing refresh while keeping the cached repository content visible', async () => {
        snapshotMock = createSnapshot(true);
        errorMock = { message: 'RPC method not available', errorCode: 'BACKEND_UNAVAILABLE' };
        refreshSpy.mockClear();

        const screen = await render();

        // The failure is visible…
        expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).not.toBeNull();
        // …and the cached content is still there rather than being replaced by an error card.
        expect(screen.findByTestId('project-rightpanel-git-subtab:commit')).not.toBeNull();
        expect(screen.findHostByTestId('workspace-rightpanel-git-unavailable')).toBeNull();

        // The affordance is actionable, not just decorative.
        await screen.pressByTestIdAsync('workspace-rightpanel-git-stale-action');
        expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failing refresh over a cached "not a repository" answer', async () => {
        snapshotMock = createSnapshot(false);
        errorMock = { message: 'RPC method not available', errorCode: 'BACKEND_UNAVAILABLE' };
        refreshSpy.mockClear();

        const screen = await render();

        expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).not.toBeNull();
        expect(screen.getTextContent()).toContain('files.notUnderSourceControl');
    });

    it('stays quiet when the snapshot is current', async () => {
        snapshotMock = createSnapshot(true);
        errorMock = null;
        refreshSpy.mockClear();

        const screen = await render();

        expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).toBeNull();
        expect(screen.findByTestId('project-rightpanel-git-subtab:commit')).not.toBeNull();
    });
});
