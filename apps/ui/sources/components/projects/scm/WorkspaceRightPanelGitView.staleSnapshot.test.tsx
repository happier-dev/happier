import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmLogListResponseSchema } from '@happier-dev/protocol/scm';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const serverId = 'srv_stale_snapshot';
afterEach(async () => { clearMachineRequestReachabilityForTest(); await home.reset(); });

// Unrelated external Markdown package; fail if this Git path ever invokes it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in Git'); },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
let rootPath = '';
let sequence = 0;
const scope = () => ({ serverId, machineId: 'm1', rootPath });

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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));


vi.mock('./WorkspaceSourceControlView', () => ({
    WorkspaceSourceControlView: () => React.createElement('WorkspaceSourceControlViewStub'),
}));

function createSnapshot(isRepo: boolean): ScmWorkingSnapshot {
    return {
        projectKey: 'p',
        fetchedAt: 1,
        repo: isRepo
            ? { isRepo: true, rootPath, backendId: 'git', mode: '.git' }
            : { isRepo: false, rootPath: null, backendId: null, mode: null },
        capabilities: { ...EMPTY_SCM_CAPABILITIES, readLog: true },
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
    };
}

function answerCurrentSnapshot() {
    rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) {
            return { success: true, snapshot: createSnapshot(true) };
        }
        if (request.method === RPC_METHODS.SCM_LOG_LIST) {
            return ScmLogListResponseSchema.parse({ success: true, entries: [] });
        }
        throw new Error(`Unexpected SCM read: ${request.method}`);
    });
}

async function render() {
    const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
    return renderScreen(
        <WorkspaceRightPanelGitView
            serverId={serverId}
            machineId="m1"
            rootPath={rootPath}
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
    beforeEach(async () => {
        await home.reset();
        await home.addHome({ name: 'Stale snapshot Home', serverUrl: 'https://stale-snapshot.test',
            serverIdentityId: serverId, accountId: 'account-a' });
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        rootPath = `/stale-snapshot-${++sequence}`;
        rpc.mockReset().mockResolvedValue({ success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'RPC method not available' });
    });
    it('surfaces a failing refresh while keeping the cached repository content visible', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope(), createSnapshot(true));

        const screen = await render();

        // The failure is visible…
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).not.toBeNull());
        // …and the cached content is still there rather than being replaced by an error card.
        expect(screen.findHostByTestId('project-rightpanel-git-surface:commit')).not.toBeNull();
        expect(screen.findHostByTestId('workspace-rightpanel-git-unavailable')).toBeNull();

        // The affordance is actionable, not just decorative.
        rpc.mockClear();
        answerCurrentSnapshot();
        await screen.pressByTestIdAsync('workspace-rightpanel-git-stale-action');
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'm1',
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT, payload: expect.objectContaining({ cwd: rootPath }) }));
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).toBeNull());
        expect(storage.getState().getWorkspaceScmSnapshotError(scope())).toBeNull();
    });

    it('surfaces a failing refresh over a cached "not a repository" answer', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope(), createSnapshot(false));

        const screen = await render();

        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).not.toBeNull());
        expect(screen.findHostByTestId('scm-not-repository')).not.toBeNull();
    });

    it('leaves the cause to the page when the announced checkout machine is not answering', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope(), createSnapshot(true));
        // Presence keeps the newest heartbeat; move only the wall clock past any supported grace.
        const lastHeartbeat = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
            const machine = createMachineFixture({ id: 'm1', active: false,
                activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() });
            storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
            await publishMachineInventoryForTest({ serverId, accountId: 'account-a' }, [machine]);
            const { CheckoutReachabilityScope } = await import('@/components/workspaces/reachability/checkoutReachability');
            const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
            const screen = await renderScreen(
                <CheckoutReachabilityScope scope={{ serverId, machineId: 'm1' }}>
                    <WorkspaceRightPanelGitView serverId={serverId} machineId="m1" rootPath={rootPath} onOpenFile={() => {}} />
                </CheckoutReachabilityScope>,
            );

            await vi.waitFor(() => expect(storage.getState().getWorkspaceScmSnapshotError(scope())).not.toBeNull());
            // The page's reachability line already says it and offers Retry: one cause, one message.
            expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).toBeNull();
            expect(screen.findHostByTestId('project-rightpanel-git-surface:commit')).not.toBeNull();
        } finally { vi.useRealTimers(); }
    });

    it('stays quiet when the snapshot is current', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope(), createSnapshot(true));
        answerCurrentSnapshot();

        const screen = await render();

        await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT, payload: expect.objectContaining({ cwd: rootPath }),
        })));
        expect(storage.getState().getWorkspaceScmSnapshotError(scope())).toBeNull();
        expect(screen.findHostByTestId('workspace-rightpanel-git-stale')).toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-git-surface:commit')).not.toBeNull();
    });
});
