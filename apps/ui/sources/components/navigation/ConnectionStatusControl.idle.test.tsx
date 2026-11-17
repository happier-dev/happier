import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
const initialState = storage.getState();

afterEach(async () => {
    standardCleanup();
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialState, true);
});

/** The always-mounted rail control shows a Home's health, not each sync or each daemon heartbeat. */
describe('ConnectionStatusControl closed idle', () => {
    it('does not re-render for a sync timestamp or a Machine heartbeat that changes no shown fact', async () => {
        await homes.reset();
        const homeId = await homes.addHome({ name: 'Studio', serverUrl: 'https://studio.test', accountId: 'studio-account' });
        const scope = { serverId: homeId, accountId: 'studio-account' };
        storage.getState().activateProfileScope(scope);
        const now = Date.now();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: now, updatedAt: now,
            daemonState: { status: 'running' }, daemonStateVersion: 1 });
        storage.getState().applyMachines([machine], true, { sourceServerId: homeId, sourceAccountId: 'studio-account' });
        storage.getState().markMachineListSettled(homeId);
        storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null, lastSyncAt: now });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        publishAppliedActiveServerRuntimeAvailability(true);

        let commits = 0;
        await renderScreen(<InjectedAuthProvider credentials={null}>
            <React.Profiler id="control" onRender={() => { commits += 1; }}>
                <ConnectionStatusControl variant="sidebar" />
            </React.Profiler>
        </InjectedAuthProvider>);
        const settled = commits;

        await act(async () => { storage.setState({ lastSyncAt: now + 5_000 }); });
        expect(commits).toBe(settled);

        await act(async () => {
            storage.getState().applyMachines([{ ...machine, activeAt: now + 20_000, updatedAt: now + 20_000, daemonStateVersion: 2,
                daemonState: { status: 'running' } }], false,
            { sourceServerId: homeId, sourceAccountId: 'studio-account' });
        });
        expect(commits).toBe(settled);
    });
});
