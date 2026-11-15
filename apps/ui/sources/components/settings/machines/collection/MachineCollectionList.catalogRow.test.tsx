import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
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

const { MachineCollectionRail, MachineCollectionList } = await import('./MachineCollectionList');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

afterEach(() => standardCleanup());

it.each([false, true])('gives the machine its identity glyph and whole name row (this computer: %s)', async isThisComputer => {
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
    await publishMachineInventoryForTest({ serverId: profileId, accountId: 'account-a' }, [machine]);
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { publishLocalDaemonStatus } = await import('../localControl/localDaemonSharedState');
    publishLocalDaemonStatus(getSystemTasksRunner(), { machineId: isThisComputer ? machine.id : null });
    const screen = await renderScreen(<MachineCollectionRail />);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('Studio');
    });
    const row = screen.tree.findAll(node => typeof node.type !== 'string'
        && node.props.testID === `settings.machines.row.${profileId}.studio-machine` && 'title' in node.props)[0]!;
    // One line in the rail: the host stays in the row's accessible name, not on a second line.
    expect(screen.getTextContent()).not.toContain('studio.internal');
    expect(row.props.accessibilityLabel).toContain('studio.internal');
    const { Icon } = await import('@/components/ui/icons/Icon');
    expect(row.findAll(node => node.type === Icon).some(node => node.props.name === (isThisComputer ? 'laptop' : 'hard-drives'))).toBe(true);
    expect(row.props.rightElement).toBeUndefined();
    // An offline machine has no live summary: its one word stands at the row's end; the glyph says what kind it is.
    expect(screen.findByTestId(`settings.machines.row.${profileId}.studio-machine.summary`)).toBeNull();
    expect(row.props.detail).toBe('machineDetailPage.offline');
    expect(row.props.accessibilityLabel).toContain('settingsOverview.machineOffline');
    expect(screen.getTextContent()).not.toContain('Linux');
    expect(screen.getTextContent()).not.toContain('managedRetention.pageDescriptionShort');
    expect(screen.getTextContent()).toContain('settings.overview');
    expect(screen.getTextContent()).not.toContain('allMachines.rowTitle');
    // React Test Renderer erases the component's props at its instance boundary.
    const listProps = screen.tree.findByType(MachineCollectionList).props as React.ComponentProps<typeof MachineCollectionList>;
    await screen.update(<MachineCollectionList {...listProps} variant="page" />);
    const pageRow = screen.findByTestId(`settings.machines.row.${profileId}.studio-machine`)!;
    expect(pageRow.findAll(node => node.type === Icon).some(node => node.props.name === (isThisComputer ? 'laptop' : 'hard-drives'))).toBe(true);
});
