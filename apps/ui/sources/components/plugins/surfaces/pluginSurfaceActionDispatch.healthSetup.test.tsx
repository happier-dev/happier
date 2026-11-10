// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture,
    type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginActionSchemasReadResponseSchema,
    PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import * as healthSetupModule from '@happier-dev/plugins-machine-services/happier-plugin-ui/health-setup';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-services/src/manifest';
import { HEALTH_SETUP_OPEN_ACTION_ID, createHealthCheckSourceInstanceIdV1 } from '../../../../../../packages/plugins/machine-services/src/healthSetup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { readAutomationEventAuthoringSeed } from '@/sync/domains/workflows/automationEventAuthoringSeed';
import { consumeWorkflowEditorDraftSeed } from '@/sync/domains/workflows/workflowEditorDraftSeed';
import { configurePluginEventAutomationSetup } from '@/components/automations/editor/pluginEventAutomationSetup';
import { createPluginOpenAutomationEventHandler } from './pluginOpenAutomationEventHostApi';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeWebMock({ ...await import('react-native-web') }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async original => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: { push: navigation.push } }).module);
const rpc = vi.hoisted(() => ({ respond: undefined as undefined | ((request: Readonly<{
    method: string; payload: unknown;
}>) => unknown) }));
// Only the daemon process transport is substituted; projection loading and input selection stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async request => rpc.respond?.(request)
        ?? { ok: false, code: 'method_not_found' });
});

afterEach(standardCleanup);
afterEach(() => { rpc.respond = undefined; navigation.push.mockClear(); });
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

function isActivation(value: unknown): value is (api: PluginClientApi) => void {
    return typeof value === 'function';
}

it.each(['current', 'wrong-observer'] as const)('runs a saved check through its admitted observer while the AppShell has no matching Action supply (%s)', async placement => {
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const { createPluginSurfaceActionHostApi } = await import('./pluginSurfaceActionDispatch');
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../reactNative/hostApi');
    const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
    const { executeCurrentUiContextContributedAction, registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error('Health manifest must be admitted');
    const pluginId = admitted.manifest.id;
    const observer = 'saved-health-observer';
    const occurrenceId = 'saved-health-current';
    const subject = { kind: 'environment', environmentId: 'production' } as const;
    const check = { checkId: 'http', kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'https://app.example.test/health', expectStatus: 503 }, periodMs: 60_000,
        consecutiveFailuresBeforeAlerting: 1 };
    const sourceConfig = { v: 1, subject, checks: [check], investigation: { mode: 'inbox' },
        alerts: { channels: [], phases: ['open', 'recovered'] } };
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, actionsById: Object.fromEntries(
        admitted.manifest.contributes.actions.map(({ inputSchema: _input, resultSchema: _result, ...action }) =>
            [`${pluginId}/${action.id}`, { ...action, pluginId, occurrenceId, available: true }])) });
    const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
        hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
        invocationSurface, hostAction, readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        listContributedActionDefinitions: selection => createPort('plugin').listCurrentContributedActionDefinitions?.('allSurfaces', selection) ?? [],
        invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
            execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
        }),
    }));
    const unregister = registerCurrentUiContextActionPort(createPort);
    const requestSurface: PluginUiSurfaceContextV1 = { pluginId, contributionId: 'health-setup', surfaceId: 'saved-health-setup',
        placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] };
    const executed: Array<Readonly<{ machineId: string; actionId: string; input: unknown; invocation: unknown }>> = [];
    const host = createPluginSurfaceActionHostApi({ surfaceContext: requestSurface,
        callerBinding: { pluginId, contributionLocalId: 'health-setup', occurrenceId,
            materializationRef: { pluginId, machineId: observer, materializationId: 'saved-health-materialization' } },
        callerSourceCustody: { kind: 'development', registeredRootId: 'saved-health-source' },
        hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
            authority: 'present_user', serverId: 'saved-health-home', runtimeAccountId: 'saved-health-account',
        } },
        resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
        // The Machine process is the only substituted execution boundary. The mounted dispatcher,
        // core Action executor, AppShell invoker, native carrier and renderer all stay real.
        contributedAction: { machineId: placement === 'current' ? observer : 'another-observer', serverId: 'saved-health-home', execute: async (machineId, options) => {
            executed.push({ machineId, actionId: options.qualifiedActionId, input: options.input, invocation: options.invocation });
            const actionId = options.qualifiedActionId;
            const result = actionId.endsWith('/health/setup') ? { mode: 'preview', sourceConfig }
                : actionId.endsWith('/health/kinds') ? admitted.manifest.contributes.healthCheckKinds.map(kind => ({ ...kind, pluginId }))
                : { status: 'down', observedAt: 1000, evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' },
                    author: { kind: 'process' }, text: 'HTTP 200; expected 503' }] } };
            return { supported: true, result: { ok: true, result } };
        } },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface: createPluginSurfaceContextFixture(),
        requestSurface, installedMethods: host.installedMethods, handleRequest: host.handleRequest });
    const failures: unknown[] = [];
    let mounted: PluginUiTestkit | undefined;
    try {
        await act(async () => { mounted = await createPluginUiTestkit({ surface: healthSetupModule.renderSurface,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
            identity: { instanceId: 'saved-health-check', mountNonce: 'saved-health-check-mount' },
            authorPlugin: { id: pluginId, version: PLUGIN_MANIFEST.version }, surfaceContext: createSurfaceContextFixture(),
            launchInput: { initialInput: sourceConfig, observerMachineId: observer },
            handlers: { executeAction: async request => {
                try { return await adapter.api.executeAction(request.action, request.input, { signal: request.signal }); }
                catch (error) { failures.push(error); throw error; }
            } },
        }); });
        await act(async () => { await mounted!.press(await mounted!.getByRole('button', { name: 'Check now' })); });
        if (placement === 'wrong-observer') {
            expect(executed).toEqual([]);
            await expect(mounted!.getByText('The check could not run. Try again when its Machine is available.')).resolves.toBeDefined();
            expect(failures).toContainEqual(expect.objectContaining({ diagnostics: expect.arrayContaining([
                { code: 'plugin_mounted_caller_unavailable', severity: 'error' },
            ]) }));
            return;
        }
        expect(failures).toEqual([]);
        await expect(mounted!.getByText('Down')).resolves.toBeDefined();
        expect(executed.filter(value => value.actionId.endsWith('/health/http'))).toEqual([expect.objectContaining({
            machineId: observer, input: { sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject), checkId: 'http' },
            invocation: { kind: 'mountedPluginSurface', mountedBinding: expect.objectContaining({ pluginId,
                contributionLocalId: 'health-setup', occurrenceId,
                materializationRef: expect.objectContaining({ machineId: observer }) }) },
        })]);
    } finally {
        await act(async () => { await mounted?.dispose(); });
        adapter.dispose(); host.dispose?.(); unregister();
    }
});

it('carries the watched subject from public Health client activation through the Action route into the native setup renderer', async () => {
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error('Health manifest must be admitted');
    const opener = admitted.manifest.contributes.actions.find(action => action.id === HEALTH_SETUP_OPEN_ACTION_ID);
    expect(opener, 'Health setup must declare the client Action that activates its public opener').toBeDefined();
    if (!opener || opener.execution.target !== 'client') throw new Error('Health opener must be a declared client Action');
    expect(opener.execution.client.artifactId).toBe('health-setup');
    const activate: unknown = Reflect.get(healthSetupModule, opener.execution.client.exportName);
    expect(isActivation(activate), 'The declared public Health artifact must export its client activation').toBe(true);
    if (!isActivation(activate)) throw new Error('Health public client activation missing');
    const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
        target: { ...opener.execution.client, platform: 'web' }, activate });
    const handler = client.registration('actions', opener.id);
    expect(handler, 'Public activation must register the declared Health opener').toBeDefined();
    if (!handler) throw new Error('Health client Action missing');

    const accountId = 'health-public-opener';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://health-public-opener.test',
        serverIdentityId: 'srv_health_public_opener', accountId, request: http.request });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected restored Health Account lifetime');
    const subject = { kind: 'machineService', machineId: 'watched-service-machine', serviceId: 'systemd:api' } as const;
    const machineId = 'health-observer-machine';
    let seedId: string | undefined;
    let mounted: PluginUiTestkit | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const open = createPluginOpenAutomationEventHandler({ accountLifetime: lifetime, isCurrent: lifetime.isCurrent });
        const unexpectedUiOperation = async (): Promise<never> => { throw new Error('The Health opener only opens an Automation Event'); };
        const context = { plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: opener.id, qualifiedId: `${PLUGIN_MANIFEST.id}/${opener.id}` },
            invocationSurface: 'ui', signal: new AbortController().signal, ephemeralSharedScope: null,
            ui: { version: () => { throw new Error('The Health opener does not negotiate a UI mount'); },
                context: unexpectedUiOperation, executeAction: unexpectedUiOperation, openSurface: unexpectedUiOperation,
                selectActionInput: unexpectedUiOperation, openNewSession: unexpectedUiOperation,
                readSession: unexpectedUiOperation, revealSessionInput: unexpectedUiOperation,
                readComposer: unexpectedUiOperation, applyComposer: unexpectedUiOperation,
                openAutomationEvent: async (request, options) => { expect(await open(request, options)).toBeNull(); } },
        } satisfies PluginClientActionContext;
        navigation.push.mockClear();
        expect(await handler({ subject, monitoringMachineId: machineId }, context)).toEqual({ status: 'opened' });
        const route = navigation.push.mock.calls[0]?.[0] as Readonly<{
            pathname: string; params: { automationEventSeedId: string; serverId: string };
        }>;
        expect(route).toMatchObject({ pathname: '/workflows', params: { serverId: connection.serverId } });
        expect(Object.keys(route.params).sort()).toEqual(['automationEventSeedId', 'serverId']);
        seedId = route.params.automationEventSeedId;
        const routedSeed = readAutomationEventAuthoringSeed(seedId, lifetime.scope);
        if (!routedSeed || 'kind' in routedSeed) throw new Error('Health Action must leave a plugin Event authoring seed');
        expect(routedSeed).toMatchObject({ monitoringMachineId: machineId, setupInput: { v: 1, subject } });

        const pluginId = PLUGIN_MANIFEST.id;
        const occurrenceId = 'health-public-current';
        const sourceCustody = { kind: 'development', registeredRootId: 'health-public-source' } as const;
        const origin = { serverIdentityId: 'srv_health_public_opener', sourceRef: { machineId, pluginId, sourceCustody } };
        const action = admitted.manifest.contributes.actions.find(row => row.id === 'health/setup');
        const declaration = admitted.manifest.contributes.events?.find(row => row.id === routedSeed.eventRef.localId);
        if (!action || declaration?.kind !== 'event' || !declaration.automation) throw new Error('Health setup declarations missing');
        const renderer = declaration.automation.source.setupSurface?.renderer;
        if (!renderer) throw new Error('Health native setup renderer missing');
        // These are daemon wire responses, derived from the admitted author manifest.
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            event: { id: `${pluginId}/${declaration.id}`, identity: routedSeed.eventRef, occurrenceId, sourceCustody,
                title: 'Health check failed', description: null, payloadSchema: declaration.payloadSchema, automation: declaration.automation },
            setupAction: { id: `${pluginId}/${action.id}`, identity: { pluginId, localId: action.id }, occurrenceId,
                title: action.title, description: null, inputSchema: action.inputSchema, inputHints: action.inputHints ?? null },
            observationBinding: { executionOrigin: origin, materializationRef: { machineId, pluginId, materializationId: 'health-observer' } },
            setupSurface: { contribution: routedSeed.eventRef, occurrenceId, projectionGeneration: 1,
                rendererChain: [{ pluginId, localId: renderer }], selectedRenderer: { identity: { pluginId, localId: renderer },
                    renderer: { kind: 'reactNative', contributionId: renderer },
                    availability: { state: 'available', reason: 'compatible', diagnostics: [] } },
                executionOrigin: origin, resourceCapability: { readable: false, dynamic: false },
                contributorTargetedContributions: { target: { pluginId, occurrenceId, sourceCustody }, points: [] } },
        });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: PLUGIN_MANIFEST.displayName,
                version: PLUGIN_MANIFEST.version, enabled: true, source: { kind: 'path', locator: '/sources/health' },
                occurrenceId, sourceCustody, executionOrigin: origin } },
            actionsById: { [event.setupAction.id]: { id: action.id, pluginId, occurrenceId, title: action.title,
                execution: action.execution, scopes: action.scopes, surfaces: action.surfaces, inputHints: action.inputHints,
                dangerLevel: action.dangerLevel, available: true, placementBindings: [], priority: 0 } } });
        rpc.respond = request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection, automationEligibleEvents: [event] });
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
                return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true, inputSchema: action.inputSchema });
            throw new Error(`Health authoring must not execute effects: ${request.method}`);
        };
        const machine = createMachineFixture({ id: machineId });
        storage.getState().applyMachines([machine], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(lifetime.scope, [machineId]);
        const fresh: FreshPluginMachineExecutionOriginV1 = { origin,
            source: { origin, occurrenceId, version: PLUGIN_MANIFEST.version, serverId: connection.serverId },
            machineTarget: { kind: 'resolved', target: { serverIdentityId: origin.serverIdentityId, machineId }, serverId: connection.serverId,
                profile: { id: connection.serverId, name: 'Health observer', serverUrl: 'https://health-public-opener.test',
                    serverIdentityId: origin.serverIdentityId, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }, machine } };
        let rendered = false;
        const outcome = await configurePluginEventAutomationSetup({ eligibleEvent: event, initialSetupSeed: routedSeed,
            observationTransport: 'checkpointedPull', filter: null, maximumObservationAgeMs: null, accountLifetime: lifetime,
            resolveExecutionOrigin: () => fresh,
            loadCurrentProjection: target => loadDaemonMergedProjectionInputs({ ...target, accountLifetime: lifetime, sections: 'complete' }),
            present: () => { throw new Error('The Health Action must reach its native setup surface'); },
            presentSetupSurface: async params => {
                expect(params.launchInput).toMatchObject({ observerMachineId: machineId, initialInput: { v: 1, subject } });
                await act(async () => { mounted = await createPluginUiTestkit({ surface: healthSetupModule.renderSurface,
                    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
                    identity: { instanceId: 'public-health-setup', mountNonce: 'public-health-setup-mount' },
                    authorPlugin: { id: pluginId, version: PLUGIN_MANIFEST.version },
                    surfaceContext: createSurfaceContextFixture(), launchInput: params.launchInput }); });
                expect(await mounted!.getByRole('button', { name: 'Add check' })).toBeDefined();
                expect(await mounted!.getByRole('textbox', { label: 'Endpoint' })).toBeDefined();
                rendered = true;
                return { kind: 'cancelled' };
            },
        });
        expect(rendered, 'The routed watched subject must make the real Health form reachable').toBe(true);
        expect(outcome).toEqual({ kind: 'unavailable' });
    } finally {
        await act(async () => { await mounted?.dispose(); });
        if (seedId) consumeWorkflowEditorDraftSeed(seedId);
        await client.dispose();
        clearDaemonMergedProjectionCacheForTests();
        connection.dispose();
    }
});
