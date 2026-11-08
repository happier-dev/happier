import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { PluginSurfaceProjectionDemand } from './PluginSurfaceProjectionDemand';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

afterEach(() => { standardCleanup(); clearPluginAccountAvailabilityProjection(); });

const scope = { serverId: 'home-demand', accountId: 'account-demand' };
const pluginId = 'acme.widgets';
const machineIds = ['machine-1', 'machine-2', 'machine-3', 'machine-4'];
const materialization = (machineId: string): PluginMachineMaterializationV1 => ({ serverIdentityId: 'srv_demand', machineId,
    materializationId: `install-${machineId}`, pluginId, version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
    enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] });

it('holds one Machine demand per installation however many presented surfaces of the plugin ask for it', async () => {
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: machineIds.map(materialization), snapshots: [] } });
    const demands = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
        .findAll(node => typeof node.type === 'function' && node.type.name === 'SourceDemand').length;
    const bodies = (count: number) => <>{Array.from({ length: count }, (_, index) =>
        <PluginSurfaceProjectionDemand key={index} pluginId={pluginId} accountScope={scope} presents="allInstallations" />)}</>;
    const screen = await renderScreen(bodies(1));
    expect(demands(screen)).toBe(machineIds.length);
    await screen.update(bodies(3));
    expect(demands(screen)).toBe(machineIds.length);
    // The surface that held the demands leaves; a remaining one takes them over.
    await screen.update(<>{[1, 2].map(index =>
        <PluginSurfaceProjectionDemand key={index} pluginId={pluginId} accountScope={scope} presents="allInstallations" />)}</>);
    expect(demands(screen)).toBe(machineIds.length);
    await screen.update(React.createElement('NoSurfaces'));
    expect(demands(screen)).toBe(0);
});

// Administration's selection is plugin-scoped: N presented bodies of one plugin share one selected-origin
// decider (and its one UI-section demand), handed to a surviving body when the deciding one leaves.
it('runs one selected-origin decider per plugin however many presented surfaces of it ask', async () => {
    replacePluginAccountAvailabilityProjection({ scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: machineIds.map(materialization), snapshots: [] } });
    const deciders = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
        .findAll(node => typeof node.type === 'function' && node.type.name === 'SelectedOriginDemand').length;
    const bodies = (keys: readonly number[]) => <>{keys.map(key =>
        <PluginSurfaceProjectionDemand key={key} pluginId={pluginId} accountScope={scope} />)}</>;
    const screen = await renderScreen(bodies([0]));
    expect(deciders(screen)).toBe(1);
    await screen.update(bodies([0, 1, 2]));
    expect(deciders(screen)).toBe(1);
    await screen.update(bodies([1, 2]));
    expect(deciders(screen)).toBe(1);
    await screen.update(React.createElement('NoSurfaces'));
    expect(deciders(screen)).toBe(0);
});

// A surface whose own target set changes keeps hosting the Machines it still needs: another surface's
// shared Machines keep their host instead of rotating (each rotation restarts that Machine's demand).
it('keeps every shared Machine demand on its host when one surface gains a target', async () => {
    const otherPluginId = 'acme.other';
    const snapshot = (extra: boolean) => ({ availabilityCursor: extra ? 2 : 1, intentReads: [], snapshots: [],
        materializations: [...machineIds.map(materialization),
            ...extra ? [{ ...materialization('machine-5'), pluginId: otherPluginId, materializationId: 'install-other' }] : []] });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: snapshot(false) });
    // The Store presents every plugin's installations; the plugin page presents its own plugin's.
    const surfaces = <>
        <PluginSurfaceProjectionDemand key="store" accountScope={scope} />
        <PluginSurfaceProjectionDemand key="page" pluginId={pluginId} accountScope={scope} presents="allInstallations" />
    </>;
    const screen = await renderScreen(surfaces);
    const hosts = () => Object.fromEntries(screen.root.findAll(node => typeof node.type === 'function' && node.type.name === 'SourceDemand')
        .map(node => {
            let host = node.parent;
            while (host && host.type !== PluginSurfaceProjectionDemand) host = host.parent;
            return [node.props.target.machineId as string, host === null ? null : host.props.pluginId === undefined ? 'store' : 'page'];
        }));
    expect(hosts()).toEqual(Object.fromEntries(machineIds.map(id => [id, 'store'])));
    replacePluginAccountAvailabilityProjection({ scope, snapshot: snapshot(true) });
    await screen.update(surfaces);
    expect(hosts()).toEqual({ ...Object.fromEntries(machineIds.map(id => [id, 'store'])), 'machine-5': 'store' });
});
