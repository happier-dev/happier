import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonPluginUiResourceReadResponseSchema,
    DaemonPluginUiTargetedContributionsReadResponseSchema, DaemonProjectionDeferredSectionsResponseSchema,
    demandedDaemonProjectionSections } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
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
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../../../../../cli/src/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '../../../../../cli/src/plugins/testkit/manifestV2Fixture';
import { registerDaemonContributionRegistryProjectionHandler, invalidateDaemonContributionRegistryProjectionCache } from '../../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection';
import type { RpcHandler } from '../../../../../cli/src/api/rpc/types';
import { buildPluginMountedActionsProjectionV2, buildResourcesById } from '../../../../../cli/src/plugins/projection/registry/projection/v2';
import { readInstalledPluginCatalog } from '../../../../../cli/src/plugins/projection/catalog/installed';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

afterEach(async () => { await standardCleanup(); });

it.each([
    { count: 1, delayed: false, targeted: false, target: 'app', retirement: 'none' },
    { count: 2, delayed: false, targeted: false, target: 'app', retirement: 'none' },
    { count: 1, delayed: true, targeted: false, target: 'app', retirement: 'none' },
    { count: 1, delayed: false, targeted: false, target: 'project', retirement: 'none' },
    { count: 1, delayed: false, targeted: true, target: 'app', retirement: 'none' },
    { count: 1, delayed: true, targeted: false, target: 'app', retirement: 'unmount' },
    { count: 1, delayed: true, targeted: false, target: 'app', retirement: 'request' },
    { count: 1, delayed: true, targeted: false, target: 'app', retirement: 'account' },
    { count: 1, delayed: true, targeted: false, target: 'app', retirement: 'occurrence' },
] as const)(
    'loads an unpinned $target widget on $count Machines (pending: $delayed, targeted: $targeted, replacement: $retirement)', async ({ count, delayed, targeted, target, retirement }) => {
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
    const contributionProtocol = { id: 'widget-details', version: 1 } as const;
    const pointDeclarations = targeted ? definePlugin({ id: pluginId, version: '1.0.0', contributionPoints: {
        details: defineContributionProtocol({ ...contributionProtocol,
            descriptor: defineProtocolObject({ label: defineProtocolString() }, { policy: 'closed' }),
            operations: { setup: { required: true, input: { kind: 'contributorDefined' },
                resultSchema: defineProtocolObject({}, { policy: 'closed' }), action: { surfaces: ['plugin'], dangerLevel: 'safe' } } },
            surfaces: { detail: { required: true, presentation: 'content', inputSchema: defineProtocolObject({}, { policy: 'closed' }) } },
        }).point(),
    } }).manifest.contributes : {};
    const widgetPlugin = (version = '1.0.0') => ({ manifest: createPluginManifestV2Fixture({ id: pluginId, version, contributes: { ...pointDeclarations,
            actions: [{ id: 'list', title: 'List entries', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' } }],
            resources: [{ id: 'latest', source: 'dynamic', kind: 'config', scope: 'global', contentType: 'text/plain' }],
        } }), files: { 'daemon.mjs': "export function activate(api) { api.actions.register('list', () => ({ entries: ['latest'] })); }" } });
    const daemon = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [
        widgetPlugin(),
        ...(targeted ? [{ manifest: createPluginManifestV2Fixture({ id: 'acme.widget-detail', contributes: {
            actions: [{ id: 'setup', title: 'Setup detail', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
                execution: { target: 'daemon' }, inputSchema: { type: 'object', additionalProperties: false },
                resultSchema: { type: 'object', additionalProperties: false } }],
            ui: { renderers: [{ id: 'detail-body', kind: 'declarative', root: { kind: 'text', text: 'Widget detail' } }] },
            targetedPluginContributions: [{ id: 'detail', target: { pluginId, pointId: 'details' }, protocol: contributionProtocol,
                descriptor: { label: 'Detail' }, operations: { setup: 'setup' }, surfaces: { detail: { renderer: 'detail-body' } } }],
        } }), files: { 'daemon.mjs': "export function activate(api) { api.actions.register('setup', () => ({})); }" } }] : []),
        { manifest: createPluginManifestV2Fixture({ id: 'acme.unrelated-widget', contributes: {
            actions: [{ id: 'unrelated', title: 'Unrelated', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' } }],
            scmBackends: [{ id: 'vcs', title: 'Unrelated SCM', kind: 'acme', capabilities: ['detect'] }],
        } }), files: { 'daemon.mjs': 'export function activate() { throw new Error("Unrelated widget must stay cold"); }' } },
    ] });
    let replacement: typeof daemon | undefined;
    let replacementOccurrenceId: string | undefined;
    let replacementAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let currentRegistry = daemon.registry;
    const sourceCustody = daemon.registry.readPluginSourceCustody?.(pluginId);
    const occurrenceId = daemon.registry.readPluginOccurrenceId?.(pluginId);
    if (!sourceCustody || !occurrenceId) throw new Error('Expected admitted widget source authority');
    const handlers = new Map<string, RpcHandler>();
    registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
        resolveRuntimeRegistry: async () => currentRegistry,
        resolveInstalledPackages: () => readInstalledPluginCatalog({ happyHomeDir: daemon.happyHomeDir }),
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId, machineId: ids[0]! }),
    });
    const buildUnion = (registry: typeof daemon.registry, version = '1.0.0') => {
        const sourceCustody = registry.readPluginSourceCustody?.(pluginId);
        const occurrenceId = registry.readPluginOccurrenceId?.(pluginId);
        if (!sourceCustody || !occurrenceId) throw new Error('Expected admitted widget source authority');
        return unionPluginUiProjections(ids.map(machineId => {
            const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
                sourceRef: { machineId, pluginId, sourceCustody } });
            const projection = widgetProjectionOf([{ ...surface, target, occurrenceId, resources: [surface] }], {
                [pluginId]: { id: pluginId, displayName: 'Latest entries', version, enabled: true,
                    source: { kind: 'localPath', locator: 'widget-auto-root' }, sourceCustody, executionOrigin, occurrenceId,
                    declaresContributionPoints: targeted },
            });
            // The committed shell catalog supplies declarations/identities. Mounted
            // authority still has to arrive through the real selected RPC below.
            const declarations = buildPluginMountedActionsProjectionV2({ registry: registry.contributes,
                generation: 1, actions: [{ pluginId, localId: 'list' }],
                pluginExecutionOriginsByPluginId: { [pluginId]: executionOrigin } });
            const entryId = `surfacePlacement:${pluginId}:latest`;
            const entry = projection.surfacePlacementsById[entryId]!;
            return { machineId, serverId: lifetime.scope.serverId, serverIdentityId, phase: 'current' as const, interactionEnabled: true,
                projection: { ...projection, actionsById: declarations.actionsById,
                    resourcesById: buildResourcesById(registry.contributes, [], { [pluginId]: executionOrigin }),
                    surfacePlacementsById: { ...projection.surfacePlacementsById, [entryId]: {
                        ...entry, executionOrigin, runtime: { resourceCapability: { readable: true, dynamic: false } },
                        ...(target === 'project' ? { availability: { ...entry.availability,
                            when: { fact: 'project.repository.kind', operator: 'equals' as const, value: 'github' } } } : {}),
                        renderer: { kind: 'hostedHtml', contributionId: entry.binding.renderer.localId, source: artifactHtmlBundleFromBodyV1('<p>Latest entries</p>'),
                            requiredHostMethods: ['readResource', 'executeAction'] },
                    } } } };
        }), new Map([[pluginId, PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: ids[0], pluginId, sourceCustody } })]]));
    };
    const union = buildUnion(daemon.registry);
    let projection = union.pluginUiProjection!;
    const candidates = createPluginUiExecutionOriginCandidatePublication();
    candidates.publish(projection, [], [pluginId]);
    const releaseProjection = publishCommittedAppShellPluginUiProjection(() => projection,
        id => candidates.getSnapshot().get(id) ?? null);
    const machines = ids.map((id, index) => createMachineFixture({ id, activeAt: Date.now() - index }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [lifetime.scope.serverId]: machines }, machineListStatusByServerId: { [lifetime.scope.serverId]: 'idle' },
        settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } });
    rpc.mockReset();
    const selectedRead = createDeferred<void>();
    const selectedSignals: AbortSignal[] = [];
    let effects = 0;
    const resourceResponse = DaemonPluginUiResourceReadResponseSchema.parse({ ok: true, resource: surface, kind: 'asset',
        contentType: 'text/plain', digest: `sha256:${'0'.repeat(64)}`,
        bytesBase64: Buffer.from('Loaded latest entries').toString('base64') });
    const discoveryManifests = new Map<string, ReturnType<typeof DaemonProjectionDeferredSectionsResponseSchema.parse>>();
    const discoveryPages: string[] = [];
    const expectBoundedDiscovery = () => {
        expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            && !request.payload?.selection && request.payload?.deferredSections !== true)).toHaveLength(0);
        // Healthy discovery acquires each demanded page once per Machine and
        // projection publication, regardless of mounted Action preparation.
        expect(new Set(discoveryPages).size).toBe(discoveryPages.length);
    };
    rpc.mockImplementation(async (request: { machineId: string; method: string; payload?: Record<string, unknown>; onIssued?: () => void; signal?: AbortSignal }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
            if (!payload.selection) {
                // Bare full inventory stays parked. Presented UI can negotiate
                // the real daemon manifest and acquire only its UI sections.
                if (payload.deferredSections !== true) return new Promise<never>(() => {});
                if (payload.sectionRead) {
                    const manifest = discoveryManifests.get(request.machineId);
                    if (!manifest) throw new Error('UI discovery must negotiate its manifest before reading sections');
                    discoveryPages.push(JSON.stringify([request.machineId, manifest.projectionDigest,
                        payload.sectionRead.digest, payload.sectionRead.offset]));
                }
                const response = await handlers.get(request.method)!({ machineId: request.machineId, ...payload });
                if (!payload.sectionRead) discoveryManifests.set(request.machineId, DaemonProjectionDeferredSectionsResponseSchema.parse(response));
                return response;
            }
            if (payload.selection !== 'mountedActions') throw new Error(`Unexpected widget projection selection: ${payload.selection}`);
            if (request.signal) selectedSignals.push(request.signal);
            const response = await handlers.get(request.method)!({ machineId: ids[0]!, ...payload });
            if (targeted) {
                expect(payload.callers).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'acme.widget-detail' })]));
                expect(payload.actions).toEqual(expect.arrayContaining([{ pluginId: 'acme.widget-detail', localId: 'setup' }]));
                expect(response).toMatchObject({ projection: { actionsById: { 'acme.widget-detail/setup': {
                    id: 'setup', pluginId: 'acme.widget-detail', occurrenceId: daemon.registry.readPluginOccurrenceId?.('acme.widget-detail'),
                } } } });
            }
            if (delayed) await selectedRead.promise;
            return response;
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            const response = DaemonPluginUiTargetedContributionsReadResponseSchema.parse(
                await handlers.get(request.method)!({ machineId: ids[0]!, ...request.payload }));
            if (targeted) expect(response).toMatchObject({ status: 'current', targetedContributions: { points: [{
                pointId: 'details', protocols: [{ contributions: [{ contributor: { pluginId: 'acme.widget-detail' },
                    descriptor: { label: 'Detail' } }] }],
            }] }, targetedSurfaceMounts: [{ contributor: { pluginId: 'acme.widget-detail' },
                contributorTargetedContributions: { target: { pluginId: 'acme.widget-detail' } } }] });
            return response;
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            request.onIssued?.();
            effects++;
            return { ok: true, result: { entries: ['latest'] } };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return resourceResponse;
        throw new Error(`Unexpected widget RPC: ${request.method}`);
    });
    let runtime = { ...union, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: lifetime };
    const definition = { kind: 'installed' as const, surface };
    const checkout = { serverId: lifetime.scope.serverId, id: 'project-checkout', machineId: ids[0]!, rootPath: '/project', createdAtMs: 0,
        repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/project' } };
    const projectContext = target === 'project' ? readProjectWidgetAreaContextV1({ serverId: lifetime.scope.serverId,
        projectRef: checkout, activeCheckout: checkout, authority: lifetime }) : undefined;
    const owner = projectContext ? { kind: 'project' as const, projectId: projectContext.target!.projectKey } : { kind: 'home' as const };
    const renderWidget = () => <InjectedAuthProvider credentials={connection.credentials}><WidgetSurface scope={{ ...lifetime.scope, owner }}
        instance={{ v: 1, id: 'latest-copy', definition, bindings: {} }} descriptor={readWidgetDescriptor(projection, definition)}
        providedContext={{}} projectContext={projectContext} appRuntime={{ ...runtime, pluginUiProjection: projection }} recordRevision="latest:1" presentation="content" testID="widget-auto" /></InjectedAuthProvider>;
    const screen = await renderScreen(renderWidget());
    try {
        await flushHookEffects();
        expect(screen.tree.root.findAllByType(PluginHostedWebPane), JSON.stringify(screen.tree.root.findAll(node => node.props.diagnosticCode)
            .map(node => node.props.diagnosticCode)) + screen.getTextContent()).toHaveLength(1);
        // Settle presented UI discovery before holding the separate mounted
        // Action read; its initial publication can replace the mounted facade.
        if (target === 'app') {
            const cacheTarget = { machineId: ids[0]!, serverId: lifetime.scope.serverId, sections: PLUGIN_UI_SECTIONS };
            await vi.waitFor(() => expect(readCachedDaemonMergedProjectionCacheEntry(cacheTarget)?.kind).toBe('ready'));
            const acquired = readCachedDaemonMergedProjectionCacheEntry(cacheTarget);
            const manifest = discoveryManifests.get(ids[0]!);
            if (acquired?.kind !== 'ready' || !manifest) throw new Error('Expected settled presented UI discovery');
            expect(new Set(acquired.deferredProjection?.loadedSections)).toEqual(new Set(demandedDaemonProjectionSections(manifest, PLUGIN_UI_SECTIONS)));
            await flushHookEffects();
        }
        const pane = screen.tree.root.findByType(PluginHostedWebPane);
        let props = pane.props as React.ComponentProps<typeof PluginHostedWebPane>;
        if (!props.hostApi || !props.surfaceContext) throw new Error('Widget must expose its admitted host facade');
        expectBoundedDiscovery();
        const pointReads = rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
        if (targeted) expect(pointReads.length).toBeGreaterThan(0);
        else expect(pointReads).toHaveLength(0);
        if (projectContext) expect(props.canonicalHostApi?.target).toEqual(projectContext.target);
        const invocationAbort = new AbortController();
        const invoke = () => props.hostApi!.handleRequest({ version: 1, requestId: 'latest-action',
            surface: props.surfaceContext!, method: 'executeAction', payload: { action: 'list', input: {} } }, { signal: invocationAbort.signal });
        let actionResult: ReturnType<typeof invoke> | undefined;
        if (delayed) {
            actionResult = invoke();
            await flushHookEffects();
            expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
            await vi.waitFor(() => expect(selectedSignals.length).toBeGreaterThan(0));
            const oldProps = props;
            if (retirement === 'request') invocationAbort.abort();
            if (retirement === 'unmount') await screen.unmount();
            if (retirement === 'account') replacementAccount = await restoreServerAccountForTest({
                serverUrl: 'https://widget-auto.test', serverIdentityId, accountId: 'replacement-widget-viewer',
                request: createHomeHubArtifactHttpBoundary('replacement-widget-viewer').request,
            });
            if (retirement === 'occurrence') {
                replacement = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: daemon.happyHomeDir,
                    controller: daemon.controller, coldStart: true, plugins: [{ ...widgetPlugin('2.0.0'), replaceExisting: true }] });
                currentRegistry = replacement.registry;
                replacementOccurrenceId = currentRegistry.readPluginOccurrenceId?.(pluginId) ?? undefined;
                if (!replacementOccurrenceId) throw new Error('Expected replacement widget source authority');
                const replacementUnion = buildUnion(currentRegistry, '2.0.0');
                projection = replacementUnion.pluginUiProjection!;
                runtime = { ...runtime, ...replacementUnion };
                candidates.publish(projection, [], [pluginId]);
                await screen.update(renderWidget());
            }
            if (retirement !== 'none') {
                expect(selectedSignals[0]!.aborted).toBe(retirement !== 'request');
                await act(async () => { selectedRead.resolve(); });
                await flushHookEffects();
                expect(await actionResult).toMatchObject({ code: expect.stringMatching(/^(unavailable|stale_surface)$/) });
                if (retirement !== 'request') expect(await oldProps.hostApi!.handleRequest({ version: 1, requestId: 'retired-action',
                    surface: oldProps.surfaceContext!, method: 'executeAction', payload: { action: 'list', input: {} } }))
                    .toMatchObject({ code: expect.stringMatching(/^(unavailable|stale_surface)$/) });
                expect(effects).toBe(0);
                if (retirement === 'occurrence') {
                    const nextProps = screen.tree.root.findByType(PluginHostedWebPane).props as typeof props;
                    expect(await nextProps.hostApi!.handleRequest({ version: 1, requestId: 'replacement-action',
                        surface: nextProps.surfaceContext!, method: 'executeAction', payload: { action: 'list', input: {} } }))
                        .toEqual({ entries: ['latest'] });
                    expect(effects).toBe(1);
                    const executions = rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
                    expect(executions.at(-1)?.[0]).toMatchObject({
                        payload: { expectedContributorOccurrenceId: replacementOccurrenceId,
                            invocation: { kind: 'mountedPluginSurface', mountedBinding: { occurrenceId: replacementOccurrenceId } } },
                    });
                }
                expectBoundedDiscovery();
                return;
            }
            await act(async () => { selectedRead.resolve(); });
            await flushHookEffects();
            props = screen.tree.root.findByType(PluginHostedWebPane).props as typeof props;
        }
        // The mounted surface follows its new caller snapshot; a retired facade
        // must not be revived when that snapshot changes its authority.
        expect(await (actionResult ?? invoke())).toEqual({ entries: ['latest'] });
        const response = await props.hostApi.handleRequest({ version: 1, requestId: 'latest-read',
            surface: props.surfaceContext, method: 'readResource', payload: { resource: { pluginId, localId: 'latest' } } });
        const declaredResource = projection.resourcesById[`${pluginId}/latest`];
        expect(response, JSON.stringify({
            resourceRequests: rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
                .map(([request]) => ({ machineId: request.machineId, payload: request.payload })),
            resourceStorePresent: Boolean(Reflect.get(props.mountLifetime, 'resourceStore')),
            resourceContext: Reflect.get(props, 'resourceContext') ?? null,
            surfaceResourceScope: props.surfaceContext.resourceScope,
            sourceDescriptorRuntime: projection.surfacePlacementsById[`surfacePlacement:${pluginId}:latest`]?.runtime,
            declaredResource: declaredResource && { id: declaredResource.id, pluginId: declaredResource.pluginId,
                occurrenceId: declaredResource.occurrenceId, scope: declaredResource.scope },
        })).toMatchObject({ contentType: 'text/plain', bytesBase64: Buffer.from('Loaded latest entries').toString('base64') });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'widget-a',
            payload: expect.objectContaining({ expectedCallerOccurrenceId: occurrenceId }) }));
        expect(effects).toBe(1);
        expect(daemon.registry.activatedPluginIds.size).toBe(0);
        expectBoundedDiscovery();
    } finally { selectedRead.resolve(); await screen.unmount(); releaseProjection(); await replacementAccount?.dispose(); await connection.dispose();
        invalidateDaemonContributionRegistryProjectionCache(); await replacement?.dispose(); await daemon.dispose(); }
});
