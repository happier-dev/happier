import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
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

// AUTO-PATTERNS #176d: the starters wait reads the app union's Machines whose registry sources are unread. A
// registry demand reads those same Machines, also when no installation names that Home (a retired Home id).
it('reads registry sources from each Machine the app union still waits on, beside the installations', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { REGISTRY_SOURCE_PROJECTION_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], snapshots: [],
        materializations: [{ ...materialization('machine-1'), serverIdentityId: 'srv_retired' }] } });
    const value = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        hasEstablishingMembers: true, registrySourcesPending: true,
        registrySourcesPendingTargets: [{ machineId: 'machine-1', serverId: 'home-demand' }],
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: null,
        reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables() {} };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>
        <PluginSurfaceProjectionDemand accountScope={scope} presents="allInstallations" sections={REGISTRY_SOURCE_PROJECTION_SECTIONS} />
    </AppShellPluginUiProjectionValueProvider>);
    const targets = screen.root.findAll(node => typeof node.type === 'function' && node.type.name === 'SourceDemand')
        .map(node => node.props.target as { serverIdentityId: string; machineId: string })
        .map(target => [target.serverIdentityId, target.machineId]).sort();
    expect(targets).toEqual([['home-demand', 'machine-1'], ['srv_retired', 'machine-1']]);
});

// AUTO-FIX-W6 (tab freeze candidate, REVIEW-DELTA2): New app keeps this registry demand mounted for the whole auto
// step, while the step re-renders on each suggestion progress event and the app shell republishes. Measured: none of
// that churn remounts a Machine demand (a remount would restart its acquisition) or redraws one.
it('keeps the auto step\'s registry demand still through its re-renders and republications', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { REGISTRY_SOURCE_PROJECTION_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
    const { createCommittedFiberRenderCounter, readTestRendererRoot } = await import('@/dev/testkit/performance/committedFiberCounts');
    const snapshot = (cursor: number) => ({ availabilityCursor: cursor, intentReads: [], snapshots: [],
        materializations: machineIds.map(materialization) });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: snapshot(1) });
    const value = (targets: readonly { machineId: string; serverId: string }[]) => ({ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        pluginBrowserProjection: null, phase: 'current' as const, hasEstablishingMembers: true, registrySourcesPending: targets.length > 0,
        registrySourcesPendingTargets: targets, interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: null, reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' as const },
        reloadClientExecutables() {} });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    // The step's own state (a progress line) re-renders the screen that hosts the demand.
    const tree = (progress: number, targets: readonly { machineId: string; serverId: string }[]) =>
        <React.Profiler id="auto" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
            <AppShellPluginUiProjectionValueProvider value={value(targets)}>
                {React.createElement('Progress', { step: progress })}
                <PluginSurfaceProjectionDemand accountScope={scope} presents="allInstallations"
                    sections={REGISTRY_SOURCE_PROJECTION_SECTIONS} enabled />
            </AppShellPluginUiProjectionValueProvider>
        </React.Profiler>;
    const owing = [{ machineId: 'machine-1', serverId: 'home-demand' }];
    const screen = await renderScreen(tree(0, owing));
    readRoot = readTestRendererRoot(screen.tree.root);
    const SourceDemand = screen.root.findAll(node => typeof node.type === 'function' && node.type.name === 'SourceDemand')[0]!.type;
    expect(screen.root.findAll(node => node.type === SourceDemand)).toHaveLength(machineIds.length + 1);
    counts.start();
    // 20 progress events, each with a fresh app shell value whose owing targets are equal in content.
    for (let progress = 1; progress <= 20; progress += 1) await screen.update(tree(progress, owing.map(target => ({ ...target }))));
    // 10 Availability republications with unchanged installations.
    for (let cursor = 2; cursor <= 11; cursor += 1) {
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: snapshot(cursor) }); });
    }
    counts.stop();
    const churn = counts.read();
    expect(churn.mounts.get('SourceDemand') ?? 0, 'no Machine demand restarts while the step stays open').toBe(0);
    // Unchanged targets keep their identity, so the held demands do not redraw (before: 5 per event, 150 in all).
    expect(churn.rendersFor(SourceDemand)).toBe(0);
    // The wait ends: the Machine no longer owed drops out, the installations stay held.
    counts.start();
    await screen.update(tree(21, []));
    counts.stop();
    expect(screen.root.findAll(node => node.type === SourceDemand)).toHaveLength(machineIds.length);
    expect(counts.read().mounts.get('SourceDemand') ?? 0).toBe(0);
});
