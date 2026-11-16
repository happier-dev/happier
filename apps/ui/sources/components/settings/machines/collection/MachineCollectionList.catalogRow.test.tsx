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

// Owner 2026-11-15 (A5, ade8e626): a "Machines" label sat over "Your machines". The named group heads its machines.
// (The column's search behind the magnifier is the shell column's one rule: CollectionList.navigationRow.test.ts.)
it('heads the machines with their own group alone', async () => {
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
    const machines = Array.from({ length: 9 }, (_, index) => createMachineFixture({
        id: `build-${index}`, active: false, activeAt: 0,
        metadata: { ...createMachineFixture().metadata!, displayName: `Build ${index}`, host: `build-${index}.internal`, platform: 'linux' },
    }));
    await publishMachineInventoryForTest({ serverId: profileId, accountId: 'account-a' }, machines);
    const screen = await renderScreen(<MachineCollectionRail />);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('machines.destinations.yours');
    });
    expect(screen.findByTestId('settings.machines.rail.machinesLabel')).toBeNull();
});

// Owner 2026-11-15 (B2, ade8e626) and owner bar 11-16: rows follow their content and draw no unlabelled sparklines.
// Only a machine that needs attention has a second line (its word and value); a calm or silent one keeps one line.
it('keeps a second line only for an online machine that needs attention', async () => {
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
    const base = createMachineFixture();
    const online = (id: string, daemonState: Record<string, unknown>) => createMachineFixture({
        id, active: true, activeAt: Date.now(), daemonState: { ...base.daemonState, ...daemonState },
        metadata: { ...base.metadata!, displayName: id, host: `${id}.internal`, platform: 'linux' },
    });
    const host = { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 };
    const reporting = online('reporting-machine', { resources: { v: 1, vitals: { state: 'reporting' }, host, attention: { level: 'needs_you',
        reasons: [{ key: 'memory', level: 'needs_you', since: 1, metric: 'memory', kind: 'memory_pressure', pressure: 'critical', swapping: false }] } } });
    const calm = online('calm-machine', { resources: { v: 1, vitals: { state: 'reporting' }, host, attention: { level: 'calm', reasons: [] } } });
    const silent = online('silent-machine', {});
    await publishMachineInventoryForTest({ serverId: profileId, accountId: 'account-a' }, [reporting, calm, silent]);
    const screen = await renderScreen(<MachineCollectionRail />);
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('silent-machine');
        expect(screen.findByTestId(`settings.machines.row.${profileId}.reporting-machine.summary`)).not.toBeNull();
    });
    expect(screen.findByTestId(`settings.machines.row.${profileId}.silent-machine.summary`)).toBeNull();
    expect(screen.findByTestId(`settings.machines.row.${profileId}.calm-machine.summary`)).toBeNull();
    const silentRow = screen.tree.findAll(node => typeof node.type !== 'string'
        && node.props.testID === `settings.machines.row.${profileId}.silent-machine` && 'title' in node.props)[0]!;
    expect(silentRow.props.subtitle).toBeUndefined();
});
