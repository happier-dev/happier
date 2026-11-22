// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { TextInput } from 'react-native';
import { PluginProjectionV2Schema, DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema, DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { PluginAvailabilityActionHttpPathsV1, type PluginAccountAvailabilityIntentReadResponseV1 } from '@happier-dev/protocol/plugins/availability';
import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HealthCheckSetupInputV1ProtocolSchema, HealthCheckSetupPreviewResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { HealthCheckSetupPreviewInputV1Schema, SavedHealthTransitionSourceV1Schema, createSavedHealthTransitionSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AutomationPluginEventTriggerProjectionSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DeploymentReceiptEventSetupV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { ActionInputFormModal } from '@/components/plugins/actions/ActionInputFormModal';
import type { ActionInputForm, ActionInputFormSubmissionResult } from '@/components/plugins/actions/actionInputForm';
import { changeTextTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest as restoreAccount } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createServedHomeAccountToken } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import { configurePluginEventAutomationSetup } from './pluginEventAutomationSetup';
import { readPluginEventAutomationWatcherFailure } from './pluginEventAutomationObservationBinding';
import type { PluginContributedActionDispatch } from '@/components/plugins/actions/pluginContributedActionController';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-services/src/manifest';
import { renderSurface } from '@happier-dev/plugins-machine-services/happier-plugin-ui/health-setup';
import { createPluginEventAutomationSetupSurfaceBinding } from './presentPluginEventAutomationSetupSurface';

type SetupForm = ActionInputForm<ActionInputFormSubmissionResult, string, string>;

// The native host transport answers the readonly Configure preview; all form logic stays real.
const previewHealthSetup: NonNullable<NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['executeAction']> = async request => {
    // The Zod owner's output keeps the input union discriminable (the Protocol projection intersects it with JSON).
    const { mode, ...sourceConfig } = HealthCheckSetupPreviewInputV1Schema.parse(request.input);
    return HealthCheckSetupPreviewResultV1ProtocolSchema.parse({ mode, sourceConfig: { ...sourceConfig,
        alerts: ('alerts' in sourceConfig ? sourceConfig.alerts : undefined) ?? { channels: [], phases: ['open', 'recovered'] } } });
};

vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The DOM portal painter is a renderer boundary; retain real overlay and target selection.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The anchored portal is a platform boundary; the subject starter and Event editor stay real.
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover'))
    .createInlinePopoverModuleMock(original, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Trigger authoring does not stream Markdown; the vendor leaf requires a browser bundler.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in Health starter test'); },
}));
vi.mock('socket.io-client', async original => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
const rpc = vi.hoisted(() => ({ respond: undefined as undefined | ((request: Readonly<{
    method: string; payload: unknown; machineId?: string;
}>) => unknown), hostActions: [] as unknown[] }));

// The daemon RPC is the process boundary; descriptor selection, forms and validation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    return { machineRpcWithServerScope: async (request: Readonly<{ method: string; payload: unknown }>) => {
        const response = rpc.respond?.(request);
        if (response !== undefined) return response;
        const action = PLUGIN_MANIFEST.contributes.actions?.find(row => row.id === 'health/setup');
        return request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ && action
            ? { ok: true, inputSchema: action.inputSchema }
            : { ok: false, code: 'method_not_found' };
    } };
});

const healthBoundaryErrors: unknown[] = [];
afterEach(standardCleanup);
afterEach(() => { healthBoundaryErrors.length = 0; });
afterEach(() => { rpc.respond = undefined; rpc.hostActions = []; });
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

describe('configures a prebound guided deployment and bound health starters', () => {

// Host-owned setup now crosses the Account Action HTTP boundary. The simulated
// daemon delegates action.invoke to the same external plugin handler replies.
async function restoreServerAccountForTest(params: Parameters<typeof restoreAccount>[0] & { peerMachineId?: string }) {
    if (!params.accountId || !params.serverIdentityId) throw new Error('Expected an identified Health Account');
    const createBoundary = (machineId: string) => createExternalActionAccountHttpBoundary({
        serverUrl: params.serverUrl, serverIdentityId: params.serverIdentityId, accountId: params.accountId,
        machineId, actionId: 'action.invoke', tokenEpoch: 0, requesterInvocation: 'required',
        failure: value => {
            const result = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(value);
            return result.success && !result.data.ok ? { errorCode: result.data.code, error: result.data.code,
                details: result.data.details } : null;
        },
        execute: async input => {
            rpc.hostActions.push(input);
            if (!input || typeof input !== 'object') throw new Error('Expected action.invoke input');
            const action = PluginContributionIdentityV1Schema.parse(Reflect.get(input, 'action'));
            const response = await rpc.respond?.({ method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
                payload: { qualifiedActionId: buildQualifiedPluginContributionKey(action), input: Reflect.get(input, 'input') } });
            const result = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(response);
            return result.ok ? result.result : result;
        },
    });
    const boundary = await createBoundary(healthSetupFixture().machineId);
    const peer = params.peerMachineId ? await createBoundary(params.peerMachineId) : null;
    return restoreAccount({ ...params, credentials: { token: createServedHomeAccountToken(params.accountId, true) },
        request: async (input, init) => {
            let response: Response | null;
            try {
                const url = new URL(String(input));
                if (peer && url.pathname === '/v1/machines') return Response.json([boundary.machine, peer.machine]);
                if (peer && url.pathname === '/v1/machines/read-batch') {
                    return createMachineReadBatchResponseFixture(init?.body, id =>
                        id === boundary.machine.id ? boundary.machine : id === peer.machine.id ? peer.machine : null);
                }
                const body = peer && url.pathname.startsWith('/v1/actions/') && typeof init?.body === 'string'
                    ? JSON.parse(init.body) : null;
                const targetsPeer = peer && (url.pathname.endsWith('/' + peer.machine.id)
                    || body?.machineId === peer.machine.id || body?.target?.machineId === peer.machine.id);
                response = await (targetsPeer ? peer : boundary).handle(url, init);
            }
            catch (error) { healthBoundaryErrors.push(error); throw error; }
            if (response) return response;
            return params.request?.(input, init) ?? null;
        } });
}

it('summarizes a Health Event list trigger without a display label using its declared Event title', async () => {
    const accountId = 'health-trigger-summary';
    const serverIdentityId = 'srv_health_trigger_summary';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://health-trigger-summary.test',
        serverIdentityId, accountId, request: http.request });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { formatTriggerSummary } = await import('@/components/workflows/triggers/formatTriggerSummary');
    const { formatAutomationTriggerLabel } = await import('@/components/automations/list/automationListFormatting');
    const { t } = await import('@/text');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected Health summary Account');
    const { machineId, pluginId, projection, event } = healthSetupFixture(connection.serverId, serverIdentityId);
    rpc.respond = request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? { protocolVersion: 1, projection, automationEligibleEvents: [event] } : undefined;
    try {
        const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId: connection.serverId, accountLifetime, sections: 'complete' });
        expect(inputs?.automationEligibleEvents).toEqual([event]);
        const trigger = AutomationPluginEventTriggerProjectionSchema.parse({ kind: 'pluginEvent', id: 'health-trigger', revision: 1,
            enabled: true, createdAt: 1, updatedAt: 1, eventRef: event.event.identity, sourceSelectorId: 'health-source',
            sourceContractVersion: 1, sourceStatus: null, sourceCatalogStatus: null,
            observation: { kind: 'checkpointedPull', watcher: { machineId, machineInstallationId: 'health-installation',
                pluginId, materializationId: 'machine-services-observer' } } });
        const expected = t('workflows.triggers.summary.event', { event: 'Health check failed' });
        expect.soft(formatTriggerSummary(trigger, { machineId, serverId: connection.serverId })).toBe(expected);
        expect(formatAutomationTriggerLabel(trigger)).toBe(expected);
    } finally {
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
    }
});

it.each([
    { declared: false, catalogEvent: true, runtimeUnavailable: false },
    { declared: true, catalogEvent: false, runtimeUnavailable: false },
    { declared: true, catalogEvent: false, runtimeUnavailable: true },
    { declared: true, catalogEvent: true, runtimeUnavailable: false },
])('settles prebound deployment setup in the ordinary sentence control (declared=$declared, catalogEvent=$catalogEvent, runtimeUnavailable=$runtimeUnavailable)', async ({ declared, catalogEvent, runtimeUnavailable }) => {
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { PluginEventAutomationEditor, InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
    const { TriggerPluginEventRows } = await import('@/components/workflows/triggers/TriggerPluginEventRows');
    const { WorkflowTriggerBlock } = await import('@/components/workflows/triggers/WorkflowTriggerBlock');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
    const { router } = await import('expo-router');
    const { HappierPressable } = await import('@happier-dev/plugin-ui/presentation');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { Item } = await import('@/components/ui/lists/Item');
    const { pressTestInstanceAsync } = await import('@/dev/testkit/render/renderScreen');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'deployment-guided-preset';
    const serverIdentityId = 'srv_deployment_guided';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    // The guided editor demands its Machine declaration body by digest (exact read).
    let exactIntentRead: unknown = null;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://deployment-guided.test',
        serverIdentityId, accountId, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'] && exactIntentRead) {
                return Response.json(exactIntentRead);
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v3/automations' || path === '/v3/automations/query') return Response.json({ automations: [], nextCursor: null });
            return http.request(input, init);
        } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected guided deployment Account');
    const { event, fresh, projection, inputs, machineId, pluginId } = healthSetupFixture(connection.serverId, serverIdentityId, false,
        { eventId: 'deployment-failed', actionId: 'deployment-failed/setup' });
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error('Expected the admitted Machine services declaration');
    const declarationDigestSha256: `sha256:${string}` = `sha256:${'d'.repeat(64)}`;
    const guidedIntentRead: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId, enabled: true, desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: [], revision: 'guided-declaration' },
        release: null, uiArtifacts: [], packageAssets: [],
        currentDeclaration: null,
        machineDeclarations: [{ machineId, machineInstallationId: 'guided-installation', declaration: { declarationDigestSha256 } }],
    };
    exactIntentRead = { ...guidedIntentRead, declarationBodies: [{ declarationDigestSha256,
        manifest: { ...admitted.manifest, contributes: { ...admitted.manifest.contributes,
            events: declared ? admitted.manifest.contributes.events : [] } } }] };
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: guidedIntentRead }],
    } });
    const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const sourceFacts = readPluginUiExecutionOriginCandidates({ pluginId, projection: inputs.pluginUiProjection,
        members: [{ machineId, serverId: connection.serverId, serverIdentityId,
            projection: inputs.pluginUiProjection, phase: 'current', interactionEnabled: true }] });
    const disposeProjection = publishCommittedAppShellPluginUiProjection(() => inputs.pluginUiProjection,
        id => id === pluginId ? sourceFacts : null);
    const setupInput = { v: 1 as const, serverId: connection.serverId, environmentId: 'environment-production' };
    const submitted: unknown[] = [];
    const requestedMethods: string[] = [];
    const setupResponse = createDeferred<void>();
    // The #90 daemon declares the Event, but Account execution disables its catalog entry.
    const catalogProjection = runtimeUnavailable ? PluginProjectionV2Schema.parse({ ...projection,
        installedPackagesById: { ...projection.installedPackagesById,
            [pluginId]: { ...projection.installedPackagesById[pluginId], enabled: false } },
        diagnostics: [{ version: 1, id: 'account-execution-unavailable',
            plugin: { id: pluginId, version: PLUGIN_MANIFEST.version, source: 'development' },
            stage: 'runtime', host: 'daemon', platform: 'linux', occurredAtMs: 1,
            resolution: { state: 'current' },
            data: { code: 'plugin_runtime_capability_missing', severity: 'error', message: 'Plugin unavailable',
                details: { reason: 'plugin_account_execution_unavailable' } } }],
    }) : projection;
    rpc.respond = request => {
        requestedMethods.push(request.method);
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection: catalogProjection, automationEligibleEvents: catalogEvent ? [event] : [] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
            return { ok: true, inputSchema: event.setupAction.inputSchema };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            const input = DeploymentReceiptEventSetupV1Schema.parse(Reflect.get(Object(request.payload), 'input'));
            submitted.push(input);
            return setupResponse.promise.then(() => ({ ok: true, result: { v: 1, sourceInstanceId: 'deployment-production-failed', sourceContractVersion: 1,
                sourceConfig: { ...input, observingSince: 1 }, displayLabel: input.environmentId } }));
        }
        return undefined;
    };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    const press = (id: string) => pressTestInstanceAsync(screen?.findAllByType(RoundButton).find(row => row.props.testID === id)
        ?? screen?.findAllByType(HappierPressable).find(row => row.props.testID === id), id);
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const { SubjectTriggersSection } = await import('@/components/workflows/triggers/SubjectTriggersSection');
        const { listWorkflowTriggerSets } = await import('@/sync/domains/workflows/workflowTriggerActions');
        expect(await listWorkflowTriggerSets({ scope: 'account_inline' })).toEqual([]);
        // This current Home owns the connected daemon's presence; no legacy heartbeat clock is inferred.
        const controller = createMachineFixture({ ...fresh.machineTarget.machine, presenceProtocolVersion: 1,
            metadata: { host: 'Controller studio', platform: 'linux', happyCliVersion: '0.3.0',
                happyHomeDir: '/home/controller', homeDir: '/home/controller' } });
        storage.getState().applyMachines([controller], true, { sourceServerId: connection.serverId });
        screen = await renderScreen(<ListPresentationProvider value="page"><SubjectTriggersSection subject={{ kind: 'environment',
            environmentId: setupInput.environmentId, machineId: 'runtime-machine' }} subjectName="Production"
            controllerMachineId={machineId} deploymentSourceName="Application checkout"
            deploymentEnvironment={{ serverId: connection.serverId, projectSourceId: 'source-checkout',
                environmentId: setupInput.environmentId }} /></ListPresentationProvider>);
        await waitForHomeGovernance(() => expect(screen!.findByTestId('subject-triggers-starter:deploymentFailed')).not.toBeNull());
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === 'subject-triggers-starter:deploymentFailed'));
        const route = vi.mocked(router.push).mock.calls.at(-1)?.[0];
        if (typeof route !== 'object' || route === null || !('params' in route)) throw new Error('Expected the ordinary sentence route');
        const seed = readWorkflowDefinitionDraftSeed(String(route.params?.definitionDraftSeedId), lifetime.scope);
        if (!seed?.eventSeed) throw new Error('Expected the source enrollment intent in the ordinary draft');
        expect(seed).toMatchObject({ name: 'Production', initialView: 'sentence', eventSeed: {
            eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed, monitoringMachineId: machineId, setupInput,
        } });
        const eventSeed = seed.eventSeed;
        function SentenceEventControl() {
            const [when, setWhen] = React.useState<React.ComponentProps<typeof WorkflowTriggerBlock>['when']>({
                kind: 'pluginEvent', value: null, eventRef: eventSeed.eventRef,
            });
            return <WorkflowTriggerBlock testID="deployment-sentence" title="Production" when={when}
                enabled incomplete={when?.kind === 'pluginEvent' && when.value === null}
                startOptions={[]} onSelectStart={vi.fn()} onChangeWhen={setWhen} onRemove={vi.fn()}
                machineId="runtime-machine" serverId={connection.serverId} accountLifetime={lifetime}
                initialEventSeed={eventSeed} />;
        }
        await screen.update(<SentenceEventControl />);
        await press('deployment-sentence-configure-event');
        const editor = screen.findByType(PluginEventAutomationEditor);
        expect(editor.props.authoringMachineId).toBe(machineId);
        expect(editor.props.initialSetupSeed).toMatchObject({ eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed,
            monitoringMachineId: machineId, setupInput });
        if (!declared || !catalogEvent) {
            await waitForHomeGovernance(() => expect(screen!.findByType(InlinePluginEventEditor).props.model.eventCatalogStatus).toBe('ready'));
            const model = screen.findByType(InlinePluginEventEditor).props.model;
            expect.soft(model.watcherCandidates).toEqual([]);
            expect.soft(model.selectedWatcherOrigin).toBeNull();
            expect.soft(model.sourceStatus).toBe('unavailable');
            expect.soft(model.sourceFailure).toMatchObject({
                code: runtimeUnavailable ? 'plugin_runtime_capability_missing'
                    : catalogEvent ? 'event_observer_unavailable' : 'event_contribution_not_current', retryable: false,
                ...(runtimeUnavailable ? { reason: 'plugin_account_execution_unavailable' } : {}),
            });
            const details = screen.findAllByType(Item).find(row => row.props.testID === 'automation-event-source-unavailable.details.header');
            expect(details, 'A settled source failure must retain its typed cause behind Details').toBeDefined();
            await pressTestInstanceAsync(details);
            expect(screen.getTextContent()).toContain(model.sourceFailure.code);
            expect(screen.getTextContent()).toContain(model.sourceFailure.reason);
            expect.soft(screen.getTextContent()).not.toContain('common.loading');
            expect(submitted).toEqual([]);
            return;
        }
        await waitForHomeGovernance(() => {
            const configure = screen!.findAllByType(HappierPressable)
                .find(row => row.props.testID === 'automation-event-configure-source');
            const model = screen!.findByType(InlinePluginEventEditor).props.model;
            expect(configure, JSON.stringify({ sourceStatus: model.sourceStatus, sourceFailure: model.sourceFailure,
                watcherCandidates: model.watcherCandidates, selectedWatcherOrigin: model.selectedWatcherOrigin })).toBeDefined();
            expect(configure?.props.disabled).toBe(false);
        });
        await press('automation-event-configure-source');
        // This declaration has no input hints: the canonical Action selector validates
        // its complete page-bound input and dispatches without an editable form.
        await waitForHomeGovernance(() => {
            const model = screen!.findAllByType(InlinePluginEventEditor)[0]?.props.model;
            expect(submitted, JSON.stringify({ requestedMethods, eventCatalogStatus: model?.eventCatalogStatus,
                sourceStatus: model?.sourceStatus, sourceFailure: model?.sourceFailure,
                selectedEvent: model?.selectedEvent?.event.identity, selectedWatcherOrigin: model?.selectedWatcherOrigin,
                watcherCandidates: model?.watcherCandidates, watcherFailures: model?.watcherFailures })).toEqual([setupInput]);
        });
        setupResponse.resolve();
        await waitForHomeGovernance(() => expect(screen!.findByType(InlinePluginEventEditor).props.model.createDraft).toBeTruthy());
        await press('automation-plugin-event-done');
        await waitForHomeGovernance(() => expect(screen!.findAllByType(PluginEventAutomationEditor)).toHaveLength(0));
        expect(screen.findByType(TriggerPluginEventRows).props.when).toMatchObject({ kind: 'pluginEvent', value: {
            eventRef: event.event.identity, sourceConfig: expect.objectContaining(setupInput),
            filter: null, maximumObservationAgeMs: null,
            observationTransport: expect.objectContaining({ kind: 'checkpointedPull',
                watcherMaterializationRef: expect.objectContaining({ machineId }) }),
        } });
        await press('deployment-sentence-configure-event');
        await waitForHomeGovernance(() => {
            const model = screen!.findAllByType(InlinePluginEventEditor)[0]?.props.model;
            expect(model?.createDraft, JSON.stringify({
                sourceStatus: model?.sourceStatus, sourceFailure: model?.sourceFailure,
                selectedEvent: model?.selectedEvent?.event.identity, watcherCandidates: model?.watcherCandidates,
            })).toBeTruthy();
        });
        // Editing the freshly configured source reuses it; it must not enroll another observer.
        expect(submitted).toEqual([setupInput]);
        await press('automation-plugin-event-done');
        expect(screen.findByType(TriggerPluginEventRows).props.when).toMatchObject({ kind: 'pluginEvent', value: {
            eventRef: event.event.identity, sourceConfig: expect.objectContaining(setupInput),
        } });
    } finally {
        setupResponse.resolve();
        await screen?.unmount();
        disposeProjection();
        clearDaemonMergedProjectionCacheForTests();
        connection.dispose();
        disposeLoader();
    }
});

function healthSetupFixture(serverId = 'health-setup', serverIdentityId = 'srv_health_setup', native = false,
    contribution = { eventId: 'health-check-failed', actionId: 'health/setup' }, authoredManifest: unknown = PLUGIN_MANIFEST, machineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08') {
    // Source publication admits authored bytes before they can become eligible Events.
    const admitted = ingestPluginManifestV2(authoredManifest);
    expect(admitted.ok, admitted.ok ? undefined : JSON.stringify(admitted.diagnostics)).toBe(true);
    if (!admitted.ok) throw new Error('Health manifest admission failed');
    const { id: pluginId, displayName, version } = admitted.manifest;
    const sourceCustody = { kind: 'development', registeredRootId: 'machine-services-source' } as const;
    const origin = { serverIdentityId, sourceRef: { machineId, pluginId, sourceCustody } };
    const occurrenceId = 'machine-services-current';
    const action = admitted.manifest.contributes.actions?.find(row => row.id === contribution.actionId);
    const declaration = admitted.manifest.contributes.events?.find(row => row.id === contribution.eventId);
    if (!action || declaration?.kind !== 'event' || !declaration.automation) throw new Error('Missing health setup declaration');
    const setupRenderer = declaration.automation.source.setupSurface?.renderer;
    const inputHints = normalizePluginActionInputHintsV2(action.inputHints);
    const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: { id: `${pluginId}/${declaration.id}`, identity: { pluginId, localId: declaration.id },
            occurrenceId, sourceCustody,
            title: typeof declaration.title === 'string' ? declaration.title : declaration.title.fallback,
            localizedPresentation: { title: declaration.title }, description: null,
            payloadSchema: declaration.payloadSchema, automation: declaration.automation },
        setupAction: { id: `${pluginId}/${action.id}`, identity: { pluginId, localId: action.id },
            occurrenceId, title: action.title, description: null, inputSchema: action.inputSchema, inputHints: inputHints ?? null },
        observationBinding: { executionOrigin: origin, materializationRef: { machineId, pluginId, materializationId: 'machine-services-observer' } },
        ...(native && setupRenderer ? { setupSurface: {
            contribution: { pluginId, localId: declaration.id }, occurrenceId, projectionGeneration: 1,
            rendererChain: [{ pluginId, localId: setupRenderer }],
            selectedRenderer: { identity: { pluginId, localId: setupRenderer },
                renderer: { kind: 'reactNative', contributionId: setupRenderer },
                availability: { state: 'available', reason: 'compatible', diagnostics: [] } },
            executionOrigin: origin, resourceCapability: { readable: false, dynamic: false },
            contributorTargetedContributions: { target: { pluginId, occurrenceId, sourceCustody }, points: [] },
        } } : {}),
    });
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName,
            version, enabled: true, source: { kind: 'path', locator: `/sources/${pluginId}` },
            occurrenceId, sourceCustody, executionOrigin: origin } },
        actionsById: { [event.setupAction.id]: { id: action.id, pluginId, occurrenceId, title: action.title,
            execution: action.execution, scopes: action.scopes, surfaces: action.surfaces, inputHints,
            dangerLevel: action.dangerLevel, available: true, placementBindings: [], priority: 0 } },
    });
    const inputs = publishDaemonMergedProjectionInputs({ projection, automationEligibleEvents: [event] });
    const source = { origin, occurrenceId, version, serverId };
    const fresh: FreshPluginMachineExecutionOriginV1 = { origin, source,
        machineTarget: { kind: 'resolved', target: { serverIdentityId, machineId }, serverId,
            profile: { id: serverId, name: 'Health setup', serverUrl: 'https://health.test', serverIdentityId,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1 }, machine: createMachineFixture({ id: machineId }) },
    };
    return { inputs, projection, event, fresh, source, machineId, pluginId };
}

describe('health authoring from an Environment or Machine service', () => {
it.each([
    { label: 'Environment Settings Add check', starter: 'environmentSettingsAddCheck', triggerSubject: { kind: 'environment', environmentId: 'environment-production', machineId: 'deployment-machine' },
        subject: { kind: 'environment', environmentId: 'environment-production' } },
    { label: 'Environment Investigate when health fails', starter: 'healthFailed', triggerSubject: { kind: 'environment', environmentId: 'environment-production', machineId: 'deployment-machine' },
        subject: { kind: 'environment', environmentId: 'environment-production' } },
    { label: 'Machine-service Investigate when health fails', starter: 'healthFailed', triggerSubject: { kind: 'service', machineId: 'service-machine', serviceId: 'service-production' },
        subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'service-production' } },
    // Add a check opens the New trigger editor straight at the service's bound Health form (O-MACH 11-07).
    { label: 'Machine-service Add a check', starter: 'addCheck', triggerSubject: { kind: 'service', machineId: 'service-machine', serviceId: 'service-production' },
        subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'service-production' } },
] as const)('$label through the rendered Event editor', async ({ starter, triggerSubject, subject }) => {
    const { SubjectTriggersSection } = await import('@/components/workflows/triggers/SubjectTriggersSection');
    const { Item } = await import('@/components/ui/lists/Item');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    const { PluginEventAutomationEditor } = await import('./PluginEventAutomationEditor');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = `health-${triggerSubject.kind}-starter`;
    const serverIdentityId = `srv_health_${triggerSubject.kind}_starter`;
    const http = createHomeHubArtifactHttpBoundary(accountId);
    // The Account's empty trigger list is a genuine Home HTTP boundary.
    const connection = await restoreServerAccountForTest({ serverUrl: `https://health-${triggerSubject.kind}-starter.test`,
        serverIdentityId, accountId, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v3/automations/query' && 'subject' in JSON.parse(String(init?.body))) {
                return Response.json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
            }
            if (path === '/v3/automations' || path === '/v3/automations/query') return Response.json({ automations: [], nextCursor: null });
            return http.request(input, init);
        } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected Environment starter Account');
    const listen = starter === 'healthFailed';
    const contribution = listen
        ? { eventId: HEALTH_CHECK_EVENT_REFS_V1.failed.localId, actionId: 'health-check-failed/setup' }
        : { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' };
    const { machineId, pluginId, event, fresh, projection } = healthSetupFixture(connection.serverId, serverIdentityId, !listen, contribution);
    const nativeSourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
    const submitted: unknown[] = [];
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
            return { ok: true, inputSchema: event.setupAction.inputSchema };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            if (listen) {
                const input = Reflect.get(Object(request.payload), 'input');
                const sourceConfig = SavedHealthTransitionSourceV1Schema.parse({ ...Object(input), observingSince: 1 });
                submitted.push(input);
                return { ok: true, result: { v: 1, sourceContractVersion: 1, sourceConfig,
                    sourceInstanceId: createSavedHealthTransitionSourceInstanceIdV1(contribution.eventId, sourceConfig),
                    displayLabel: 'Saved health checks' } };
            }
            const input = HealthCheckSetupInputV1ProtocolSchema.parse(Reflect.get(Object(request.payload), 'input'));
            submitted.push(input);
            return { ok: true, result: { v: 1, sourceInstanceId: 'health-environment-production', sourceContractVersion: 1,
                sourceConfig: input, displayLabel: 'Production health' } };
        }
        return undefined;
    };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let mounted: PluginUiTestkit | undefined;
    let setup: ReturnType<typeof configurePluginEventAutomationSetup> | undefined;
    let retireController: (() => void) | undefined;
    const operation = new AbortController();
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        // Prove the empty Home read is admitted before testing the rendered starter handoff.
        const { listWorkflowTriggerSets } = await import('@/sync/domains/workflows/workflowTriggerActions');
        expect(await listWorkflowTriggerSets({ scope: 'account_inline' })).toEqual([]);
        storage.getState().applyMachines([fresh.machineTarget.machine], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(accountLifetime.scope, [machineId]);
        const subjectPageProps = { subject: triggerSubject, subjectName: 'Production',
            ...(triggerSubject.kind === 'environment' ? { controllerMachineId: machineId,
                deploymentEnvironment: { serverId: connection.serverId, projectSourceId: 'source-production', environmentId: triggerSubject.environmentId } } : {}) };
        if (starter === 'environmentSettingsAddCheck') {
            const { DeploymentEnvironmentSettingsPanel } = await import('@/components/projects/deployments/DeploymentEnvironmentSettingsPanel');
            const { SectionActionButton } = await import('@/components/ui/lists/SectionActionButton');
            const { createDeploymentReadControllerV1, selectDeploymentRuntimeTargetLinkV1 } = await import('@happier-dev/deployments');
            const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
            const { createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
            const { createDeploymentReadTransport } = await import('@/components/projects/deployments/deploymentReadTransport');
            const { createDeploymentActions } = await import('@/components/projects/deployments/deploymentActions');
            const { ItemList } = await import('@/components/ui/lists/ItemList');
            const controller = createDeploymentReadControllerV1({ scope: { ...accountLifetime.scope, projectSourceId: 'source-production' },
                transport: createDeploymentReadTransport(accountLifetime) });
            retireController = () => controller.retire();
            const stored = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
                serverId: connection.serverId, id: triggerSubject.environmentId, controllerMachineId: machineId,
                projectSourceId: 'source-production',
            }) });
            const detail = { ...stored, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(stored), memberVersions: {}, secretRevisions: [] };
            screen = await renderScreen(<ItemList><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
                definitionDocument={{ document: detail.content.definition.kind === 'stored' ? detail.content.definition.document : '', change: () => {} }}
                lifetime={accountLifetime} demand={{ mounted: false, visible: false, focused: false }}
                machineName={id => id} environmentTitle={() => null}
                editing={{ actions: createDeploymentActions(accountLifetime, 'source-production'), serverId: connection.serverId,
                    review: { pendingId: null, request: () => {}, open: () => {} }, onChanged: () => {} }} /></ItemList>);
            await pressTestInstanceAsync(screen.findAllByType(SectionActionButton)
                .find(row => row.props.testID === 'project-deployments.environment.settings.checks-alerts.add'));
        } else {
            screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><ListPresentationProvider value="page">
                <SubjectTriggersSection {...subjectPageProps} />
            </ListPresentationProvider></PluginSurfaceFocusEligibilityProvider>);
            await waitForHomeGovernance(() => expect(screen!.findByTestId(`subject-triggers-starter:${starter}`), screen!.getTextContent()).not.toBeNull());
            const restorePopoverGlobals = withPopoverWebGlobals();
            try {
                await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === `subject-triggers-starter:${starter}`));
                if (listen) await pressTestInstanceAsync(screen.findAllByType(RoundButton)
                    .find(button => button.props.testID === 'workflow-builder-open-editor'));
            } finally {
                restorePopoverGlobals();
            }
        }
        if (starter === 'healthFailed') {
            const { router } = await import('expo-router');
            const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
            const { WorkflowTriggerBlock } = await import('@/components/workflows/triggers/WorkflowTriggerBlock');
            const route = vi.mocked(router.push).mock.calls.at(-1)?.[0];
            if (typeof route !== 'object' || route === null || !('params' in route)) throw new Error('Expected the ordinary Health sentence route');
            const seed = readWorkflowDefinitionDraftSeed(String(route.params?.definitionDraftSeedId), accountLifetime.scope);
            const eventSeed = seed?.incompleteTriggers?.pending[0]?.eventSeed;
            if (!eventSeed) throw new Error('Expected the retained Health source enrollment intent');
            await screen.update(<WorkflowTriggerBlock testID="health-sentence" title="Health" enabled incomplete
                when={{ kind: 'pluginEvent', value: null, eventRef: eventSeed.eventRef }}
                startOptions={[]} onSelectStart={vi.fn()} onChangeWhen={vi.fn()} onRemove={vi.fn()}
                machineId={triggerSubject.machineId} serverId={connection.serverId} accountLifetime={accountLifetime}
                initialEventSeed={eventSeed} />);
            await pressTestInstanceAsync(screen.findAllByType(HappierPressable)
                .find(button => button.props.testID === 'health-sentence-configure-event'));
        }
        const editor = screen.findByType(PluginEventAutomationEditor);
        expect(editor).not.toBeNull();
        // Settings → Add check hosts the one native Add check surface (R10-D1); the starters keep the workflow editor's seed.
        const initialSetupSeed: React.ComponentProps<typeof PluginEventAutomationEditor>['initialSetupSeed'] =
            editor.props.newSourceSetup?.seed ?? editor.props.initialSetupSeed;
        expect(initialSetupSeed?.eventRef).toEqual(event.event.identity);
        if (listen) {
            const selection = { v: 1, serverId: accountLifetime.scope.serverId, nativeSourceInstanceId };
            expect(initialSetupSeed?.setupInput).toEqual(selection);
            expect(initialSetupSeed?.sourceInstanceId).toBeUndefined();
            setup = configurePluginEventAutomationSetup({ eligibleEvent: event, initialSetupSeed, observationTransport: 'checkpointedPull',
                filter: null, maximumObservationAgeMs: null, accountLifetime, signal: operation.signal,
                resolveExecutionOrigin: () => fresh,
                loadCurrentProjection: target => loadDaemonMergedProjectionInputs({ ...target, accountLifetime, sections: 'complete' }),
                present: ({ form }) => { void form.submit().then(result => {
                    if (result.kind !== 'settled') form.cancel();
                }); },
            });
            const result = await setup;
            expect({ result, submitted }).toMatchObject({ result: { kind: 'configured' }, submitted: [selection] });
            return;
        }
        // The native surface adapter is the UI platform boundary; source selection, schema,
        // ephemeral settlement and the contributed Action dispatch all remain canonical.
        let presented!: () => void;
        const surfaceReady = new Promise<void>(resolve => { presented = resolve; });
        setup = configurePluginEventAutomationSetup({ eligibleEvent: event, initialSetupSeed, observationTransport: 'checkpointedPull',
            filter: null, maximumObservationAgeMs: null, accountLifetime, signal: operation.signal,
            resolveExecutionOrigin: () => fresh,
            loadCurrentProjection: target => loadDaemonMergedProjectionInputs({ ...target, accountLifetime, sections: 'complete' }),
            present: () => { throw new Error('Health starter must open its native form'); },
            presentSetupSurface: async params => new Promise((resolve, reject) => {
                let settled = false;
                params.signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
                const binding = createPluginEventAutomationSetupSurfaceBinding({ isSettled: () => settled,
                    settle: value => { settled = true; resolve(value); } });
                const handler = binding.createMountedHostApiHandlers?.({ isCurrent: accountLifetime.isCurrent })?.handlers.settleEphemeralInput;
                if (!handler) throw new Error('Expected canonical ephemeral input handler');
                void (async () => {
                    const surfaceContext = createSurfaceContextFixture();
                    await act(async () => { mounted = await createPluginUiTestkit({ surface: renderSurface,
                        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
                        identity: { instanceId: 'environment-health', mountNonce: 'environment-health-mount' },
                        authorPlugin: { id: pluginId, version: PLUGIN_MANIFEST.version }, surfaceContext, launchInput: params.launchInput,
                        handlers: { executeAction: previewHealthSetup, settleEphemeralInput: async ({ settlement }) => {
                            expect(await handler(PluginUiHostApiRequestEnvelopeV1Schema.parse({ version: 1, requestId: 'environment-health-settle',
                                surface: { pluginId, contributionId: event.event.identity.localId, surfaceId: 'environment-health',
                                    platform: surfaceContext.platform, channel: 'development' }, method: 'settleEphemeralInput', payload: settlement }))).toBeNull();
                        } },
                    }); });
                    presented();
                })().catch(reject);
            }),
        });
        await Promise.race([surfaceReady, setup.then(outcome => { throw new Error(`Health form did not open: ${JSON.stringify(outcome)}`); })]);
        expect(await mounted!.getByRole('textbox', { label: 'Endpoint' })).toBeDefined();
        expect(editor.props.initialSetupSeed).toMatchObject({ eventRef: event.event.identity, setupInput: { v: 1, subject } });
        if (triggerSubject.kind === 'environment') {
            // The Environment controller owns this guided watcher placement, not its runtime Machine.
            expect(editor.props.authoringMachineId).toBe(machineId);
            expect(editor.props.initialSetupSeed).toHaveProperty('monitoringMachineId', machineId);
        } else {
            expect(editor.props.authoringMachineId).toBe(triggerSubject.machineId);
            expect(editor.props.initialSetupSeed).not.toHaveProperty('monitoringMachineId');
        }
        const field = document.querySelector('input[aria-label="Endpoint"]');
        if (!(field instanceof HTMLInputElement)) throw new Error('Expected native Health Endpoint field');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setValue) throw new Error('Expected browser input value setter');
        await act(async () => { setValue.call(field, 'https://production.example.test/health'); field.dispatchEvent(new Event('input', { bubbles: true })); });
        const add = await mounted!.getByRole('button', { name: 'Add check' });
        expect(add.state?.disabled ?? false).toBe(false);
        await act(async () => { await mounted!.press(add); });
        expect((await setup).kind).toBe('configured');
        expect(submitted).toEqual([expect.objectContaining({ subject, checks: [expect.objectContaining({
            config: { endpoint: 'https://production.example.test/health', expectStatus: 200 } })] })]);
    } finally {
        operation.abort();
        await setup;
        await mounted?.dispose();
        await screen?.unmount();
        retireController?.();
        clearDaemonMergedProjectionCacheForTests();
        connection.dispose();
        disposeLoader();
    }
});
});

it('admits the machine-services Health Event, offers its installation as a watcher and opens an editable Configure source form', async () => {
    const { inputs, event, fresh, source, machineId, pluginId } = healthSetupFixture();
    expect(inputs.automationEligibleEvents?.find(candidate => candidate.event.id === event.event.id)).toEqual(event);
    expect(readPluginEventAutomationWatcherFailure({ source,
        releaseContent: 'matched', validation: { kind: 'admitted' } }, event)).toBeNull();
    let presentForm: (form: SetupForm | null) => void = () => {};
    const presented = new Promise<SetupForm | null>(resolve => { presentForm = resolve; });
    const dispatch = vi.fn<PluginContributedActionDispatch>(async () => ({ ok: false, code: 'contributed_action_unavailable',
        reason: 'contributed_action_unavailable' }));
    const setup = configurePluginEventAutomationSetup({ eligibleEvent: event, observationTransport: 'checkpointedPull',
        filter: null, maximumObservationAgeMs: null, resolveExecutionOrigin: () => fresh,
        accountLifetime: { scope: { serverId: source.serverId, accountId: 'health-account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) },
        loadCurrentProjection: async () => inputs, present: ({ form }) => presentForm(form), dispatch });
    const form = await Promise.race([presented, setup.then(() => null)]);
    expect(form, 'Health setup must collect its required operands before dispatch').not.toBeNull();
    if (!form) return;
    try {
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={() => {}} />);
        expect(form.getFields().map(field => field.path)).toEqual(['subject', 'checks', 'investigation.mode']);
        const controls = () => screen.findAllByType(TextInput);
        expect(controls()).toHaveLength(2);
        expect(dispatch).not.toHaveBeenCalled();
        const subject = { kind: 'machineService', machineId, serviceId: 'systemd:qa-health' };
        const checks = [{ checkId: 'tcp', kind: { pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
            config: { host: '127.0.0.1', port: 8080 }, periodMs: 300000, consecutiveFailuresBeforeAlerting: 1 }];
        await act(async () => { changeTextTestInstance(controls()[0], JSON.stringify(subject)); });
        await act(async () => { changeTextTestInstance(controls()[1], JSON.stringify(checks)); });
        const sourceConfig = { v: 1, subject, checks, investigation: { mode: 'inbox' } };
        expect(form.getInput()).toEqual(sourceConfig);
        await act(async () => {
            expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
        });
        await setup;
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: event.setupAction.identity, input: sourceConfig }));
    } finally { form.cancel(); await setup; }
});

it.each([
    { result: 'configured', reopen: false, editAddress: false },
    { result: 'configured', reopen: true, editAddress: false },
    { result: 'configured', reopen: true, editAddress: true },
    { result: 'refused', reopen: false, editAddress: false },
] as const)('submits the native Health setup through the real store and Action dispatcher ($result, reopen=$reopen, editAddress=$editAddress)', async ({ result, reopen, editAddress }) => {
    const fixtureName = editAddress ? 'edit-address' : result;
    const accountId = `health-native-${fixtureName}`;
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: `https://health-${fixtureName}.test`,
        serverIdentityId: `srv_health_${fixtureName}`, accountId, request: http.request });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected restored Health Account lifetime');
    const fixture = healthSetupFixture(connection.serverId, `srv_health_${fixtureName}`, true, {
        eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup',
    });
    const { machineId, pluginId, event, fresh, projection } = fixture;
    const subject = { kind: 'machineService' as const, machineId: 'service-machine', serviceId: 'systemd:qa-health' };
    const existing = HealthCheckSetupInputV1ProtocolSchema.parse({ v: 1, subject, checks: [{ checkId: 'http',
        kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'https://existing-health.test', expectStatus: 200 }, periodMs: 300000,
        consecutiveFailuresBeforeAlerting: 1 }, {
        checkId: 'queue-dns', kind: { pluginId, localId: 'dns' }, binding: { kind: 'healthCheck' },
        config: { hostname: 'queue.example.test', recordType: 'MX', expectedAnswer: 'outbound.example.test' }, periodMs: 900000,
        consecutiveFailuresBeforeAlerting: 5 }] });
    const submitted: unknown[] = [];
    const settlementErrors: unknown[] = [];
    const remediation = { kind: 'openSettings' as const, path: '/settings/machines' };
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
        }
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return undefined;
        if (typeof request.payload !== 'object' || request.payload === null || !('input' in request.payload)) {
            throw new Error('Expected Action input at daemon transport');
        }
        const input = HealthCheckSetupInputV1ProtocolSchema.parse(request.payload.input);
        submitted.push(input);
        return result === 'configured'
            ? { ok: true, result: { v: 1, sourceInstanceId: 'health-native-source', sourceContractVersion: 1,
                sourceConfig: input, displayLabel: 'Saved health checks' } }
            : { ok: false, code: 'health_check_loopback_refused', retryable: false, remediation };
    };
    let surfaceReady!: () => void;
    let surfaceFailed!: (error: unknown) => void;
    const presented = new Promise<void>((resolve, reject) => {
        surfaceReady = resolve;
        surfaceFailed = reject;
    });
    let mounted: PluginUiTestkit | undefined;
    const operation = new AbortController();
    let setup: ReturnType<typeof configurePluginEventAutomationSetup> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        storage.getState().applyMachines([fresh.machineTarget.machine], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(accountLifetime.scope, [machineId]);
        setup = configurePluginEventAutomationSetup({ eligibleEvent: event, observationTransport: 'checkpointedPull',
            ...(reopen
                ? { initialSource: { v: 1 as const, sourceInstanceId: 'health-native-source', sourceContractVersion: 1,
                    sourceConfig: existing, displayLabel: 'Saved health checks' } }
                : { initialSetupSeed: { eventRef: event.event.identity, monitoringMachineId: machineId, setupInput: existing } }),
            ...(editAddress ? { savedSourceRendererInput: { selectedCheckId: 'http' } } : {}),
            filter: null, maximumObservationAgeMs: null, accountLifetime, signal: operation.signal,
            resolveExecutionOrigin: () => fresh,
            loadCurrentProjection: target => loadDaemonMergedProjectionInputs({ ...target, accountLifetime, sections: 'complete' }),
            present: ({ form }) => {
                void renderScreen(<ActionInputFormModal form={form} onClose={() => form.cancel()} />).then(() => surfaceReady(), surfaceFailed);
            },
            presentSetupSurface: async params => new Promise((resolve, reject) => {
                let settled = false;
                params.signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
                const binding = createPluginEventAutomationSetupSurfaceBinding({ isSettled: () => settled,
                    settle: value => { settled = true; resolve(value); } });
                const handler = binding.createMountedHostApiHandlers?.({ isCurrent: accountLifetime.isCurrent })?.handlers.settleEphemeralInput;
                if (!handler) throw new Error('Expected canonical ephemeral settlement handler');
                void (async () => {
                    const surfaceContext = createSurfaceContextFixture({ mount: { kind: 'embedded', role: 'ephemeralInput', presentation: 'content' },
                        target: { kind: 'app' }, accountEncryptionMode: 'plain' });
                    await act(async () => { mounted = await createPluginUiTestkit({ surface: renderSurface,
                        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
                        identity: { instanceId: 'health-setup-native', mountNonce: 'health-setup-native-mount' },
                        authorPlugin: { id: pluginId, version: PLUGIN_MANIFEST.version }, launchInput: params.launchInput,
                        surfaceContext,
                        handlers: { executeAction: previewHealthSetup, settleEphemeralInput: async ({ settlement }) => {
                            try {
                                const response = await handler(PluginUiHostApiRequestEnvelopeV1Schema.parse({
                                    version: 1, requestId: 'health-native-settle', surface: {
                                        pluginId, contributionId: event.event.identity.localId,
                                        surfaceId: 'health-setup-native', platform: surfaceContext.platform, channel: 'development',
                                    },
                                    method: 'settleEphemeralInput', payload: settlement,
                                }));
                                expect(response).toBeNull();
                            } catch (error) { settlementErrors.push(error); throw error; }
                        } },
                    }); });
                    surfaceReady();
                })().catch(error => { surfaceFailed(error); reject(error); });
            }),
        });
        await Promise.race([presented, setup.then(outcome => {
            throw new Error(`Native surface did not open: ${JSON.stringify(outcome)}`);
        })]);
        expect(document.querySelector('input[aria-label="Endpoint"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="health-setup-form"]')).not.toBeNull();
        if (!mounted) throw new Error('Expected canonical Health renderer mount');
        const changeEndpoint = async (value: string) => {
            const field = document.querySelector('input[aria-label="Endpoint"]');
            if (!(field instanceof HTMLInputElement)) throw new Error('Expected typed Health Endpoint field');
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setValue) throw new Error('Expected browser input value setter');
            await act(async () => { setValue.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
        };
        if (editAddress) expect(document.querySelector<HTMLInputElement>('input[aria-label="Endpoint"]')?.value)
            .toBe('https://existing-health.test');
        const submitLabel = editAddress ? 'Save changes' : 'Add check';
        expect(submitted).toEqual([]);
        await changeEndpoint('http://127.0.0.1:8080');
        expect(document.querySelector('[data-testid="health-setup-loopback-refused"]')).not.toBeNull();
        expect((await mounted.getByRole('button', { name: submitLabel })).state?.disabled).toBe(true);
        expect(submitted).toEqual([]);
        await changeEndpoint('https://added-health.test');
        expect(document.querySelector('[data-testid="health-setup-loopback-refused"]')).toBeNull();
        expect((await mounted.getByRole('button', { name: submitLabel })).state?.disabled ?? false).toBe(false);
        await act(async () => { await mounted!.press(await mounted!.getByRole('button', { name: submitLabel })); });
        expect(settlementErrors).toEqual([]);
        await Promise.race([
            waitForHomeGovernance(() => expect(submitted).toHaveLength(1)),
            setup.then(outcome => { expect(healthBoundaryErrors).toEqual([]); expect(submitted, JSON.stringify(outcome)).toHaveLength(1); }),
        ]);
        const outcome = await setup;
        expect(submitted).toHaveLength(1);
        expect(rpc.hostActions).toEqual([{ action: event.setupAction.identity, expectedContributorOccurrenceId: event.event.occurrenceId, input: submitted[0] }]);
        const input = HealthCheckSetupInputV1ProtocolSchema.parse(submitted[0]);
        expect(input.subject).toEqual(subject);
        if (editAddress) {
            expect(input.checks).toEqual([{ ...existing.checks[0],
                config: { endpoint: 'https://added-health.test', expectStatus: 200 } }, existing.checks[1]]);
        } else {
            expect(input.checks).toHaveLength(existing.checks.length + 1);
            expect(input.checks.slice(0, existing.checks.length)).toEqual(existing.checks);
            expect(input.checks.at(-1)).toMatchObject({ checkId: 'http-2', kind: { pluginId, localId: 'http' },
                config: { endpoint: 'https://added-health.test', expectStatus: 200 } });
        }
        if (result === 'configured') expect(outcome.kind).toBe('configured');
        else expect(outcome).toMatchObject({ kind: 'unavailable', code: 'health_check_loopback_refused',
            reason: 'health_check_loopback_refused' });
    } finally {
        operation.abort();
        await setup;
        await mounted?.dispose();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
    }
});

it.each([
    { kind: 'uptime-kuma', field: 'Monitor ID', key: 'monitorId', original: '177', edited: '178',
        config: { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', observingSince: 1 } },
    { kind: 'gatus', field: 'Endpoint name', key: 'endpointName', original: 'health', edited: 'health-edited',
        config: { endpointGroup: 'Production', webhookEndpointId: 'wh_ep_BBBBBBBBBBBBBBBBBBBBBB', observingSince: 1 } },
    { kind: 'settings-kuma', providerKind: 'uptime-kuma', field: 'Monitor ID', key: 'monitorId', original: '177', edited: '178',
        config: { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', observingSince: 1 } },
    { kind: 'settings-gatus', providerKind: 'gatus', field: 'Endpoint name', key: 'endpointName', original: 'health', edited: 'health-edited',
        config: { endpointGroup: 'Production', webhookEndpointId: 'wh_ep_BBBBBBBBBBBBBBBBBBBBBB', observingSince: 1 } },
    { kind: 'http', field: 'Endpoint', key: 'endpoint', original: 'https://before.test/health', edited: 'https://after.test/health',
        config: { expectStatus: 200 } },
    { kind: 'legacy-http', field: 'Endpoint', key: 'endpoint', original: 'https://before.test/health', edited: 'https://after.test/health',
        config: { expectStatus: 200 } },
    { kind: 'sentry' },
    { kind: 'posthog' },
] as const)('persists a saved $kind edit after the setup Action settles', async fixture => {
    const kind = 'providerKind' in fixture ? fixture.providerKind : fixture.kind;
    const legacy = kind === 'legacy-http';
    const fromCheckSettings = legacy || 'providerKind' in fixture;
    const provider = kind === 'sentry' || kind === 'posthog' ? kind : null;
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { createWorkflowAutomationHttpBoundary, createWorkflowAutomationTriggerDetailFixture } = await import('@/dev/testkit/harness/workflowAutomationHttpBoundary');
    const { AutomationDefinitionDetailSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
    const { AutomationTriggerIdSchema } = await import('@happier-dev/protocol/automations/automationTriggerIdentity');
    const { listWorkflowTriggerPage } = await import('@/sync/domains/workflows/workflowTriggerActions');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const { AccountTriggersSection } = await import('@/components/workflows/triggers/AccountTriggersSection');
    const { TriggerRow } = await import('@/components/workflows/triggers/TriggerRow');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { Item } = await import('@/components/ui/lists/Item');
    const { TextLinkButton } = await import('@/components/ui/buttons/TextLinkButton');
    const { InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
    const { Modal } = await import('@/modal');
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');

    const accountId = `monitor-save-${kind}`;
    const serverIdentityId = `srv_monitor_save_${kind.replace('-', '_')}`;
    const home = createHomeHubArtifactHttpBoundary(accountId);
    const automations = createWorkflowAutomationHttpBoundary();
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const connection = await restoreServerAccountForTest({ serverUrl: `https://${accountId}.test`, serverIdentityId, accountId,
        request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            return await automations.handle(url, init) ?? home.request(input, init);
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the restored monitor Account');
    const { TRIAGE_ISSUE_EVENT_LOCAL_ID_V1, TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1, TRIAGE_ISSUE_WATCH_SOURCES_V1 } =
        await import('../../../../../../packages/triage-sources/src/observations/issueSource');
    const providerManifest = provider && (provider === 'sentry'
        ? (await import('../../../../../../packages/plugins/sentry/src/manifest')).PLUGIN_MANIFEST
        : (await import('../../../../../../packages/plugins/posthog/src/manifest')).PLUGIN_MANIFEST);
    const { machineId, pluginId, projection, event, fresh, inputs } = healthSetupFixture(connection.serverId, serverIdentityId, !provider,
        provider ? { eventId: TRIAGE_ISSUE_EVENT_LOCAL_ID_V1, actionId: TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1 }
            : { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' },
        providerManifest ?? PLUGIN_MANIFEST);
    const legacyEvent = legacy ? healthSetupFixture(connection.serverId, serverIdentityId, false,
        { eventId: HEALTH_CHECK_EVENT_REFS_V1.failed.localId, actionId: 'health-check-failed/setup' }).event : null;
    const savedEventRef = legacyEvent?.event.identity ?? event.event.identity;
    const automationId = '412bddd2-014a-4ebf-8854-a3954566cb7f';
    const triggerId = AutomationTriggerIdSchema.parse('262544ff-0dc8-4240-9462-89784070f592');
    const subject = { kind: 'machineService' as const, machineId, serviceId: 'production' };
    const sourceInstanceId = provider ? '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' : createHealthCheckSourceInstanceIdV1(subject);
    const { TriageIssueEventSetupInputV1Schema, TriageIssueEventSourceConfigV1Schema } = await import('@happier-dev/triage-protocol/v1');
    const providerConfig = provider && await (async () => {
        const { createTriageSourceV1Fixture } = await import('@happier-dev/triage-protocol/testing/v1');
        const retained = createTriageSourceV1Fixture().configuredInstance;
        const purpose = provider === 'sentry'
            ? (await import('../../../../../../packages/plugins/sentry/src/sentryContracts')).SENTRY_CONNECTED_ACCOUNT_PURPOSE
            : (await import('../../../../../../packages/plugins/posthog/src/posthogContracts')).POSTHOG_CONNECTED_ACCOUNT_PURPOSE;
        return TriageIssueEventSourceConfigV1Schema.parse({ v: 1, instance: {
            ...retained, instance: { sourceInstanceId, source: TRIAGE_ISSUE_WATCH_SOURCES_V1[provider] },
            binding: { purpose, account: { service: { pluginId, localId: purpose }, accountId } },
        }, checkPeriodMs: 120_000, investigation: { mode: 'inbox' } });
    })();
    const sourceConfig = providerConfig ?? ('field' in fixture ? HealthCheckSetupInputV1ProtocolSchema.parse({ v: 1, subject, checks: [{
        checkId: 'saved', kind: { pluginId, localId: legacy ? 'http' : kind }, binding: { kind: 'healthCheck' },
        config: { ...fixture.config, [fixture.key]: fixture.original }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 1,
    }], alerts: { channels: [], phases: ['open', 'recovered'] }, investigation: { mode: 'inbox' } }) : null);
    if (!sourceConfig) throw new Error('Expected saved Event configuration');
    automations.rows.set(automationId, AutomationDefinitionDetailSchema.parse({
        id: automationId, name: 'Production check', description: null, enabled: true, templateVersion: 1,
        workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null, lastRunAt: null,
        createdAt: 1, updatedAt: 1, assignments: [], observationOnly: { kind: 'observationOnly', templateVersion: 1 },
        triggers: [createWorkflowAutomationTriggerDetailFixture(automationId, { kind: 'new', triggerId,
            trigger: { kind: 'pluginEvent', enabled: true, eventRef: savedEventRef, sourceInstanceId,
                sourceContractVersion: 1, sourceConfig, displayLabel: 'Saved health checks', filter: null,
                maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull',
                    watcherMaterializationRef: { machineId, pluginId, materializationId: 'machine-services-observer' } } } })],
    }));
    const origins = readPluginUiExecutionOriginCandidates({ pluginId, projection: inputs.pluginUiProjection,
        members: [{ machineId, serverId: connection.serverId, serverIdentityId, projection: inputs.pluginUiProjection,
            phase: 'current', interactionEnabled: true }] });
    const disposeProjection = publishCommittedAppShellPluginUiProjection(() => inputs.pluginUiProjection,
        id => id === pluginId ? origins : null);
    const pendingSetup = createDeferred<void>();
    const presented = createDeferred<PluginUiTestkit>();
    const contributedForm = createDeferred<SetupForm>();
    const setupInputs: unknown[] = [];
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection, automationEligibleEvents: legacyEvent ? [event, legacyEvent] : [event] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)
            return { ok: true, inputSchema: event.setupAction.inputSchema };
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return undefined;
        const rawInput = Reflect.get(Object(request.payload), 'input');
        const input = providerConfig ? TriageIssueEventSetupInputV1Schema.parse(rawInput) : HealthCheckSetupInputV1ProtocolSchema.parse(rawInput);
        setupInputs.push(input);
        let resultConfig: unknown = input;
        if (providerConfig) {
            const seconds = TriageIssueEventSetupInputV1Schema.parse(input).checkPeriodSeconds;
            if (seconds === undefined) throw new Error('Expected a polling period at the provider boundary');
            resultConfig = TriageIssueEventSourceConfigV1Schema.parse({ ...providerConfig, checkPeriodMs: seconds * 1_000 });
        }
        return pendingSetup.promise.then(() => ({ ok: true, result: { v: 1, sourceInstanceId, sourceContractVersion: 1,
            sourceConfig: resultConfig, displayLabel: event.event.title, observationOnly: { kind: 'observationOnly' } } }));
    };
    // Mount the actual contributed renderer at the native-modal boundary. The editor still
    // owns the modal launch, the host binding, Action dispatch, and outer trigger submission.
    const originalShow = Modal.show;
    let nativeSurface: PluginUiTestkit | undefined;
    const modal = vi.spyOn(Modal, 'show').mockImplementation(config => {
        if (config.component === ActionInputFormModal && typeof config.props === 'object' && config.props !== null && 'form' in config.props) {
            contributedForm.resolve(config.props.form as SetupForm);
            return 'monitor-edit-contributed';
        }
        const launchInput = Reflect.get(Object(config.props), 'launchInput');
        const onSettle: unknown = Reflect.get(Object(config.props), 'onSettle');
        if (typeof onSettle !== 'function') return originalShow(config);
        const surfaceContext = createSurfaceContextFixture({ mount: { kind: 'embedded', role: 'ephemeralInput', presentation: 'content' },
            target: { kind: 'app' }, accountEncryptionMode: 'plain' });
        let settled = false;
        const handlers = createPluginEventAutomationSetupSurfaceBinding({ isSettled: () => settled,
            settle: value => { settled = true; onSettle(value); } }).createMountedHostApiHandlers?.({ isCurrent: lifetime.isCurrent });
        const settle = handlers?.handlers.settleEphemeralInput;
        if (!settle) throw new Error('Expected the native source settlement handler');
        void createPluginUiTestkit({ surface: renderSurface, adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
            identity: { instanceId: 'monitor-edit-native', mountNonce: 'monitor-edit-mount' },
            authorPlugin: { id: pluginId, version: PLUGIN_MANIFEST.version }, launchInput, surfaceContext,
            handlers: { executeAction: previewHealthSetup, settleEphemeralInput: async ({ settlement }) => {
                expect(await settle(PluginUiHostApiRequestEnvelopeV1Schema.parse({
                    version: 1, requestId: 'monitor-edit-settle', surface: { pluginId, contributionId: event.event.identity.localId,
                        surfaceId: 'monitor-edit-native', platform: surfaceContext.platform, channel: 'development' },
                    method: 'settleEphemeralInput', payload: settlement,
                }))).toBeNull();
            } },
        }).then(mounted => { nativeSurface = mounted; presented.resolve(mounted); }, presented.reject);
        return 'monitor-edit-native';
    });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    const button = (id: string) => screen?.findAllByType(RoundButton).find(row => row.props.testID === id);
    const submit = () => pressTestInstanceAsync(screen?.findAllByType(TextLinkButton).find(row =>
        row.props.testID === 'workflows-column-trigger-popover-submit'));
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        storage.getState().applyMachines([fresh.machineTarget.machine], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(lifetime.scope, [machineId]);
        if (fromCheckSettings) {
            const { ServiceCheckDetail } = await import('@/components/projects/deployments/ServiceCheckDetail');
            const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
            const definition = automations.rows.get(automationId);
            if (!definition || !('field' in fixture)) throw new Error('Expected the saved native Check');
            screen = await renderScreen(<ServiceCheckDetail nowMs={Date.now()} row={{ kind: 'configuredCheck', key: automationId,
                scope: lifetime.scope, automationId, triggerId, native: createAutomationDefinitionSummary(definition),
                definitionFacts: { kind: 'available', observerMachineId: machineId, checks: [{ checkId: 'saved', name: 'Readiness',
                    targetLabel: legacy ? fixture.original : null, periodMs: 60_000, domainId: null, keyFlow: null }] },
                lastResults: { kind: 'available', checks: [] },
            }} />);
            const address = screen.findAllByType(Item).find(row => row.props.testID === 'services.check.settings.address');
            if (!legacy) expect(address).toBeUndefined();
            if (!legacy) await waitForHomeGovernance(() => expect(screen!.findAllByType(Item)
                .some(row => row.props.testID === 'services.check.settings.alert')).toBe(true));
            await pressTestInstanceAsync(legacy ? address : screen.findAllByType(Item)
                .find(row => row.props.testID === 'services.check.settings.alert'));
            await waitForHomeGovernance(() => expect(nativeSurface, screen!.getTextContent()).toBeDefined());
        } else {
            screen = await renderScreen(<AccountTriggersSection />);
            const row = () => screen?.findAllByType(TriggerRow).find(candidate => candidate.props.testID === `workflows-column:trigger:${automationId}`);
            await waitForHomeGovernance(() => expect(row()).toBeDefined());
            const restorePopoverGlobals = withPopoverWebGlobals();
            try { await pressTestInstanceAsync(row()); }
            finally { restorePopoverGlobals(); }
            await pressTestInstanceAsync(screen.findAllByType(Item).find(candidate =>
                candidate.props.testID === 'workflows-column-trigger-popover-configure-event'));
            await waitForHomeGovernance(() => expect(screen!.findByType(InlinePluginEventEditor).props.model.sourceStatus).toBe('configured'));
            await pressTestInstanceAsync(screen.findAllByType(HappierPressable).find(candidate => candidate.props.testID === 'automation-event-configure-source'));
        }
        const editedConfig = 'field' in fixture ? { checks: [{ config: { [fixture.key]: fixture.edited } }] } : { checkPeriodMs: 180_000 };
        if ('field' in fixture) {
            const mounted = await presented.promise;
            const control = document.querySelector(`input[aria-label="${fixture.field}"]`);
            if (!(control instanceof HTMLInputElement)) throw new Error(`Expected editable ${fixture.field}`);
            expect(control.value).toBe(fixture.original);
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setValue) throw new Error('Expected browser input setter');
            await act(async () => { setValue.call(control, fixture.edited); control.dispatchEvent(new Event('input', { bubbles: true })); });
            await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Save changes' })); });
            await waitForHomeGovernance(() => expect(setupInputs).toMatchObject([editedConfig]));
        } else {
            const form = await contributedForm.promise;
            expect(form.getInput()).toMatchObject({ sourceInstanceId, checkPeriodSeconds: 120 });
            form.replaceInput({ ...form.getInput(), checkPeriodSeconds: 180 });
            await act(async () => { expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } }); });
            await waitForHomeGovernance(() => expect(setupInputs).toMatchObject([{ sourceInstanceId, checkPeriodSeconds: 180 }]));
        }
        const innerDone = button('automation-plugin-event-done');
        if (!fromCheckSettings) expect(innerDone).toBeDefined();
        if (innerDone && !innerDone.props.disabled) {
            await pressTestInstanceAsync(button('automation-plugin-event-done'));
            await submit();
        }
        await act(async () => pendingSetup.resolve());
        if (button('automation-plugin-event-done')) {
            await waitForHomeGovernance(() => expect(button('automation-plugin-event-done')?.props.disabled).toBe(false));
            await pressTestInstanceAsync(button('automation-plugin-event-done'));
            if (kind === 'uptime-kuma') {
                automations.respondWith(method => method === 'PUT'
                    ? Response.json({ error: 'automation_template_version_conflict' }, { status: 409 }) : undefined);
                await submit();
                await waitForHomeGovernance(() => expect(screen!.findByTestId('workflows-column-trigger-popover-failure')).not.toBeNull());
                const refused = await listWorkflowTriggerPage({ automationId, triggerId });
                expect(refused.sets).toMatchObject([{ revision: 1, triggers: [{ id: triggerId, revision: 0 }] }]);
                expect(refused.triggerDefinition).toMatchObject({ triggerId, definition: { sourceConfig } });
                automations.respondWith(undefined);
            }
            await submit();
        }
        if (fromCheckSettings) await waitForHomeGovernance(() => expect(automations.rows.get(automationId)?.templateVersion).toBe(2));
        const persisted = await listWorkflowTriggerPage({ automationId, triggerId });
        expect(persisted.sets).toMatchObject([{ revision: 2, triggers: [{ id: triggerId, revision: 1 }] }]);
        expect(persisted.triggerDefinition).toMatchObject({ triggerId, definition: {
            sourceConfig: editedConfig,
        } });
        if (legacy) expect(automations.rows.get(automationId)?.triggers[0]).toMatchObject({
            eventRef: HEALTH_CHECK_EVENT_REFS_V1.status,
        });
    } finally {
        pendingSetup.resolve();
        modal.mockRestore();
        await nativeSurface?.dispose();
        await screen?.unmount();
        disposeProjection();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
        disposeLoader();
    }
});

it.each(['configured', 'refused'] as const)('settles native Add check after showing setup progress (%s)', async outcome => {
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { PluginEventAutomationEditor } = await import('./PluginEventAutomationEditor');
    const { Modal } = await import('@/modal');
    const { subjectStarterEventSeed } = await import('@/components/workflows/triggers/subjectTriggerStarters');
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'native-add-check';
    const serverIdentityId = 'srv_native_add_check';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    let exactIntentRead: unknown;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://native-add-check.test',
        serverIdentityId, accountId, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'] && exactIntentRead)
                return Response.json(exactIntentRead);
            if (path === '/v1/features' || path === '/v1/features/authenticated')
                return Response.json(createRootLayoutFeaturesResponse());
            return http.request(input, init);
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected Add check Account');
    const { machineId, pluginId, event, fresh, inputs, projection } = healthSetupFixture(
        connection.serverId, serverIdentityId, true, { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' },
    );
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error('Expected the Machine services manifest');
    const declarationDigestSha256: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
    const intentRead: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId, enabled: true, desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: [], revision: 'health-declaration' },
        release: null, uiArtifacts: [], packageAssets: [], currentDeclaration: null,
        machineDeclarations: [{ machineId, machineInstallationId: 'health-installation', declaration: { declarationDigestSha256 } }],
    };
    exactIntentRead = { ...intentRead, declarationBodies: [{ declarationDigestSha256, manifest: admitted.manifest }] };
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: intentRead }],
    } });
    const subject = { kind: 'environment' as const, environmentId: 'production' };
    const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
    const setupInput = HealthCheckSetupInputV1ProtocolSchema.parse({ v: 1, subject,
        checks: [{ checkId: 'http', kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
            config: { endpoint: 'https://production.example.test/health', expectStatus: 200 },
            periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 }] });
    const sourceFacts = readPluginUiExecutionOriginCandidates({ pluginId, projection: inputs.pluginUiProjection,
        members: [{ machineId, serverId: connection.serverId, serverIdentityId,
            projection: inputs.pluginUiProjection, phase: 'current', interactionEnabled: true }] });
    const disposeProjection = publishCommittedAppShellPluginUiProjection(() => inputs.pluginUiProjection,
        id => id === pluginId ? sourceFacts : null);
    const actionResponse = createDeferred<void>();
    const placementRefusal = { reason: 'machine_installation_replaced', requiredFact: 'installationId=previous',
        remedy: 'This Machine was reinstalled. Create a new Environment on its current installation and add the required secrets.' };
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)
            return actionResponse.promise.then(() => outcome === 'refused'
                ? { ok: false, code: 'credential_scope_denied', details: placementRefusal }
                : { ok: true, result: { v: 1, sourceInstanceId, sourceContractVersion: 1,
                    sourceConfig: HealthCheckSetupInputV1ProtocolSchema.parse(Reflect.get(Object(request.payload), 'input')),
                    displayLabel: 'Production Health', observationOnly: { kind: 'observationOnly' } } });
        return undefined;
    };
    const modal = vi.spyOn(Modal, 'show').mockImplementation(config => {
        expect(config.component).not.toBe(ActionInputFormModal);
        expect(config.props).toMatchObject({ launchInput: { observerMachineId: machineId, initialInput: { subject } } });
        return 'native-add-check';
    });
    const onSettled = vi.fn();
    type NativeSetup = NonNullable<React.ComponentProps<typeof PluginEventAutomationEditor>['newSourceSetup']>;
    const renderUnavailable = vi.fn<NativeSetup['renderUnavailable']>(() => null);
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        storage.getState().applyMachines([fresh.machineTarget.machine], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(lifetime.scope, [machineId]);
        const seed = subjectStarterEventSeed('addCheck', { subject: { ...subject, machineId }, controllerMachineId: machineId });
        if (!seed) throw new Error('Expected the Environment Add check seed');
        screen = await renderScreen(<PluginEventAutomationEditor automationId="new" clientId="add-check" value={null}
            seed={null} serverId={connection.serverId} authoringMachineId={machineId} onComplete={vi.fn()} onCancel={vi.fn()}
            newSourceSetup={{ seed, onSettled, renderUnavailable, waitingTitle: (_machine, phase) =>
                phase === 'applying' ? 'Saving this check' : 'Opening this check' }} />);
        await waitForHomeGovernance(() => expect(modal).toHaveBeenCalledTimes(1));
        expect(rpc.hostActions).toEqual([]);
        expect(onSettled).not.toHaveBeenCalled();
        const settle: unknown = Reflect.get(Object(modal.mock.calls[0]?.[0].props), 'onSettle');
        if (typeof settle !== 'function') throw new Error('Expected native setup settlement');
        await act(async () => { settle({ kind: 'submitted', input: setupInput }); });
        await waitForHomeGovernance(() => expect(rpc.hostActions).toHaveLength(1));
        expect(screen.getTextContent()).toContain('Saving this check');
        expect(onSettled).not.toHaveBeenCalled();
        await act(async () => { actionResponse.resolve(); });
        if (outcome === 'refused') {
            await waitForHomeGovernance(() => expect(renderUnavailable.mock.lastCall?.[2]).toMatchObject({
                reason: 'credential_scope_denied', requestId: expect.any(String), details: placementRefusal,
            }));
            expect(onSettled).not.toHaveBeenCalled();
            return;
        }
        await waitForHomeGovernance(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith({
            kind: 'configured',
            trigger: expect.objectContaining({ kind: 'pluginEvent', sourceInstanceId,
                observationTransport: expect.objectContaining({ watcherMaterializationRef: expect.objectContaining({ machineId }) }) }),
            observationOnly: { kind: 'observationOnly' },
        }));
        expect(rpc.hostActions).toHaveLength(1);
    } finally {
        actionResponse.resolve();
        await screen?.unmount();
        modal.mockRestore();
        disposeProjection();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
        disposeLoader();
    }
});

// PAGE-ACCEPT-176 R10-D1: Add check is one surface. Its Save writes one observation-only trigger; Cancel writes nothing.
it.each(['submitted', 'cancelled', 'switched'] as const)('Add check writes once on Save and nothing on Cancel (%s)', async (outcome) => {
    const { AddCheckSetup } = await import('@/components/projects/deployments/AddCheckSetup');
    const { Modal } = await import('@/modal');
    const { subjectStarterEventSeed } = await import('@/components/workflows/triggers/subjectTriggerStarters');
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'native-add-check';
    const serverIdentityId = 'srv_native_add_check';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const { createWorkflowAutomationHttpBoundary } = await import('@/dev/testkit/harness/workflowAutomationHttpBoundary');
    const workflows = createWorkflowAutomationHttpBoundary();
    const peerMachineId = 'eadc2422-b42b-478d-97b1-af9b530d5f09';
    let exactIntentRead: unknown;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://native-add-check.test',
        serverIdentityId, accountId, peerMachineId: outcome === 'switched' ? peerMachineId : undefined, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'] && exactIntentRead)
                return Response.json(exactIntentRead);
            if (path === '/v1/features' || path === '/v1/features/authenticated')
                return Response.json(createRootLayoutFeaturesResponse());
            return await workflows.handle(new URL(String(input)), init) ?? http.request(input, init);
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected Add check Account');
    const { machineId, pluginId, event, fresh, inputs, projection } = healthSetupFixture(
        connection.serverId, serverIdentityId, true, { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' },
    );
    const peer = outcome === 'switched'
        ? healthSetupFixture(connection.serverId, serverIdentityId, true,
            { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' }, PLUGIN_MANIFEST, peerMachineId)
        : null;
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error('Expected the Machine services manifest');
    const declarationDigestSha256: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
    const intentRead: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId, enabled: true, desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: [], revision: 'health-declaration' },
        release: null, uiArtifacts: [], packageAssets: [], currentDeclaration: null,
        machineDeclarations: [machineId, ...(peer ? [peer.machineId] : [])].map(id => ({
            machineId: id, machineInstallationId: 'health-installation', declaration: { declarationDigestSha256 },
        })),
    };
    exactIntentRead = { ...intentRead, declarationBodies: [{ declarationDigestSha256, manifest: admitted.manifest }] };
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: intentRead }],
    } });
    const subject = { kind: 'environment' as const, environmentId: 'production' };
    const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
    const setupInput = HealthCheckSetupInputV1ProtocolSchema.parse({ v: 1, subject,
        checks: [{ checkId: 'http', kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
            config: { endpoint: 'https://production.example.test/health', expectStatus: 200 },
            periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 }] });
    const sourceFacts = readPluginUiExecutionOriginCandidates({ pluginId, projection: inputs.pluginUiProjection,
        members: [{ machineId, inputs }, ...(peer ? [peer] : [])].map(member => ({
            machineId: member.machineId, serverId: connection.serverId, serverIdentityId,
            projection: member.inputs.pluginUiProjection, phase: 'current', interactionEnabled: true,
        })) });
    if (peer) expect(sourceFacts.sourceCandidates).toEqual(expect.arrayContaining([expect.objectContaining({
        source: expect.objectContaining({ origin: peer.fresh.origin }), validation: { kind: 'admitted' },
    })]));
    const disposeProjection = publishCommittedAppShellPluginUiProjection(() => inputs.pluginUiProjection,
        id => id === pluginId ? sourceFacts : null);
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const selected = peer?.machineId === request.machineId ? peer : { projection, event };
            return { protocolVersion: 1, projection: selected.projection, automationEligibleEvents: [selected.event] };
        }
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)
            return { ok: true, result: { v: 1, sourceInstanceId, sourceContractVersion: 1,
                sourceConfig: HealthCheckSetupInputV1ProtocolSchema.parse(Reflect.get(Object(request.payload), 'input')),
                displayLabel: 'Production Health', observationOnly: { kind: 'observationOnly' } } };
        return undefined;
    };
    const modal = vi.spyOn(Modal, 'show').mockImplementation(config => {
        expect(config.component).not.toBe(ActionInputFormModal);
        return 'native-add-check';
    });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        await publishMachineInventoryForTest(lifetime.scope,
            [fresh.machineTarget.machine, ...(peer ? [peer.fresh.machineTarget.machine] : [])]);
        const seed = subjectStarterEventSeed('addCheck', { subject: { ...subject, machineId }, controllerMachineId: machineId });
        if (!seed) throw new Error('Expected the Environment Add check seed');
        const onClose = vi.fn();
        screen = await renderScreen(<AddCheckSetup testID="add-check" lifetime={lifetime} seed={seed} onClose={onClose} />);
        await waitForHomeGovernance(() => expect(modal).toHaveBeenCalledTimes(1));
        expect(rpc.hostActions).toEqual([]);
        expect(modal.mock.calls[0]?.[0].props).toMatchObject({ launchInput: { observerMachineId: machineId, initialInput: { subject } } });
        if (peer) {
            const props = modal.mock.calls[0]?.[0].props;
            expect(props).toMatchObject({ watcherChoices: expect.arrayContaining([
                { machineId, selected: true }, { machineId: peer.machineId, selected: false },
            ]) });
            const chooseWatcher: unknown = Reflect.get(Object(props), 'chooseWatcher');
            if (typeof chooseWatcher !== 'function') throw new Error('Expected to switch the open native form');
            const draft = { check: { kind: 'http', endpoint: 'https://production.example.test/health', expectStatus: '20' } };
            await act(async () => { chooseWatcher(peer.machineId, draft); });
            await waitForHomeGovernance(() => expect(modal).toHaveBeenCalledTimes(2));
            expect(modal.mock.calls[1]?.[0].props).toMatchObject({
                watcherChoices: expect.arrayContaining([
                    { machineId, selected: false }, { machineId: peer.machineId, selected: true },
                ]),
                launchInput: { observerMachineId: peer.machineId, initialInput: { subject, rendererDraft: draft } },
            });
            expect(rpc.hostActions).toEqual([]);
            expect(workflows.creates).toEqual([]);
            expect(onClose).not.toHaveBeenCalled();
        }
        const settle: unknown = Reflect.get(Object(modal.mock.calls.at(-1)?.[0].props), 'onSettle');
        if (typeof settle !== 'function') throw new Error('Expected native setup settlement');
        await act(async () => { settle(outcome === 'cancelled' ? { kind: 'cancelled' } : { kind: 'completed', input: setupInput }); });
        await waitForHomeGovernance(() => expect(onClose).toHaveBeenCalledTimes(1));
        if (outcome === 'cancelled') {
            expect(rpc.hostActions).toEqual([]);
            expect(workflows.creates).toEqual([]);
        } else {
            expect(rpc.hostActions).toHaveLength(1);
            expect(workflows.creates).toHaveLength(1);
            expect([...workflows.rows.values()]).toEqual([expect.objectContaining({
                observationOnly: expect.objectContaining({ kind: 'observationOnly' }),
                triggers: [expect.objectContaining({ observation: expect.objectContaining({
                    watcher: expect.objectContaining({ machineId: peer?.machineId ?? machineId }),
                }) })],
            })]);
        }
    } finally {
        await screen?.unmount();
        modal.mockRestore();
        disposeProjection();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
        disposeLoader();
    }
});

// WF-EVENT-TRIGGER-1115: the workflow editor's Runs on Machine is the new Event's watcher, and a catalog that cannot offer
// an Event says why with a way forward instead of an empty picker.
it.each([
    { catalog: 'events' },
    { catalog: 'empty' },
    { catalog: 'noMachine' },
    { catalog: 'savedCheckFrom' },
] as const)('authors a new Event from the Runs on Machine (catalog=$catalog)', async ({ catalog }) => {
    const { InlinePluginEventEditor, PluginEventAutomationEditor } = await import('./PluginEventAutomationEditor');
    const { TriggerPluginEventRows } = await import('@/components/workflows/triggers/TriggerPluginEventRows');
    const { t } = await import('@/text');
    const accountId = `event-runs-on-${catalog}`;
    const serverIdentityId = `srv_event_runs_on_${catalog}`;
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: `https://event-runs-on-${catalog}.test`,
        serverIdentityId, accountId, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            return http.request(input, init);
        } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected Runs on Account');
    const { event, fresh, projection, inputs, machineId, pluginId } = catalog === 'savedCheckFrom'
        ? healthSetupFixture(connection.serverId, serverIdentityId, true,
            { eventId: HEALTH_CHECK_EVENT_REFS_V1.status.localId, actionId: 'health/setup' })
        : healthSetupFixture(connection.serverId, serverIdentityId);
    const sourceFacts = readPluginUiExecutionOriginCandidates({ pluginId, projection: inputs.pluginUiProjection,
        members: [{ machineId, serverId: connection.serverId, serverIdentityId,
            projection: inputs.pluginUiProjection, phase: 'current', interactionEnabled: true }] });
    const disposeProjection = publishCommittedAppShellPluginUiProjection(() => inputs.pluginUiProjection,
        id => id === pluginId ? sourceFacts : null);
    rpc.respond = request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? { protocolVersion: 1, projection, automationEligibleEvents: catalog === 'events' || catalog === 'savedCheckFrom' ? [event] : [] } : undefined;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        storage.getState().applyMachines([createMachineFixture({ ...fresh.machineTarget.machine, presenceProtocolVersion: 1,
            metadata: { host: 'Runs on studio', platform: 'linux', happyCliVersion: '0.3.0',
                happyHomeDir: '/home/runs-on', homeDir: '/home/runs-on' } })], true, { sourceServerId: connection.serverId });
        observeMachinePresenceForTest(lifetime.scope, [machineId]);
        if (catalog === 'savedCheckFrom') {
            const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
            const { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } = await import('@happier-dev/protocol/automations/automationTriggerIdentity');
            const onSettled = vi.fn();
            const subject = { kind: 'environment' as const, environmentId: 'production' };
            const sourceConfig = HealthCheckSetupInputV1ProtocolSchema.parse({ v: 1, subject,
                checks: [{ checkId: 'http', kind: { pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
                    config: { endpoint: 'https://production.example.test/health', expectStatus: 200 },
                    periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 }],
            });
            const triggerId = AutomationTriggerIdSchema.parse('262544ff-0dc8-4240-9462-89784070f591');
            screen = await renderScreen(<PluginEventAutomationEditor automationId="check" clientId={triggerId} value={null}
                seed={{ automationId: 'check', triggerId, expectedTriggerRevision: AutomationTriggerRevisionSchema.parse(1), enabled: true,
                    eventRef: event.event.identity, source: { v: 1, sourceInstanceId: createHealthCheckSourceInstanceIdV1(subject),
                        sourceContractVersion: 1, sourceConfig, displayLabel: 'Saved health checks' },
                    observation: { kind: 'checkpointedPull', watcherMaterializationRef: {
                        machineId, pluginId, materializationId: 'machine-services-observer',
                    } }, filter: null, maximumObservationAgeMs: null }} serverId={connection.serverId}
                authoringMachineId={machineId} savedSourceSetup={{ chooseWatcher: true, input: { selectedCheckId: 'http' },
                    onSettled, renderUnavailable: () => null }} onComplete={() => {}} onCancel={() => {}} />);
            await waitForHomeGovernance(() => {
                const proceed = screen!.findAllByType(RoundButton).find(button => button.props.title === t('common.continue'));
                expect(proceed?.props.disabled).toBe(false);
                expect(screen!.getTextContent()).toContain('Runs on studio');
            });
            expect(onSettled).not.toHaveBeenCalled();
            return;
        }
        screen = await renderScreen(<TriggerPluginEventRows testID="runs-on-trigger" when={{ kind: 'pluginEvent', value: null }}
            onChange={() => {}} machineId={catalog === 'noMachine' ? null : machineId} serverId={connection.serverId} editing />);
        const model = () => screen!.findByType(InlinePluginEventEditor).props.model;
        if (catalog === 'noMachine') {
            // No Machine means no catalog to read: the editor names the missing choice rather than an unreachable picker.
            expect(model().eventCatalogStatus).toBe('idle');
            expect(screen.getTextContent()).toContain(t('automations.form.trigger.eventCatalogNeedsMachine'));
            expect(screen.findAllHostsByTestId('automation-event-picker')).toHaveLength(0);
            return;
        }
        await waitForHomeGovernance(() => expect(model().eventCatalogStatus).toBe('ready'));
        if (catalog === 'empty') {
            expect(screen.getTextContent()).toContain(t('automations.form.trigger.noEventSourcesOnMachine', { machine: 'Runs on studio' }));
            expect(screen.findAllHostsByTestId('automation-event-picker')).toHaveLength(0);
            expect(screen.findAllHostsByTestId('automation-event-add-from-store')).not.toHaveLength(0);
            return;
        }
        await act(async () => { model().selectEvent(event); });
        // The person never opened the watcher picker: the Runs on Machine's installation is already chosen.
        await waitForHomeGovernance(() => expect(model().selectedWatcherOrigin, JSON.stringify({
            watcherCandidates: model().watcherCandidates, watcherFailures: model().watcherFailures,
        })).toMatchObject({ sourceRef: { machineId } }));
    } finally {
        await screen?.unmount();
        disposeProjection();
        clearDaemonMergedProjectionCacheForTests();
        connection.dispose();
    }
});

});
