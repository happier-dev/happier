import * as React from 'react';
import { act } from 'react-test-renderer';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED } from '@happier-dev/protocol/account/encryptionMode';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
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

async function mountRail(onRender: React.ProfilerOnRenderCallback = () => {}) {
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
    const busy = createMachineFixture({ id: 'studio-busy', active: false, activeAt: 0, daemonState, daemonStateVersion: 1,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Busy', host: 'busy.internal', platform: 'linux' } });
    await publishMachineInventoryForTest({ serverId: profileId, accountId: 'account-a' }, [quiet, busy]);
    const screen = await renderScreen(<React.Profiler id="rail" onRender={onRender}><MachineCollectionRail /></React.Profiler>);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('Busy');
    });
    return { screen, profileId, busy };
}

// A busy Account's Machines publish daemon state all day (resource transitions and guard). The
// Machines list column shows names, presence and each row's own summary; a publication that changes none of those
// is not a reason to redraw the column or any row.
it('keeps the Machines list column quiet for daemon publications it does not show', async () => {
    let commits = 0;
    const { screen, profileId, busy: initialBusy } = await mountRail(() => { commits += 1; });
    let busy = initialBusy;
    // A daemon-only publication: the version advances while every fact the column shows stays equal.
    const publish = async () => {
        busy = { ...busy, daemonStateVersion: (busy.daemonStateVersion ?? 0) + 1 };
        await act(async () => storage.getState().applyMachines([busy], false, { sourceServerId: profileId }));
    };
    // Mount-time reads settle on the first publication; the steady state is what every later one costs.
    await publish();
    for (let quietTicks = 0, seen = -1; quietTicks < 3;) {
        seen = commits;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
        quietTicks = commits === seen ? quietTicks + 1 : 0;
    }
    commits = 0;
    for (let sample = 1; sample <= 4; sample++) await publish();
    expect(commits).toBe(0);
    // A real change still shows at once.
    await act(async () => storage.getState().applyMachines([{ ...busy, metadataVersion: busy.metadataVersion + 1,
        metadata: { ...busy.metadata!, displayName: 'Renamed' } }], false, { sourceServerId: profileId }));
    expect(screen.getTextContent()).toContain('Renamed');
});

it('shows and clears enrollment recovery for an offline Machine in the Machines list column', async () => {
    const { screen, profileId, busy } = await mountRail();
    const warning = 'machineDetailPage.recovery.enrollmentRequired';
    const rowLabel = () => screen.tree.findAll(node => node.props.testID === `settings.machines.row.${profileId}.${busy.id}`
        && typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel;
    await waitForHomeGovernance(() => expect(rowLabel()).toContain('settingsOverview.machineOffline'));
    await act(async () => storage.getState().applyMachines([{ ...busy,
        operationProtocolCapabilities: { enrollmentRecovery: ACCOUNT_MODE_DOWNGRADE_UNVERIFIED },
        operationProtocolCapabilitiesRevision: 1,
    }], false, { sourceServerId: profileId, sourceAccountId: 'account-a' }));
    // Readiness is independently visible even though the affected Machine stays offline.
    expect(screen.getTextContent()).toContain(warning);
    expect(rowLabel()).toContain('settingsOverview.machineOffline');
    expect(rowLabel()).toContain(warning);
    await act(async () => storage.getState().applyMachines([{ ...busy,
        operationProtocolCapabilities: { enrollmentRecovery: null },
        operationProtocolCapabilitiesRevision: 2,
    }], false, { sourceServerId: profileId, sourceAccountId: 'account-a' }));
    expect(screen.getTextContent()).not.toContain(warning);
});
