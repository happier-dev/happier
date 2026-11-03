import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiTargetedContributionsReadResponseSchema, PluginProjectedActionV2Schema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { act, renderScreen, flushHookEffects, standardCleanup, createDeferred } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createPluginUiExecutionOriginCandidatePublication, unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { PluginHostedWebPane } from '@/components/plugins/hostedWeb/PluginHostedWebPane';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { WidgetSurface } from './WidgetSurface';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

afterEach(async () => { await standardCleanup(); });

it.each([{ count: 1, delayed: false }, { count: 2, delayed: false }, { count: 1, delayed: true }])(
    'loads an unpinned Home widget on $count eligible Machines (late caller facts: $delayed)', async ({ count, delayed }) => {
    const pluginId = 'acme.widget-run-on';
    const accountId = 'widget-viewer';
    const serverIdentityId = 'srv_widget_auto';
    const ids = ['widget-a', 'widget-b'].slice(0, count);
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-auto.test', serverIdentityId, accountId,
        request: async (url, init) => new URL(String(url)).pathname === '/v1/machines'
            ? Response.json({ machines: ids.map(id => createPlainMachineRowFixture({ id, accountId })) }) : http.request(url, init) });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const surface = { pluginId, localId: 'latest' };
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'widget-auto-root' };
    const union = unionPluginUiProjections(ids.map(machineId => {
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId, pluginId, sourceCustody } });
        const occurrenceId = `widget-${machineId}`;
        const projection = widgetProjectionOf([{ ...surface, target: 'app', occurrenceId, resources: [surface] }], {
            [pluginId]: { id: pluginId, displayName: 'Latest entries', version: '1.0.0', enabled: true,
                source: { kind: 'localPath', locator: 'widget-auto-root' }, sourceCustody, executionOrigin, occurrenceId,
                declaresContributionPoints: delayed },
        });
        const entryId = `surfacePlacement:${pluginId}:latest`;
        const entry = projection.surfacePlacementsById[entryId]!;
        return { machineId, serverId: lifetime.scope.serverId, serverIdentityId, phase: 'current' as const, interactionEnabled: true,
            projection: { ...projection, actionsById: { [`${pluginId}/list`]: PluginProjectedActionV2Schema.parse({
                id: 'list', pluginId, occurrenceId, title: 'List entries', scopes: ['global'], surfaces: ['ui'],
                execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
            }) }, surfacePlacementsById: { ...projection.surfacePlacementsById, [entryId]: {
                ...entry, executionOrigin, runtime: { resourceCapability: { readable: true, dynamic: false } },
                renderer: { kind: 'hostedHtml', contributionId: entry.binding.renderer.localId, source: artifactHtmlBundleFromBodyV1('<p>Latest entries</p>'),
                    requiredHostMethods: ['readResource', 'executeAction'] },
            } } } };
    }), new Map([[pluginId, PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
        sourceRef: { machineId: ids[0], pluginId, sourceCustody } })]]));
    const projection = union.pluginUiProjection!;
    const candidates = createPluginUiExecutionOriginCandidatePublication();
    candidates.publish(projection, [], [pluginId]);
    const releaseProjection = publishCommittedAppShellPluginUiProjection(() => projection,
        id => candidates.getSnapshot().get(id) ?? null);
    const machines = ids.map((id, index) => createMachineFixture({ id, activeAt: Date.now() - index }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [lifetime.scope.serverId]: machines }, machineListStatusByServerId: { [lifetime.scope.serverId]: 'idle' },
        settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } });
    rpc.mockReset();
    const targetRead = createDeferred<void>();
    const describeRead = createDeferred<void>();
    const resourceResponse = DaemonPluginUiResourceReadResponseSchema.parse({ ok: true, resource: surface, kind: 'asset',
        contentType: 'text/plain', digest: `sha256:${'0'.repeat(64)}`,
        bytesBase64: Buffer.from('Loaded latest entries').toString('base64') });
    rpc.mockImplementation(async (request: { method: string; onIssued?: () => void }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            // The page's exact caller read need not join a whole-Machine describe.
            await describeRead.promise;
            return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: {}, agentsById: {}, actionsById: {},
                resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] }) };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            await targetRead.promise;
            return DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'current',
                targetedContributions: { target: { pluginId, occurrenceId: 'widget-widget-a', sourceCustody }, points: [] },
                targetedSurfaceMounts: [] });
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            request.onIssued?.();
            return { ok: true, result: { entries: ['latest'] } };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return resourceResponse;
        throw new Error(`Unexpected widget RPC: ${request.method}`);
    });
    const runtime = { ...union, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: lifetime };
    const definition = { kind: 'installed' as const, surface };
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><WidgetSurface scope={{ ...lifetime.scope, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'latest-copy', definition, bindings: {} }} descriptor={readWidgetDescriptor(projection, definition)}
        providedContext={{}} appRuntime={runtime} recordRevision="latest:1" presentation="content" testID="widget-auto" /></InjectedAuthProvider>);
    try {
        await flushHookEffects();
        expect(screen.tree.root.findAllByType(PluginHostedWebPane), JSON.stringify(screen.tree.root.findAll(node => node.props.diagnosticCode)
            .map(node => node.props.diagnosticCode)) + screen.getTextContent()).toHaveLength(1);
        const pane = screen.tree.root.findByType(PluginHostedWebPane);
        let props = pane.props as React.ComponentProps<typeof PluginHostedWebPane>;
        if (!props.hostApi || !props.surfaceContext) throw new Error('Widget must expose its admitted host facade');
        const invoke = () => props.hostApi!.handleRequest({ version: 1, requestId: 'latest-action',
            surface: props.surfaceContext!, method: 'executeAction', payload: { action: 'list', input: {} } });
        if (delayed) {
            expect(await invoke()).toMatchObject({ code: 'unavailable', diagnostics: expect.arrayContaining(['plugin_surface_connection_pending']) });
            expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
            await act(async () => { targetRead.resolve(); });
            await flushHookEffects();
            props = screen.tree.root.findByType(PluginHostedWebPane).props as typeof props;
        }
        // The mounted surface follows its new caller snapshot; a retired facade
        // must not be revived when that snapshot changes its authority.
        expect(await invoke()).toEqual({ entries: ['latest'] });
        const response = await props.hostApi.handleRequest({ version: 1, requestId: 'latest-read',
            surface: props.surfaceContext, method: 'readResource', payload: { resource: { pluginId, localId: 'latest' } } });
        expect(response).toMatchObject({ contentType: 'text/plain', bytesBase64: Buffer.from('Loaded latest entries').toString('base64') });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'widget-a',
            payload: expect.objectContaining({ expectedCallerOccurrenceId: 'widget-widget-a' }) }));
    } finally { targetRead.resolve(); describeRead.resolve(); await screen.unmount(); releaseProjection(); await connection.dispose(); }
});
