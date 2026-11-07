import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { MachineRecentSessionsSection } = await import('./MachineRecentSessionsSection');
const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');

const before = storage.getState();
afterEach(async () => { standardCleanup(); setScreenSharingPrivacyActive(false); await homes.reset(); storage.setState(before); });

it('hides tagged Machine recents before taking five and restores them when sharing ends', async () => {
    const home = await homes.addHome({ name: 'Private Machine Home', serverUrl: 'https://private-machine.test', accountId: 'owner' });
    const rows = Array.from({ length: 7 }, (_, index) => createSessionListRenderableSessionFixture({
        id: `recent-${index}`, updatedAt: index, metadata: { name: `Recent ${index}`, path: '/repo', host: 'host', machineId: 'machine' },
    }));
    storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { [home]: ['private'] } },
        sessionListRowsByServerId: { [home]: Object.fromEntries(rows.map(row => [row.id, row])) } });
    storage.getState().setSessionTagAssignmentsOptimistic(home, 'recent-6', ['private']);
    setScreenSharingPrivacyActive(true);
    const screen = await renderScreen(<AuthProvider initialCredentials={null}><ItemList><MachineRecentSessionsSection serverId={home} machineId="machine" /></ItemList></AuthProvider>);
    const titles = () => screen.root.findAll(node => node.type === Reflect.get(Item, 'type')).map(node => node.props.title);
    expect(titles()).toEqual(['Recent 5', 'Recent 4', 'Recent 3', 'Recent 2', 'Recent 1']);
    await act(async () => { setScreenSharingPrivacyActive(false); });
    expect(titles()).toEqual(['Recent 6', 'Recent 5', 'Recent 4', 'Recent 3', 'Recent 2']);
});

it('follows exact-Home compact membership and visibility while retained full metadata stays stale', async () => {
    const home = await homes.addHome({ name: 'Machine Home', serverUrl: 'https://machine-recents.test', accountId: 'owner' });
    const otherHome = await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-recents.test', accountId: 'owner' });
    const retained = createSessionFixture({ id: 'retained', serverId: home, metadata: {
        path: '/stale', host: 'host', machineId: 'machine-old', name: 'Stale name',
    } });
    const row = createSessionListRenderableSessionFixture({ id: retained.id, metadataLayoutVersion: 1,
        metadataVersion: 2, metadataUnavailable: false, metadata: {
            path: '/fresh', host: 'host', machineId: 'machine', name: 'Fresh name', hiddenSystemSession: false,
        } });
    const cold = createSessionListRenderableSessionFixture({ id: 'cold', updatedAt: 2, metadataLayoutVersion: 1,
        metadataUnavailable: false, metadata: { path: '/cold', host: 'host', machineId: 'machine', name: 'Cold row' } });
    storage.setState({ sessions: { [retained.id]: retained },
        sessionListRowsByServerId: { [home]: { [row.id]: row, [cold.id]: cold }, [otherHome]: {
            twin: createSessionListRenderableSessionFixture({ id: 'twin', metadata: { path: '/twin', host: 'host', machineId: 'machine', name: 'Wrong Home' } }),
        } } });
    const screen = await renderScreen(<AuthProvider initialCredentials={null}><ItemList><MachineRecentSessionsSection serverId={home} machineId="machine" /></ItemList></AuthProvider>);
    const titles = () => screen.root.findAll(node => node.type === Reflect.get(Item, 'type')).map(node => node.props.title);
    expect(titles()).toEqual(['Cold row', 'Fresh name']);
    let commits = 0;
    const stop = screen.subscribe(() => { commits += 1; });
    await act(async () => storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
        [otherHome]: { unrelated: createSessionListRenderableSessionFixture({ id: 'unrelated' }) } } }));
    expect(commits).toBe(0);
    await act(async () => storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
        [home]: { [row.id]: { ...row, metadataVersion: 3, metadata: { ...row.metadata!, hiddenSystemSession: true } }, [cold.id]: cold } } }));
    expect(titles()).toEqual(['Cold row']);
    await act(async () => storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
        [home]: { [row.id]: { ...row, metadataVersion: 4, metadata: { ...row.metadata!, machineId: 'machine-old' } }, [cold.id]: cold } } }));
    expect(titles()).toEqual(['Cold row']);
    expect(storage.getState().sessions[retained.id]).toBe(retained);
    stop();
    await screen.unmount();
});
