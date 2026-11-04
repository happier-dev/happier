import * as React from 'react';
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

it('gives the name the whole row: what the machine reports sits on the line beneath, never beside the name', async () => {
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
    const machine = createMachineFixture({
        id: 'studio-machine', active: false, activeAt: 0,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Studio', host: 'studio.internal', platform: 'linux' },
    });
    storage.setState({
        machines: { [machine.id]: machine },
        machineListByServerId: { [profileId]: [machine] },
        machineListStatusByServerId: { [profileId]: 'idle' },
    });
    const screen = await renderScreen(<MachineCollectionRail />);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('Studio');
    });
    expect(screen.getTextContent()).toContain('studio.internal');
    const row = screen.findByTestId(`settings.machines.row.${profileId}.studio-machine`)!;
    expect(row.props.rightElement).toBeUndefined();
    expect(screen.findByTestId(`settings.machines.row.${profileId}.studio-machine.summary`)).not.toBeNull();
    // The word the summary says for an offline machine; the glyph already says what kind of machine it is.
    expect(screen.getTextContent()).toContain('machineDetailPage.offline');
    expect(screen.getTextContent()).not.toContain('Linux');
    expect(screen.getTextContent()).toContain('settings.overview');
    expect(screen.getTextContent()).not.toContain('allMachines.rowTitle');
});
