import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { renderScreen } from '@/dev/testkit';
import { widgetProjectionOf, widgetInstalledPackage, widgetExecutionOrigin } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { parkPluginResourceWatchUntilAbort } from '@/dev/testkit/harness/pluginResourceWatchBoundary';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { mergeInstalledPluginUiProjections, unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolveRightSidebarPluginTabs } from './rightSidebarPluginTabs';
import { PluginRightSidebarCountsState, resolvePluginRightSidebarCountBinding, type PluginRightSidebarCountDescriptor,
    type PluginRightSidebarLabelledCount } from './rightSidebarPluginCount';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const transport = vi.hoisted(() => ({ reads: 0, opens: 0, closes: 0 }));
// Only the daemon network port is replaced. Request admission, contextual
// clients, the shared Resource store, count decoding and Account lifecycle stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ machineId: string; method: string;
        payload: Readonly<Record<string, unknown>>; signal?: AbortSignal }>) => {
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
            transport.reads += 1;
            return { ok: true, resource: { pluginId: 'acme.composer', localId: 'control-state' }, kind: 'config',
                contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
                bytesBase64: Buffer.from('{"running":2,"failed":1}').toString('base64') };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
            transport.opens += 1;
            if (typeof request.payload.subscriptionId !== 'string') throw new Error('Expected a Resource watch id');
            return { ok: true, subscriptionId: request.payload.subscriptionId, digest: `sha256:${'a'.repeat(64)}` };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT) {
            const response = await parkPluginResourceWatchUntilAbort(request.machineId, { ...request.payload, signal: request.signal });
            if (!response.supported) throw new Error('Expected a supported Resource watch boundary');
            return response.result;
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
            transport.closes += 1;
            return { ok: true };
        }
        throw new Error(`Unexpected daemon RPC: ${request.method}`);
    },
}));

installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
const connections: Awaited<ReturnType<typeof restoreServerAccountForTest>>[] = [];
beforeEach(() => { transport.reads = 0; transport.opens = 0; transport.closes = 0; });
afterEach(async () => { for (const connection of connections.splice(0).reverse()) await connection.dispose(); });

it('reads Project counts from the selected Machine without replacing the Account renderer custody', async () => {
    const http = createHomeHubArtifactHttpBoundary('account-a');
    connections.push(await restoreServerAccountForTest({ serverUrl: 'http://count-owner.test', accountId: 'account-a', request: http.request }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real captured Account lifetime');
    const pluginId = 'acme.composer';
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
        displayName: 'Project counts', runtime: { apiVersion: 1 }, contributes: { ui: {
            renderers: [{ id: 'native', kind: 'declarative', root: { kind: 'text', text: 'Project status' } }],
            views: [{ id: 'issues', container: 'appPage', target: { kind: 'project' }, title: 'Issues', renderer: 'native' }],
        } } });
    const entries = projectPluginPortableUiDeclarationsV1(manifest);
    const account = createPluginAccountAvailabilityReader({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [{ pluginId, pluginVersion: manifest.version, displayName: manifest.displayName,
            packageName: '@acme/project-counts', normalizedManifest: manifest, artifactGraphs: [], entriesById: entries }],
    }).readAccountUiProjection();
    if (!account) throw new Error('Expected an admitted Account renderer');
    const occurrenceId = 'selected-machine:42';
    const executionOrigin = widgetExecutionOrigin(pluginId, 'machine-1');
    const machineProjection = (occurrenceId: string) => normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'Project counts'), version: manifest.version,
            occurrenceId, executionOrigin } },
        agentsById: {}, actionsById: {}, settingsById: {}, diagnostics: [],
        resourcesById: { [`${pluginId}/control-state`]: { id: 'control-state', pluginId, occurrenceId, executionOrigin,
            resourceKind: 'config', contentType: 'application/json', scope: 'global' } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(Object.entries(entries)
            .map(([id, entry]) => [id, { ...entry, occurrenceId, executionOrigin,
                runtime: { resourceCapability: { readable: true, dynamic: true } } }])) } },
    }));
    const union = unionPluginUiProjections([{ machineId: 'machine-1', serverId: lifetime.scope.serverId,
        serverIdentityId: executionOrigin.serverIdentityId, phase: 'current', interactionEnabled: true, projection: machineProjection(occurrenceId) }],
    new Map([[pluginId, executionOrigin]])).pluginUiProjection;
    const projection = mergeInstalledPluginUiProjections([account], union);
    const placementId = `surfacePlacement:${pluginId}:issues`;
    const placement = projection?.surfacePlacementsById[placementId];
    if (!placement) throw new Error('Expected the composed Project page');
    expect(placement.occurrenceId).toBe(account.surfacePlacementsById[placementId]?.occurrenceId);
    expect(placement.occurrenceId).not.toBe(occurrenceId);
    const descriptor: PluginRightSidebarCountDescriptor = { tab: { placement,
        plugin: { pluginId, descriptorId: 'issues' }, counts: { resourceId: 'control-state', items: [
            { field: 'running', label: 'Running' }, { field: 'failed', label: 'Failed' },
        ] } }, runtime: { pluginUiProjection: projection, machineId: 'machine-1', serverId: lifetime.scope.serverId,
        accountLifetime: lifetime, interactionEnabled: true } };
    expect(resolvePluginRightSidebarCountBinding(descriptor)).toMatchObject({ machineId: 'machine-1', expectedCallerOccurrenceId: occurrenceId });
    let currentDescriptor = descriptor;
    const observations: Array<readonly PluginRightSidebarLabelledCount[] | undefined> = [];
    const view = () => <PluginContextualResourceStoreProvider>
        <PluginRightSidebarCountsState items={[{ id: 'issues', descriptor: currentDescriptor }]} select={(_count, counts) => counts}>
            {values => { observations.push(values.get('issues')); return null; }}
        </PluginRightSidebarCountsState>
    </PluginContextualResourceStoreProvider>;
    const screen = await renderScreen(view());
    try {
        await vi.waitFor(() => expect(observations.at(-1)).toEqual([
            { field: 'running', label: 'Running', count: 2 }, { field: 'failed', label: 'Failed', count: 1 },
        ]));
        await screen.update(view());
        expect(transport.reads).toBe(1);
        expect(placement.occurrenceId).toBe(account.surfacePlacementsById[placementId]?.occurrenceId);
        const replacement = mergeInstalledPluginUiProjections([account], unionPluginUiProjections([{
            machineId: 'machine-1', serverId: lifetime.scope.serverId, serverIdentityId: executionOrigin.serverIdentityId,
            phase: 'current', interactionEnabled: true, projection: machineProjection('selected-machine:43'),
        }], new Map([[pluginId, executionOrigin]])).pluginUiProjection)!;
        currentDescriptor = { ...descriptor, tab: { ...descriptor.tab, placement: replacement.surfacePlacementsById[placementId]! },
            runtime: { ...descriptor.runtime, pluginUiProjection: replacement } };
        expect(resolvePluginRightSidebarCountBinding(currentDescriptor)).toMatchObject({ expectedCallerOccurrenceId: 'selected-machine:43' });
        await screen.update(view());
        await vi.waitFor(() => expect(transport.reads).toBe(2));
        await vi.waitFor(() => expect(observations.at(-1)?.map(item => item.count)).toEqual([2, 1]));
    } finally { await screen.unmount(); }
});

it.each(['target', 'fields'] as const)('withholds keyed count selections in the first changed %s render but retains equal binding refreshes', async change => {
    const http = createHomeHubArtifactHttpBoundary('account-a');
    connections.push(await restoreServerAccountForTest({ serverUrl: 'http://count-owner.test', accountId: 'account-a', request: http.request }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real captured Account lifetime');
    const pluginId = 'acme.composer';
    const executionOrigin = widgetExecutionOrigin(pluginId, 'machine-1');
    const projection = widgetProjectionOf([], { [pluginId]: { ...widgetInstalledPackage(pluginId, 'Counts'), occurrenceId: 'occurrence-42', executionOrigin } },
        { [buildQualifiedPluginContributionKey({ pluginId, localId: 'control-state' })]: { id: 'control-state', pluginId,
            resourceKind: 'config', contentType: 'application/json', scope: 'session', occurrenceId: 'occurrence-42' } });
    const destination = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'issues', rendererId: 'native',
        container: 'rightSidebarTab', target: { kind: 'session' } })!;
    const [tab] = resolveRightSidebarPluginTabs({ scope: 'session', placements: [{
        id: `surfacePlacement:${pluginId}:issues`, descriptorId: 'issues', pluginId, occurrenceId: 'occurrence-42',
        contributionKind: 'surfacePlacement', binding: destination, target: destination.target,
        renderer: { kind: 'declarative', contributionId: 'native' }, executionOrigin,
        runtime: { resourceCapability: { readable: true, dynamic: true } }, display: { title: 'Issues' },
        availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
    }] });
    const descriptor = (branch: string, field: string) => ({ tab: { ...tab!, counts: { resourceId: 'control-state',
        items: [{ field, label: field }, { field: 'failed', label: 'Failed' }] } },
        sessionId: 'session-1', target: { kind: 'session' as const, sessionId: 'session-1', branch },
        runtime: { pluginUiProjection: projection, machineId: 'machine-1', serverId: lifetime.scope.serverId,
            accountLifetime: lifetime, interactionEnabled: true } });
    type Counts = readonly PluginRightSidebarLabelledCount[] | undefined;
    const select = (_count: number | null, counts?: Counts) => counts;
    const observations: Array<Readonly<{ audience: string; value: Counts; values: ReadonlyMap<string, Counts> }>> = [];
    const view = (audience: string, branch: string, field = 'running') => <PluginContextualResourceStoreProvider>
        <PluginRightSidebarCountsState items={[{ id: 'issues', descriptor: descriptor(branch, field) }]} select={select}>
            {values => { observations.push({ audience, value: values.get('issues'), values }); return null; }}
        </PluginRightSidebarCountsState>
    </PluginContextualResourceStoreProvider>;
    const screen = await renderScreen(view('initial', 'feature/a'));
    try {
        await vi.waitFor(() => expect(observations.at(-1)?.value?.[0]?.count).toBe(2));
        const before = observations.at(-1)!.values;
        await screen.update(view('equal', 'feature/a'));
        expect(observations.find(row => row.audience === 'equal')?.values).toBe(before);
        expect(transport.reads).toBe(1);
        await screen.update(view('changed', change === 'target' ? 'feature/b' : 'feature/a', change === 'fields' ? 'queued' : 'running'));
        expect(observations.find(row => row.audience === 'changed')?.value).toBeUndefined();
        await vi.waitFor(() => expect(observations.at(-1)?.value?.[0]).toMatchObject(change === 'target'
            ? { field: 'running', count: 2 } : { field: 'queued', count: null }));
        expect(transport.reads).toBe(change === 'target' ? 2 : 1);
    } finally { await screen.unmount(); }
});
