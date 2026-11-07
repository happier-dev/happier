// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { TextInput } from 'react-native';
import { PluginProjectionV2Schema, DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { PluginUiHostApiRequestEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { HealthCheckSetupInputV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AutomationPluginEventTriggerProjectionSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DeploymentReceiptEventSetupV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { ActionInputFormModal } from '@/components/plugins/actions/ActionInputFormModal';
import type { ActionInputForm, ActionInputFormSubmissionResult } from '@/components/plugins/actions/actionInputForm';
import { changeTextTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import { configurePluginEventAutomationSetup } from './pluginEventAutomationSetup';
import { readPluginEventAutomationWatcherFailure } from './pluginEventAutomationObservationBinding';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-services/src/manifest';
import { renderSurface } from '@happier-dev/plugins-machine-services/happier-plugin-ui/health-setup';
import { createPluginEventAutomationSetupSurfaceBinding } from './presentPluginEventAutomationSetupSurface';

type SetupForm = ActionInputForm<ActionInputFormSubmissionResult, string, string>;

vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
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
    method: string; payload: unknown;
}>) => unknown) }));
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

afterEach(standardCleanup);
afterEach(() => { rpc.respond = undefined; });
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

describe('configures a prebound guided deployment and bound health starters', () => {

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

it.each([false, true])('configures a prebound guided deployment only when its controller declares the Event (declared=%s)', async (declared) => {
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { PluginEventAutomationEditor, InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
    const { TriggerPluginEventRows } = await import('@/components/workflows/triggers/TriggerPluginEventRows');
    const { GuidedAutomationSetup } = await import('@/components/workflows/triggers/GuidedAutomationSetup');
    const { Item } = await import('@/components/ui/lists/Item');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { pressTestInstanceAsync } = await import('@/dev/testkit/render/renderScreen');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'deployment-guided-preset';
    const serverIdentityId = 'srv_deployment_guided';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://deployment-guided.test',
        serverIdentityId, accountId, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
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
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
            availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId, enabled: true, desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: [], revision: 'guided-declaration' },
            release: null, uiArtifacts: [], packageAssets: [],
            currentDeclaration: null,
            machineDeclarations: [{ machineId, machineInstallationId: 'guided-installation', declaration: {
                declarationDigestSha256: `sha256:${'d'.repeat(64)}`,
                manifest: { ...admitted.manifest, contributes: { ...admitted.manifest.contributes,
                    events: declared ? admitted.manifest.contributes.events : [] } } } }],
        } }],
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
    rpc.respond = request => {
        requestedMethods.push(request.method);
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
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
        screen = await renderScreen(<SubjectTriggersSection subject={{ kind: 'environment',
            environmentId: setupInput.environmentId, machineId: 'runtime-machine' }} subjectName="Production"
            controllerMachineId={machineId} deploymentSourceName="Application checkout"
            deploymentEnvironment={{ serverId: connection.serverId, projectSourceId: 'source-checkout',
                environmentId: setupInput.environmentId }} />);
        await waitForHomeGovernance(() => expect(screen!.findByTestId('subject-triggers-starter:deploymentFailed')).not.toBeNull());
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === 'subject-triggers-starter:deploymentFailed'));
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === 'guided-automation-configure-event'));
        const editor = screen.findByType(PluginEventAutomationEditor);
        expect(editor.props.authoringMachineId).toBe(machineId);
        expect(editor.props.initialSetupSeed).toMatchObject({ eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed,
            monitoringMachineId: machineId, setupInput });
        expect(screen.findAllHostsByTestId('automation-event-watcher-picker')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('automation-event-picker')).toHaveLength(0);
        expect(screen.findAllByType(TextInput)).toHaveLength(0);
        if (!declared) {
            await waitForHomeGovernance(() => expect(screen!.findByType(InlinePluginEventEditor).props.model.eventCatalogStatus).toBe('ready'));
            const model = screen.findByType(InlinePluginEventEditor).props.model;
            expect.soft(model.watcherCandidates).toEqual([]);
            expect.soft(model.selectedWatcherOrigin).toBeNull();
            expect(submitted).toEqual([]);
            return;
        }
        setupResponse.resolve();
        await waitForHomeGovernance(() => {
            const model = screen!.findAllByType(InlinePluginEventEditor)[0]?.props.model;
            expect(submitted, JSON.stringify({ requestedMethods, eventCatalogStatus: model?.eventCatalogStatus,
                sourceStatus: model?.sourceStatus, sourceFailure: model?.sourceFailure,
                selectedEvent: model?.selectedEvent?.event.identity, selectedWatcherOrigin: model?.selectedWatcherOrigin,
                watcherCandidates: model?.watcherCandidates, watcherFailures: model?.watcherFailures })).toEqual([setupInput]);
        });
        await waitForHomeGovernance(() => expect(screen!.findAllByType(PluginEventAutomationEditor)).toHaveLength(0));
        expect(screen.findByType(TriggerPluginEventRows).props.when).toMatchObject({ kind: 'pluginEvent', value: {
            eventRef: event.event.identity, sourceConfig: expect.objectContaining(setupInput),
            filter: null, maximumObservationAgeMs: null,
            observationTransport: expect.objectContaining({ kind: 'checkpointedPull',
                watcherMaterializationRef: expect.objectContaining({ machineId }) }),
        } });
        expect(screen.findByType(GuidedAutomationSetup).props).toMatchObject({ deploymentEnvironment: {
            serverId: connection.serverId, environmentId: setupInput.environmentId } });
        const press = (id: string) => pressTestInstanceAsync(screen!.findAllByType(RoundButton).find(row => row.props.testID === id));
        await press('guided-automation-next');
        await press('guided-automation-next');
        await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === 'guided-automation-then:apply'));
        await press('guided-automation-next');
        await press('guided-automation-next');
        expect(screen.findByTestId('guided-automation-read-back')).toBeTruthy();
        const readBack = screen.getTextContent();
        for (const fact of [event.event.title, 'Production', 'Application checkout', 'Controller studio',
            'workflows.triggers.guided.profile.applySafeName', 'workflows.triggers.guided.tellInbox']) expect(readBack).toContain(fact);
        for (const id of [setupInput.environmentId, connection.serverId, machineId, 'source-checkout',
            'deployment-production-failed']) expect(readBack).not.toContain(id);
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
    contribution = { eventId: 'health-check-failed', actionId: 'health/setup' }) {
    // Source publication admits authored bytes before they can become eligible Events.
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(admitted.ok, admitted.ok ? undefined : JSON.stringify(admitted.diagnostics)).toBe(true);
    if (!admitted.ok) throw new Error('Health manifest admission failed');
    const pluginId = PLUGIN_MANIFEST.id;
    const machineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
    const sourceCustody = { kind: 'development', registeredRootId: 'machine-services-source' } as const;
    const origin = { serverIdentityId, sourceRef: { machineId, pluginId, sourceCustody } };
    const occurrenceId = 'machine-services-current';
    const action = admitted.manifest.contributes.actions?.find(row => row.id === contribution.actionId);
    const declaration = admitted.manifest.contributes.events?.find(row => row.id === contribution.eventId);
    if (!action || declaration?.kind !== 'event' || !declaration.automation) throw new Error('Missing health setup declaration');
    const setupRenderer = declaration.automation.source.setupSurface?.renderer;
    const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: { id: `${pluginId}/${declaration.id}`, identity: { pluginId, localId: declaration.id },
            occurrenceId, sourceCustody,
            title: typeof declaration.title === 'string' ? declaration.title : declaration.title.fallback,
            localizedPresentation: { title: declaration.title }, description: null,
            payloadSchema: declaration.payloadSchema, automation: declaration.automation },
        setupAction: { id: `${pluginId}/${action.id}`, identity: { pluginId, localId: action.id },
            occurrenceId, title: action.title, description: null, inputSchema: action.inputSchema, inputHints: action.inputHints ?? null },
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
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: PLUGIN_MANIFEST.displayName,
            version: PLUGIN_MANIFEST.version, enabled: true, source: { kind: 'path', locator: '/sources/machine-services' },
            occurrenceId, sourceCustody, executionOrigin: origin } },
        actionsById: { [event.setupAction.id]: { id: action.id, pluginId, occurrenceId, title: action.title,
            execution: action.execution, scopes: action.scopes, surfaces: action.surfaces, inputHints: action.inputHints,
            dangerLevel: action.dangerLevel, available: true, placementBindings: [], priority: 0 } },
    });
    const inputs = publishDaemonMergedProjectionInputs({ projection, automationEligibleEvents: [event] });
    const source = { origin, occurrenceId, version: PLUGIN_MANIFEST.version, serverId };
    const fresh: FreshPluginMachineExecutionOriginV1 = { origin, source,
        machineTarget: { kind: 'resolved', target: { serverIdentityId, machineId }, serverId,
            profile: { id: serverId, name: 'Health setup', serverUrl: 'https://health.test', serverIdentityId,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1 }, machine: createMachineFixture({ id: machineId }) },
    };
    return { inputs, projection, event, fresh, source, machineId, pluginId };
}

describe('carries the Environment health starter and Machine-service health starter subjects into Add check', () => {
it.each([
    { label: 'Environment Settings Add check', starter: 'environmentSettingsAddCheck', triggerSubject: { kind: 'environment', environmentId: 'environment-production', machineId: 'deployment-machine' },
        subject: { kind: 'environment', environmentId: 'environment-production' } },
    { label: 'Environment', starter: 'healthFailed', triggerSubject: { kind: 'environment', environmentId: 'environment-production', machineId: 'deployment-machine' },
        subject: { kind: 'environment', environmentId: 'environment-production' } },
    { label: 'Machine-service', starter: 'healthFailed', triggerSubject: { kind: 'service', machineId: 'service-machine', serviceId: 'service-production' },
        subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'service-production' } },
    // Add a check opens the New trigger editor straight at the service's bound Health form (O-MACH 11-07).
    { label: 'Machine-service Add a check', starter: 'addCheck', triggerSubject: { kind: 'service', machineId: 'service-machine', serviceId: 'service-production' },
        subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'service-production' } },
] as const)('$label through the rendered Event editor and native Health form', async ({ starter, triggerSubject, subject }) => {
    const { SubjectTriggersSection } = await import('@/components/workflows/triggers/SubjectTriggersSection');
    const { Item } = await import('@/components/ui/lists/Item');
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
            if (path === '/v3/automations' || path === '/v3/automations/query') return Response.json({ automations: [], nextCursor: null });
            return http.request(input, init);
        } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected Environment starter Account');
    const { machineId, pluginId, event, fresh, projection } = healthSetupFixture(connection.serverId, serverIdentityId, true);
    const submitted: unknown[] = [];
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
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
            const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
            const { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
            const { createDeploymentReadTransport } = await import('@/components/projects/deployments/deploymentReadTransport');
            const { createDeploymentActions } = await import('@/components/projects/deployments/deploymentActions');
            const { ItemList } = await import('@/components/ui/lists/ItemList');
            const controller = createDeploymentReadControllerV1({ scope: { ...accountLifetime.scope, projectSourceId: 'source-production' },
                transport: createDeploymentReadTransport(accountLifetime) });
            retireController = () => controller.retire();
            const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
                serverId: connection.serverId, id: triggerSubject.environmentId, controllerMachineId: machineId,
                projectSourceId: 'source-production',
            }) });
            screen = await renderScreen(<ItemList><DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
                lifetime={accountLifetime} demand={{ mounted: false, visible: false, focused: false }}
                machineName={id => id} environmentTitle={() => null}
                editing={{ actions: createDeploymentActions(accountLifetime, 'source-production'), serverId: connection.serverId,
                    review: { pendingId: null, request: () => {}, open: () => {} }, onChanged: () => {} }} /></ItemList>);
            await pressTestInstanceAsync(screen.findAllByType(SectionActionButton)
                .find(row => row.props.testID === 'project-deployments.environment.settings.checks-alerts.add'));
        } else {
            screen = await renderScreen(<SubjectTriggersSection {...subjectPageProps} />);
            await waitForHomeGovernance(() => expect(screen!.findByTestId(`subject-triggers-starter:${starter}`)).not.toBeNull());
            await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === `subject-triggers-starter:${starter}`));
        }
        if (starter === 'healthFailed') {
            await pressTestInstanceAsync(screen.findAllByType(Item).find(row => row.props.testID === 'guided-automation-configure-event'));
        }
        const editor = screen.findByType(PluginEventAutomationEditor);
        expect(editor).not.toBeNull();
        const initialSetupSeed: React.ComponentProps<typeof PluginEventAutomationEditor>['initialSetupSeed'] = editor.props.initialSetupSeed;
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
                        handlers: { settleEphemeralInput: async ({ settlement }) => {
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
            expect(editor.props.authoringMachineId).toBeNull();
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
    const dispatch = vi.fn(async () => ({ ok: false as const, reason: 'contributed_action_unavailable' as const }));
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
        expect(form.getFields().map(field => field.path)).toEqual(['subject', 'checks']);
        const controls = () => screen.findAllByType(TextInput);
        expect(controls()).toHaveLength(2);
        expect(dispatch).not.toHaveBeenCalled();
        const subject = { kind: 'machineService', machineId, serviceId: 'systemd:qa-health' };
        const checks = [{ checkId: 'tcp', kind: { pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
            config: { host: '127.0.0.1', port: 8080 }, periodMs: 300000, consecutiveFailuresBeforeAlerting: 1 }];
        await act(async () => { changeTextTestInstance(controls()[0], JSON.stringify(subject)); });
        await act(async () => { changeTextTestInstance(controls()[1], JSON.stringify(checks)); });
        const sourceConfig = { v: 1, subject, checks };
        expect(form.getInput()).toEqual(sourceConfig);
        await act(async () => {
            expect(await form.submit()).toMatchObject({ kind: 'settled', outcome: { ok: true } });
        });
        await setup;
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: event.setupAction.identity, input: sourceConfig }));
    } finally { form.cancel(); await setup; }
});

it.each(['configured', 'refused'] as const)('submits the native Health setup through the real store and Action dispatcher (%s)', async result => {
    const accountId = `health-native-${result}`;
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const connection = await restoreServerAccountForTest({ serverUrl: `https://health-${result}.test`,
        serverIdentityId: `srv_health_${result}`, accountId, request: http.request });
    const { storage } = await import('@/sync/domains/state/storage');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { loadDaemonMergedProjectionInputs, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected restored Health Account lifetime');
    const fixture = healthSetupFixture(connection.serverId, `srv_health_${result}`, true);
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
    const actionRequests: unknown[] = [];
    const settlementErrors: unknown[] = [];
    const remediation = { kind: 'openSettings' as const, path: '/settings/machines' };
    rpc.respond = request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { protocolVersion: 1, projection, automationEligibleEvents: [event] };
        }
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return undefined;
        actionRequests.push(request.payload);
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
            initialSetupSeed: { eventRef: event.event.identity, monitoringMachineId: machineId, setupInput: existing },
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
                        handlers: { settleEphemeralInput: async ({ settlement }) => {
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
        expect(submitted).toEqual([]);
        await changeEndpoint('http://127.0.0.1:8080');
        expect(document.querySelector('[data-testid="health-setup-loopback-refused"]')).not.toBeNull();
        expect((await mounted.getByRole('button', { name: 'Add check' })).state?.disabled).toBe(true);
        expect(submitted).toEqual([]);
        await changeEndpoint('https://added-health.test');
        expect(document.querySelector('[data-testid="health-setup-loopback-refused"]')).toBeNull();
        expect((await mounted.getByRole('button', { name: 'Add check' })).state?.disabled ?? false).toBe(false);
        await act(async () => { await mounted!.press(await mounted!.getByRole('button', { name: 'Add check' })); });
        expect(settlementErrors).toEqual([]);
        await Promise.race([
            waitForHomeGovernance(() => expect(submitted).toHaveLength(1)),
            setup.then(outcome => { expect(submitted, JSON.stringify(outcome)).toHaveLength(1); }),
        ]);
        const outcome = await setup;
        expect(submitted).toHaveLength(1);
        expect(actionRequests).toEqual([expect.objectContaining({ machineId, qualifiedActionId: event.setupAction.id,
            expectedContributorOccurrenceId: event.setupAction.occurrenceId, executionSurface: 'ui' })]);
        const input = HealthCheckSetupInputV1ProtocolSchema.parse(submitted[0]);
        expect(input.subject).toEqual(subject);
        expect(input.checks).toHaveLength(existing.checks.length + 1);
        expect(input.checks.slice(0, existing.checks.length)).toEqual(existing.checks);
        expect(input.checks.at(-1)).toMatchObject({ checkId: 'http-2', kind: { pluginId, localId: 'http' },
            config: { endpoint: 'https://added-health.test', expectStatus: 200 } });
        if (result === 'configured') expect(outcome.kind).toBe('configured');
        else expect(outcome).toEqual({ kind: 'unavailable', code: 'health_check_loopback_refused',
            reason: 'health_check_loopback_refused', retryable: false, remediation });
    } finally {
        operation.abort();
        await setup;
        await mounted?.dispose();
        clearDaemonMergedProjectionCacheForTests();
        await connection.dispose();
    }
});

});
