import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { scmNetworkSnapshot } from '@/hooks/session/sourceControl/scmNetworkTestHarness';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const machineRpc = vi.hoisted(() => vi.fn());
// Only the external authenticated Machine RPC transport is replaced. Repository
// normalization, scoped publication, hooks, error presentation and Retry remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const { scmStatusSync } = await import('@/scm/scmStatusSync');
const { SessionScmPullRequestDetailsView } = await import('./SessionScmPullRequestDetailsView');

const serverId = 'pr-details-home';
const sessionId = 'pr-details-session';
const initialState = storage.getState();
const failure = { success: false, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, error: 'Source control is unavailable' };
const onCloseTab = () => {};

function view() {
    return <SessionScmPullRequestDetailsView sessionId={sessionId} serverId={serverId} onCloseTab={onCloseTab} />;
}

describe('PR Details repository read state', () => {
    beforeEach(() => {
        const machine = createMachineFixture();
        const session = createSessionFixture({ id: sessionId, serverId, active: true,
            metadata: { machineId: machine.id, host: 'tester.local', path: '/repo' } });
        storage.setState({
            machines: { [machine.id]: machine },
            sessions: { [sessionId]: session },
            machineListByServerId: { [serverId]: [machine] },
            sessionListRowsByServerId: { [serverId]: { [sessionId]: session } },
        });
        machineRpc.mockImplementation(async ({ method }) => {
            if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return failure;
            return { success: true, branches: [] };
        });
    });

    afterEach(() => {
        standardCleanup();
        scmStatusSync.stop(sessionId, serverId);
        projectManager.clear();
        storage.setState(initialState, true);
        machineRpc.mockReset();
    });

    it('replaces a failed first read with the shared error and retries through the real producer', async () => {
        const screen = await renderScreen(view());
        expect(screen.findHostByTestId('git-pull-request-details-loading')).not.toBeNull();
        await act(async () => { await scmStatusSync.invalidateFromUserAndAwait(sessionId, serverId); });
        expect(storage.getState().getSessionProjectScmSnapshot(sessionId, serverId)).toBeNull();
        expect(storage.getState().getSessionProjectScmSnapshotError(sessionId, serverId))
            .toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE });
        expect(screen.findHostByTestId('git-pull-request-details-loading')).toBeNull();
        expect(screen.findHostByTestId('git-pull-request-details-unavailable')).not.toBeNull();

        machineRpc.mockImplementation(async ({ method }) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? { success: true, snapshot: scmNetworkSnapshot } : { success: true, branches: [] });
        await screen.pressByTestIdAsync('git-pull-request-details-unavailable-action');
        await act(async () => { await scmStatusSync.getSync(sessionId, serverId).awaitQueue(); });
        expect(storage.getState().getSessionProjectScmSnapshotError(sessionId, serverId)).toBeNull();
        expect(screen.findHostByTestId('git-pull-request-details-unavailable')).toBeNull();
        expect(screen.findHostByTestId('git-pull-request-form:details')).not.toBeNull();

        // A later refresh error must not discard the usable, already loaded form.
        machineRpc.mockResolvedValue(failure);
        await act(async () => { await scmStatusSync.invalidateFromUserAndAwait(sessionId, serverId); });
        expect(screen.findHostByTestId('git-pull-request-form:details')).not.toBeNull();
        expect(screen.findHostByTestId('git-pull-request-details-unavailable')).toBeNull();
    });

    it('keeps a pending first read loading and accepts a completed non-repository result', async () => {
        let complete = (_response: unknown) => {};
        machineRpc.mockImplementation(({ method }) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ success: true, branches: [] }));
        const screen = await renderScreen(view());
        let pending: Promise<void> | undefined;
        await act(async () => { pending = scmStatusSync.invalidateFromUserAndAwait(sessionId, serverId); });
        expect(screen.findHostByTestId('git-pull-request-details-loading')).not.toBeNull();
        expect(screen.findHostByTestId('git-pull-request-details-unavailable')).toBeNull();
        await act(async () => {
            complete({ success: true, snapshot: { ...scmNetworkSnapshot, repo: { isRepo: false, rootPath: null } } });
            await pending;
        });
        expect(storage.getState().getSessionProjectScmSnapshot(sessionId, serverId)?.repo.isRepo).toBe(false);
        expect(screen.findHostByTestId('git-pull-request-details-loading')).toBeNull();
        expect(screen.findHostByTestId('git-pull-request-details-unavailable')).toBeNull();
        expect(screen.findHostByTestId('git-pull-request-form:details')).not.toBeNull();
    });
});
