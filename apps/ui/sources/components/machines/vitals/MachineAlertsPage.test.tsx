import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { withdrawMachinePresenceForScope, clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';
import { linkMachineActivity } from '@/sync/domains/machines/machineActivity';

import { describeMachineAlertsRow } from './machineAlertsPresentation';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { MachineAlertsPage, MachineOfflineAlertRow } = await import('./MachineAlertsPage');

const before = storage.getState();
afterEach(async () => { standardCleanup(); await homes.reset(); clearMachineRequestReachabilityForTest(); storage.setState(before); });

it('keeps the known offline-alert row while Account consent is unavailable and restores the real setting', async () => {
    const machine = createMachineFixture({ id: 'machine', isShared: false });
    storage.setState({ profileScope: { serverId: 'home-a', accountId: 'owner' }, settingsScope: null });
    const screen = await renderScreen(<ItemList><MachineOfflineAlertRow serverId="home-a" machine={machine} machineName="edge-1" /></ItemList>);
    expect(screen.findByTestId('machine-alerts-offline')).not.toBeNull();
    expect(screen.findByTestId('machine-alerts-offline-switch')).toBeNull();
    await act(async () => storage.setState({ settingsScope: { serverId: 'home-a', accountId: 'owner' },
        settings: settingsParse({ machineOfflineAlertsV1: { machineIds: ['machine'] } }) }));
    expect(screen.findByTestId('machine-alerts-offline-switch')?.props.value).toBe(true);
    await act(async () => storage.setState({ settingsScope: null }));
    expect(screen.findByTestId('machine-alerts-offline')).not.toBeNull();
    expect(screen.findByTestId('machine-alerts-offline-switch')).toBeNull();
    await screen.unmount();
});

it('keeps recipient offline-alert consent read-only even when Account consent cannot be read', async () => {
    storage.setState({ settingsScope: null });
    const machine = createMachineFixture({ isShared: true });
    const screen = await renderScreen(<ItemList><MachineOfflineAlertRow serverId="home-a" machine={machine} machineName="edge-1" /></ItemList>);
    expect(screen.findByTestId('machine-alerts-offline')).not.toBeNull();
    expect(screen.findByTestId('machine-alerts-offline-switch')).toBeNull();
    await screen.unmount();
});

it('keeps alert rules and editing available across Account socket withdrawal', async () => {
    const serverId = await homes.addHome({ name: 'Alerts Home', serverUrl: 'https://machine-alerts.test', accountId: 'owner' });
    const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { memory: { enabled: true } } });
    const machine = createMachineFixture({ id: 'machine', isShared: false, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, resourcesPolicyV1: policy },
        daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } } } });
    storage.setState({ profileScope: { serverId, accountId: 'owner' },
        settingsScope: { serverId, accountId: 'owner' }, settings: settingsParse({}),
        machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    const screen = await renderScreen(<ItemList><MachineAlertsPage serverId={serverId} machine={machine} machineName="edge-1" /></ItemList>);
    const intro = () => screen.root.findAll(node => node.type === Reflect.get(ItemGroup, 'type'))[0]?.props.description;
    await act(async () => { await waitForHomeGovernance(() => expect(screen.findByTestId('machine-alerts-memory-switch')?.props.disabled).toBe(false)); });
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.value).toBe(true);
    expect(intro()).toContain(describeMachineAlertsRow({ machineName: 'edge-1', alerts: policy.alerts, readOnlyReason: null }));
    const enabledIntro = intro();
    const disabled = MachineResourcesPolicyV1Schema.parse({ v: 1 });
    await act(async () => storage.getState().applyMachines([{ ...machine, metadataVersion: 2,
        metadata: { ...machine.metadata!, resourcesPolicyV1: disabled } }], true, { sourceServerId: serverId }));
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.value).toBe(false);
    expect(intro()).toContain(describeMachineAlertsRow({ machineName: 'edge-1', alerts: disabled.alerts, readOnlyReason: null }));
    expect(intro()).not.toBe(enabledIntro);
    await act(async () => { withdrawMachinePresenceForScope({ serverId, accountId: 'owner' }); });
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.disabled).toBe(false);
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.value).toBe(false);
    await screen.unmount();
});

it('keeps retained alert rules read-only while Machine reachability is unknown', async () => {
    const serverId = await homes.addHome({ name: 'Alerts Home', serverUrl: 'https://machine-alerts-unknown.test', accountId: 'owner' });
    const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, alerts: { memory: { enabled: true } } });
    const machine = createMachineFixture({ id: 'machine', isShared: false, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, resourcesPolicyV1: policy },
        daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } } } });
    const retained = { ...machine, id: 'unobserved-machine' };
    linkMachineActivity(retained, { ...retained });
    storage.setState({ profileScope: { serverId, accountId: 'owner' },
        settingsScope: { serverId, accountId: 'owner' }, settings: settingsParse({}),
        machines: { [machine.id]: machine, [retained.id]: retained }, machineListByServerId: { [serverId]: [machine, retained] } });
    const screen = await renderScreen(<ItemList><MachineAlertsPage serverId={serverId} machine={machine} machineName="edge-1" /></ItemList>);
    await act(async () => { await waitForHomeGovernance(() => expect(screen.findByTestId('machine-alerts-memory-switch')?.props.disabled).toBe(false)); });
    await act(async () => screen.update(<ItemList><MachineAlertsPage serverId={serverId} machine={retained} machineName="edge-2" /></ItemList>));
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.disabled).toBe(true);
    expect(screen.root.findAll(node => node.type === Reflect.get(ItemGroup, 'type'))[0]?.props.description).toBe(t('common.unavailable'));
    expect(screen.findByTestId('machine-alerts-memory-switch')?.props.value).toBe(true);
    await screen.unmount();
});
