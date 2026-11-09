import * as React from 'react';
import { act } from 'react-test-renderer';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installMachinesSettingsCommonModuleMocks } from '../machinesSettingsTestHelpers';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installMachinesSettingsCommonModuleMocks();

// Vitest resolves the Metro lazy-loading boundary; the real Action executor stays beneath it.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const { MachineCollectionRail } = await import('./MachineCollectionList');
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

afterEach(() => standardCleanup());

// A busy Account's Machines publish daemon state all day (resource transitions, guard and managed activity). The
// Machines list column shows names, presence and each row's own summary; a publication that changes none of those
// is not a reason to redraw the column or any row.
it('keeps the Machines list column quiet for daemon publications it does not show', async () => {
    await home.reset();
    const profileId = await home.addHome({
        name: 'Studio Home', serverUrl: 'https://studio.example',
        serverIdentityId: 'studio', accountId: 'account-a', active: true,
    });
    home.answer(profileId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    home.answer(profileId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    home.answer(profileId, '/v1/machines/pools/list', { body: { pools: [] } });
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'studio' } } });
    home.answer(profileId, '/v1/features', { body: features });
    home.answer(profileId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId: profileId, snapshot: { status: 'ready', features } });
    const daemonState = { status: 'running', pid: 7, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'];
    const quiet = createMachineFixture({ id: 'studio-quiet', active: false, activeAt: 0, daemonState, daemonStateVersion: 1,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Quiet', host: 'quiet.internal', platform: 'linux' } });
    let busy: Machine = createMachineFixture({ id: 'studio-busy', active: false, activeAt: 0, daemonState, daemonStateVersion: 1,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Busy', host: 'busy.internal', platform: 'linux' } });
    storage.setState({
        machines: { [quiet.id]: quiet, [busy.id]: busy },
        machineListByServerId: { [profileId]: [quiet, busy] },
        machineListStatusByServerId: { [profileId]: 'idle' },
    });
    let commits = 0;
    const screen = await renderScreen(<React.Profiler id="rail" onRender={() => { commits += 1; }}><MachineCollectionRail /></React.Profiler>);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('Busy');
    });
    const publish = async (sample: number) => {
        busy = { ...busy, daemonStateVersion: (busy.daemonStateVersion ?? 0) + 1,
            daemonState: { ...(busy.daemonState ?? {}), managedActivity: { sampledAt: sample } } as unknown as Machine['daemonState'] };
        await act(async () => storage.getState().applyMachines([busy], false, { sourceServerId: profileId }));
    };
    // Mount-time reads settle on the first publication; the steady state is what every later one costs.
    await publish(0);
    for (let quietTicks = 0, seen = -1; quietTicks < 3;) {
        seen = commits;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
        quietTicks = commits === seen ? quietTicks + 1 : 0;
    }
    commits = 0;
    for (let sample = 1; sample <= 4; sample++) await publish(sample);
    expect(commits).toBe(0);
    // A real change still shows at once.
    await act(async () => storage.getState().applyMachines([{ ...busy, metadataVersion: busy.metadataVersion + 1,
        metadata: { ...busy.metadata!, displayName: 'Renamed' } }], false, { sourceServerId: profileId }));
    expect(screen.getTextContent()).toContain('Renamed');
});
