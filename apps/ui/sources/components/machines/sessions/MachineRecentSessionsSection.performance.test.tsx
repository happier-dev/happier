import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const machineTargets = await import('@/sync/domains/session/resolveMachineTargetForSessionFromState');
const { MachineRecentSessionsSection } = await import('./MachineRecentSessionsSection');

const before = storage.getState();
afterEach(async () => { standardCleanup(); vi.restoreAllMocks(); await homes.reset(); storage.setState(before); });

it('does no selected-Machine projection or rendering for unrelated arrivals, and releases hidden demand', async () => {
    const home = await homes.addHome({ name: 'Recent sessions Home', serverUrl: 'https://recents-performance.test', accountId: 'owner' });
    const otherHome = await homes.addHome({ name: 'Other recent sessions Home', serverUrl: 'https://other-recents-performance.test', accountId: 'owner' });
    const rows = Array.from({ length: 7 }, (_, index) => createSessionListRenderableSessionFixture({
        id: `recent-${index}`, updatedAt: index + 1,
        metadata: { name: `Recent ${index}`, path: '/repo', host: 'host', machineId: 'machine' },
    }));
    const unrelated = createSessionListRenderableSessionFixture({ id: 'unrelated', updatedAt: 1,
        metadata: { name: 'Other Machine', path: '/other', host: 'other', machineId: 'other-machine' } });
    storage.getState().applyServerScopedSessionListRows(home, [...rows, unrelated], { source: 'rowOnly', mode: 'append' });
    storage.getState().applyServerScopedSessionListRows(otherHome, [unrelated], { source: 'rowOnly', mode: 'append' });
    // Observe the real display-attribution owner without replacing its behavior.
    const attribution = vi.spyOn(machineTargets, 'resolveDisplayMachineIdForSessionFromState');
    let setPresented: React.Dispatch<React.SetStateAction<boolean>> = () => { throw new Error('Surface not mounted'); };
    function Surface() {
        const [presented, update] = React.useState(true);
        setPresented = update;
        return <AuthProvider initialCredentials={null}>
            <PluginSurfaceFocusEligibilityProvider active={presented}>
                <ItemList><MachineRecentSessionsSection serverId={home} machineId="machine" /></ItemList>
            </PluginSurfaceFocusEligibilityProvider>
        </AuthProvider>;
    }
    const screen = await renderScreen(<Surface />);
    const titles = () => screen.root.findAll(node => node.type === Reflect.get(Item, 'type')).map(node => node.props.title);
    expect(titles()).toEqual(['Recent 6', 'Recent 5', 'Recent 4', 'Recent 3', 'Recent 2']);
    const selectedProjections = () => attribution.mock.calls.filter(([input]) => input.sessionId?.startsWith('recent-')).length;
    expect(selectedProjections()).toBeGreaterThan(0);
    let commits = 0;
    const stop = screen.subscribe(() => { commits += 1; });
    const publishUnrelated = async (offset: number) => {
        for (let index = 0; index < 4; index += 1) {
            // Interleave real publications outside the subscribed Home: the next local delta
            // must stay incremental even though the global revision has advanced twice.
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(otherHome,
                [{ sessionId: unrelated.id, patch: { updatedAt: offset + index, metadataVersion: offset + index,
                    metadata: { ...unrelated.metadata!, name: `Other Home ${offset + index}` } } }]));
            const previous = storage.getState().sessionListRowsByServerId[home][unrelated.id];
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(home,
                [{ sessionId: unrelated.id, patch: { updatedAt: offset + index, metadataVersion: offset + index,
                    metadata: { ...unrelated.metadata!, name: `Other Machine ${offset + index}` } } }]));
            expect(storage.getState().sessionListRowsByServerId[home][unrelated.id]).not.toBe(previous);
        }
    };

    attribution.mockClear();
    await publishUnrelated(10);
    expect.soft({ attributionReads: attribution.mock.calls.length, selectedProjections: selectedProjections(), commits })
        .toEqual({ attributionReads: 4, selectedProjections: 0, commits: 0 });
    expect(titles()).toEqual(['Recent 6', 'Recent 5', 'Recent 4', 'Recent 3', 'Recent 2']);

    await act(async () => setPresented(false));
    attribution.mockClear(); commits = 0;
    await publishUnrelated(20);
    expect.soft({ attributionReads: attribution.mock.calls.length, commits }).toEqual({ attributionReads: 0, commits: 0 });
    await act(async () => storage.getState().applyServerScopedSessionListRowPatches(home,
        [{ sessionId: rows[0].id, patch: { updatedAt: 100 } }]));
    expect.soft({ attributionReads: attribution.mock.calls.length, commits }).toEqual({ attributionReads: 0, commits: 0 });

    await act(async () => setPresented(true));
    expect(titles()).toEqual(['Recent 0', 'Recent 6', 'Recent 5', 'Recent 4', 'Recent 3']);
    attribution.mockClear(); commits = 0;
    await act(async () => storage.getState().applyServerScopedSessionListRowPatches(home,
        [{ sessionId: rows[1].id, patch: { updatedAt: 101 } }]));
    expect(titles()).toEqual(['Recent 1', 'Recent 0', 'Recent 6', 'Recent 5', 'Recent 4']);
    expect(selectedProjections()).toBe(1);
    expect(commits).toBeGreaterThan(0);
    stop();
    await screen.unmount();
});
