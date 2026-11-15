import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    PluginProjectionV2Schema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import {
    PluginEventAutomationSetupResultV1Schema} from '@happier-dev/protocol/automations/event-setup-result';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema} from '@happier-dev/protocol/plugins/availability/v1';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import {
    PluginWebhookEndpointIdV1Schema} from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import {
    getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';

const PLUGIN_ID = 'acme.github';
const EVENT_LOCAL_ID = 'events/repository';
const SETUP_ACTION_LOCAL_ID = 'setup/repository-source';
const WEBHOOK_LOCAL_ID = 'webhooks/repository';
const WEBHOOK_ENDPOINT_ID = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ';
const SOURCE_INSTANCE_ID = 'repository:42';
let serverId: string;
const SERVER_URL = 'https://webhook-composer.test';
const SERVER_IDENTITY_ID = 'srv_account_a';
const WATCHER_MACHINE_ID = 'watcher-machine';
const MATERIALIZATION_ID = 'github-materialization-a';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
// The portal is a native boundary; the pushed Event page and its composer stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { getPluginExecutionOriginCandidateOrigin, isPluginMachineExecutionOriginCandidateSelectable } = await import('@/sync/domains/machines/administration/pluginExecutionOrigin');
const { usePluginEventAutomationComposer } = await import('./usePluginEventAutomationComposer');
const endpointReadPath = getActionSpec('plugin.webhook.endpoint.read').serverTransport!.path;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreActionLoader: (() => void) | null = null;
const editorProjectionReads: string[] = [];

// The machine RPC transport is a process boundary; catalog/cache/hook/editor logic stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    return { machineRpcWithServerScope: async (request: Readonly<{ method: string; machineId: string }>) => {
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { ok: false, code: 'method_not_found' };
        }
        editorProjectionReads.push(request.machineId);
        return { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 0 }),
            automationEligibleEvents: [eligibleEvent()] };
    } };
});

function endpointReads() {
    return harness.requestsFor(endpointReadPath);
}

function watcherMaterialization() {
    return PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: SERVER_IDENTITY_ID,
        machineId: WATCHER_MACHINE_ID,
        materializationId: MATERIALIZATION_ID,
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    });
}

const stableMaterialization = watcherMaterialization();
const availabilityResponse = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
    availabilityCursor: 1,
    hostingCapability: { enabled: false },
    intent: {
        pluginId: PLUGIN_ID, desiredVersion: '1.0.0', enabled: true,
        offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1',
    },
    release: {
        ref: { pluginId: PLUGIN_ID, version: '1.0.0' },
        archiveDigestSha256: stableMaterialization.archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2, id: PLUGIN_ID, version: '1.0.0', displayName: 'GitHub',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {},
        },
        collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
    },
    packageAssets: [], uiArtifacts: [],
});

function eligibleEvent(): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            occurrenceId: 'github-generation-a',
            sourceCustody: { kind: 'development', registeredRootId: 'github-root-a' },
            title: 'Repository updates',
            description: null,
            payloadSchema: {
                type: 'object',
                properties: { eventId: { type: 'string' } },
                required: ['eventId'],
                additionalProperties: false,
            },
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 3,
                    supportedObservationTransports: ['checkpointedPull', 'durablePush'],
                    sourceConfigSchema: {
                        type: 'object',
                        properties: { repositoryId: { type: 'string', minLength: 1 } },
                        required: ['repositoryId'],
                        additionalProperties: false,
                    },
                    setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                    webhookContributionRef: { pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID },
                },
            },
        },
        setupAction: {
            id: `${PLUGIN_ID}/${SETUP_ACTION_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
            occurrenceId: 'github-generation-a',
            title: 'Configure repository source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
    });
}

function eligibleEventWithSetupSurface(
    projectionGeneration: number,
    rendererLocalId: string,
): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    const event = eligibleEvent();
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        ...event,
        event: {
            ...event.event,
            automation: {
                ...event.event.automation,
                source: {
                    ...event.event.automation.source,
                    setupSurface: { renderer: rendererLocalId },
                },
            },
        },
        setupSurface: {
            contribution: event.event.identity,
            occurrenceId: event.event.occurrenceId,
            projectionGeneration,
            rendererChain: [{ pluginId: PLUGIN_ID, localId: rendererLocalId }],
            selectedRenderer: {
                identity: { pluginId: PLUGIN_ID, localId: rendererLocalId },
                renderer: { kind: 'hostedWeb', contributionId: rendererLocalId,
                    source: { kind: 'artifact', artifact: rendererLocalId }, requiredHostMethods: [] },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: {
                serverIdentityId: SERVER_IDENTITY_ID,
                materializationRef: {
                    machineId: WATCHER_MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                    pluginId: PLUGIN_ID,
                },
            },
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: {
                    pluginId: PLUGIN_ID,
                    occurrenceId: event.event.occurrenceId,
                    sourceCustody: event.event.sourceCustody,
                },
                points: [],
            },
        },
    });
}

function projectionInputs(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): DaemonMergedProjectionInputs {
    return {
        ...publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({ v: 2, generation: 0 }), automationEligibleEvents: [event] }),
        pluginProjectionV2: null,
        registryDiagnostics: [],
    };
}

function editSeed(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): PluginEventAutomationEditSeed {
    const source = PluginEventAutomationSetupResultV1Schema.parse({
        v: 1,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        sourceContractVersion: 3,
        sourceConfig: { repositoryId: '42' },
        displayLabel: 'acme/widgets',
    });
    return {
        automationId: 'automation-event-1',
        triggerId: AutomationTriggerIdSchema.parse('trigger-event-1'),
        expectedTriggerRevision: 4,
        enabled: true,
        eventRef: event.event.identity,
        source,
        observation: {
            kind: 'durablePush',
            webhookEndpointId: PluginWebhookEndpointIdV1Schema.parse(WEBHOOK_ENDPOINT_ID),
            webhookRoutingSourceInstanceId: SOURCE_INSTANCE_ID,
        },
        filter: null,
        maximumObservationAgeMs: null,
    };
}

function endpointReadResult(readiness: 'providerConfirmationRequired' | 'ready' = 'providerConfirmationRequired') {
    return {
        webhookEndpointId: WEBHOOK_ENDPOINT_ID,
        revision: 3,
        contribution: { pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID },
        targetMaterialization: {
            machineId: WATCHER_MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: PLUGIN_ID,
        },
        sourceInstanceId: SOURCE_INSTANCE_ID,
        routing: 'accountEndpoint',
        readiness,
        publicUrl: 'https://example.test/v1/plugins/webhooks/opaque-route',
        createdAt: 1_700_000_000_000,
    };
}

async function configureSeededComposer() {
    harness.answer(serverId, endpointReadPath, { body: endpointReadResult() });
    const event = eligibleEvent();
    const inputs = projectionInputs(event);
    const seed = editSeed(event);
    const hook = await renderHook(
        (machineId: string) => usePluginEventAutomationComposer({
            machineId,
            serverId,
            projectionPhase: 'ready',
            projectionInputs: inputs,
            initialEditSeed: seed,
        }),
        { initialProps: 'composer-machine-a' },
    );

    await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({
        seededObservationMachineId: WATCHER_MACHINE_ID,
        sourceStatus: 'configured',
        sourceFailure: null,
        webhookEndpoint: {
            webhookEndpointId: WEBHOOK_ENDPOINT_ID,
            readiness: 'providerConfirmationRequired',
        },
    }));
    expect(endpointReads()).toHaveLength(1);
    expect(hook.getCurrent().refreshWebhookEndpoint).not.toBeNull();
    return hook;
}

async function refresh(hook: Awaited<ReturnType<typeof configureSeededComposer>>) {
    await act(async () => {
        hook.getCurrent().refreshWebhookEndpoint?.();
        await Promise.resolve();
    });
}

describe('usePluginEventAutomationComposer webhook refresh', () => {
    it('publishes the original private edit input through the pushed Event page before newer draft values', async () => {
        const { TriggerPopover } = await import('@/components/workflows/triggers/TriggerPopover');
        const { InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult() });
        const event = eligibleEvent();
        const seed = { ...editSeed(event), maximumObservationAgeMs: 120_000 };
        const loaded: AutomationTriggerDefinitionInput[] = [];
        const screen = await renderScreen(<TriggerPopover testID="loaded-private-event" anchorRef={React.createRef()}
            onRequestClose={() => {}} whenKinds={['pluginEvent']} sessionId={null} showThen={false}
            initial={{ when: { kind: 'pluginEvent', value: null, eventRef: seed.eventRef }, enabled: true,
                then: { kind: 'runWorkflow', ref: 'workflow-1', inputs: {} } }}
            workflowOptions={[]} machineId={WATCHER_MACHINE_ID} serverId={serverId}
            eventEdit={{ automationId: seed.automationId, triggerId: seed.triggerId }} initialEventEditSeed={seed}
            onEditSeedApplied={(trigger) => { loaded.push(trigger); }} onSubmit={async () => {}} />);
        await screen.pressByTestIdAsync('loaded-private-event-configure-event');
        const model = () => screen.findByType(InlinePluginEventEditor).props.model as ReturnType<typeof usePluginEventAutomationComposer>;
        await waitForHomeGovernance(() => expect(model().sourceStatus).toBe('configured'));
        expect(loaded).toMatchObject([{ kind: 'pluginEvent', sourceConfig: seed.source.sourceConfig,
            maximumObservationAgeMs: 120_000, observationTransport: { kind: 'durablePush', webhookEndpointId: WEBHOOK_ENDPOINT_ID } }]);
        await act(async () => model().setMaximumObservationAgeMsText('120001'));
        expect(model().createDraft?.draft.maximumObservationAgeMs).toBe(120_001);
        expect(loaded).toMatchObject([{ maximumObservationAgeMs: 120_000 }]);
        expect(endpointReads()).toHaveLength(1);
    });

    it('preserves pending plugin availability until the Event catalog answers', async () => {
        const event = eligibleEvent();
        const inputs = publishDaemonMergedProjectionInputs({
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { [PLUGIN_ID]: {
                    id: PLUGIN_ID, displayName: 'GitHub', version: '1.0.0', enabled: true,
                    source: { kind: 'path', locator: '/sources/github' },
                    occurrenceId: event.event.occurrenceId, sourceCustody: event.event.sourceCustody,
                } },
            }),
            automationEligibleEvents: [event],
        });
        const hook = await renderHook((phase: 'loading' | 'ready' | 'error') => usePluginEventAutomationComposer({
            machineId: WATCHER_MACHINE_ID, serverId, projectionPhase: phase,
            projectionInputs: phase === 'ready' ? inputs : null,
            initialEventRef: event.event.identity,
        }), { initialProps: 'loading' as 'loading' | 'ready' | 'error' });
        expect(hook.getCurrent().getPluginPresentation(event).availability).toBe('loading');
        await hook.rerender('ready');
        await waitForHomeGovernance(() => expect(hook.getCurrent().getPluginPresentation(event).availability).toBe('available'));
        await act(async () => hook.getCurrent().selectEvent(event));
        await hook.rerender('loading');
        expect(hook.getCurrent().selectedEvent?.event.identity).toEqual(event.event.identity);
        expect(hook.getCurrent().sourceStatus).not.toBe('unavailable');
        expect(hook.getCurrent().getPluginPresentation(event).availability).toBe('loading');
        await hook.rerender('error');
        expect(hook.getCurrent().getPluginPresentation(event).availability).toBe('unavailable');
    });

    beforeEach(async () => {
        editorProjectionReads.length = 0;
        await harness.reset();
        await loadSyncSingletonForTests();
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        serverId = await harness.addHome({
            name: 'Webhook composer', serverUrl: SERVER_URL,
            serverIdentityId: SERVER_IDENTITY_ID, accountId: 'account-a',
        });
        harness.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: WATCHER_MACHINE_ID, accountId: 'account-a' })] });
        // Authentication starts the real Availability queue. Answer its initial
        // reads before connecting, rather than leaving recovery in flight while
        // this suite publishes its editor-specific projection below.
        harness.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
            body: { availabilityCursor: 1, inventoryComplete: true, snapshots: [{ serverIdentityId: SERVER_IDENTITY_ID,
                machineId: WATCHER_MACHINE_ID, materializations: [stableMaterialization] }] },
        });
        harness.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
            body: { availabilityCursor: 1, pluginIds: [PLUGIN_ID], failedPluginIds: [],
                intentReads: [{ pluginId: PLUGIN_ID, response: availabilityResponse }] },
        });
        connection = await restoreServerAccountForTest({ serverUrl: SERVER_URL, serverIdentityId: SERVER_IDENTITY_ID,
            accountId: 'account-a', request: harness.request, configureSocket: configureConnectedServerSocketBoundary });
        const { storage } = await import('@/sync/domains/state/storage');
        const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        const scope = { serverId: connection.serverId, accountId: 'account-a' };
        await waitForHomeGovernance(() => {
            expect(storage.getState().profileScope).toEqual(scope);
            expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
        });
        // This suite owns webhook rereads, not background bootstrap scheduling.
        // Load its inventory through the same public Sync owner as a foreground refresh.
        const { sync } = await import('@/sync/sync');
        await sync.refreshMachines({ serverId: connection.serverId });
        await sync.refreshPluginAccountAvailability();
        await waitForHomeGovernance(() => expect(storage.getState().machines[WATCHER_MACHINE_ID]?.active).toBe(true));
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1,
            intentReads: [{ pluginId: PLUGIN_ID, response: availabilityResponse }],
            materializations: [stableMaterialization],
            snapshots: [{ serverIdentityId: SERVER_IDENTITY_ID, machineId: WATCHER_MACHINE_ID, materializations: [stableMaterialization] }],
        } });
    });

    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = null;
        restoreActionLoader?.();
        restoreActionLoader = null;
        const { clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        clearPluginAccountAvailabilityProjection();
        await harness.reset();
    });

    it.each([false, true])('offers and preselects only the Environment controller declaring the guided Event (declared=%s)', async (declared) => {
        const { sync } = await import('@/sync/sync');
        const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'github-root-a' };
        const executionOrigin = { serverIdentityId: SERVER_IDENTITY_ID,
            sourceRef: { machineId: WATCHER_MACHINE_ID, pluginId: PLUGIN_ID, sourceCustody } };
        const event = { ...eligibleEvent(), observationBinding: { executionOrigin,
            materializationRef: { machineId: WATCHER_MACHINE_ID, pluginId: PLUGIN_ID, materializationId: MATERIALIZATION_ID } } };
        const machines = [WATCHER_MACHINE_ID, 'another-environment-controller'];
        harness.answer(serverId, '/v1/machines', { body: machines.map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })) });
        await sync.refreshMachines({ serverId });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !availabilityResponse.release) throw new Error('Expected the connected Account release');
        const { createPluginEventAutomationSetupResultV1JsonSchema } = await import('@happier-dev/protocol/automations/event-setup-result');
        const { ingestPluginManifestV2 } = await import('@happier-dev/protocol/plugins/manifest');
        const contributions = (includesEvent: boolean) => ({
            actions: [{ id: SETUP_ACTION_LOCAL_ID, title: 'Configure repository source', scopes: ['global'],
                surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
                inputSchema: event.setupAction.inputSchema,
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(3, event.event.automation.source.sourceConfigSchema) }],
            webhooks: [{ id: WEBHOOK_LOCAL_ID, title: 'Repository delivery',
                verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' }, delivery: 'recordReceiptOnly' }],
            events: includesEvent ? [{ kind: 'event', id: EVENT_LOCAL_ID, title: event.event.title,
                payloadSchema: event.event.payloadSchema, automation: event.event.automation }] : [],
        });
        const admitted = ingestPluginManifestV2({ ...availabilityResponse.release.normalizedManifest, contributes: contributions(true) });
        expect(admitted.ok && admitted.manifest.contributes.events?.some(row => row.id === EVENT_LOCAL_ID)).toBe(true);
        // Bodies are content-addressed: one digest per distinct declaration.
        const digestFor = (includesEvent: boolean) => `sha256:${(includesEvent ? 'c' : 'e').repeat(64)}`;
        const censusResponse = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...availabilityResponse,
            currentDeclaration: null,
            intent: { ...availabilityResponse.intent, desiredVersion: null },
            machineDeclarations: machines.map(machineId => ({ machineId, machineInstallationId: 'test-installation',
                declaration: { declarationDigestSha256: digestFor(machineId === WATCHER_MACHINE_ID ? declared : !declared) } })),
            release: { ...availabilityResponse.release, normalizedManifest: {
                ...availabilityResponse.release.normalizedManifest,
                contributes: contributions(declared),
            } },
        });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...censusResponse,
            declarationBodies: [true, false].map(includesEvent => ({ declarationDigestSha256: digestFor(includesEvent),
                manifest: { ...availabilityResponse.release!.normalizedManifest, contributes: contributions(includesEvent) } })) });
        const exactPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'];
        harness.answer(serverId, exactPath, { body: response });
        harness.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
            body: { availabilityCursor: 2, pluginIds: [PLUGIN_ID], failedPluginIds: [],
                intentReads: [{ pluginId: PLUGIN_ID, response: censusResponse }] },
        });
        harness.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
            body: { availabilityCursor: 2, inventoryComplete: true, snapshots: [] },
        });
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 2, intentReads: [{ pluginId: PLUGIN_ID, response: censusResponse }], materializations: [], snapshots: [],
        } });
        const members = machines.map(machineId => {
            const origin = { ...executionOrigin, sourceRef: { ...executionOrigin.sourceRef, machineId } };
            const projection = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { [PLUGIN_ID]: { id: PLUGIN_ID, displayName: 'GitHub', version: '1.0.0', enabled: true,
                    source: { kind: 'path', locator: '/sources/github' }, occurrenceId: event.event.occurrenceId,
                    sourceCustody, executionOrigin: origin } },
            }) });
            return { machineId, serverId, serverIdentityId: SERVER_IDENTITY_ID,
                projection: projection.pluginUiProjection, phase: 'current' as const, interactionEnabled: true };
        });
        const sourceFacts = readPluginUiExecutionOriginCandidates({ pluginId: PLUGIN_ID, projection: members[0]!.projection, members });
        const disposeProjection = publishCommittedAppShellPluginUiProjection(() => members[0]!.projection,
            pluginId => pluginId === PLUGIN_ID ? sourceFacts : null);
        try {
            const inputs = projectionInputs(event);
            const { useActivePluginAccountAvailabilityReader } = await import('@/sync/domains/plugins/availability/projection');
            const reader = await renderHook(() => useActivePluginAccountAvailabilityReader());
            expect(reader.getCurrent()?.readCurrentAutomationEventContribution({ pluginId: PLUGIN_ID,
                version: '1.0.0', eventLocalId: EVENT_LOCAL_ID, sourceContractVersion: 3,
                machineId: WATCHER_MACHINE_ID, machineInstallationId: 'test-installation' })).toBeNull();
            const exactReadsBeforeMount = harness.requestsFor(exactPath).length;
            const hook = await renderHook(() => usePluginEventAutomationComposer({ machineId: WATCHER_MACHINE_ID, serverId,
                projectionPhase: 'ready', projectionInputs: inputs, initialEventRef: event.event.identity,
                guidedPreset: true, initialSetupSeed: { eventRef: event.event.identity, monitoringMachineId: WATCHER_MACHINE_ID,
                    setupInput: { v: 1, serverId, environmentId: 'production-environment' } },
            }));
            await flushHookEffects();
            await waitForHomeGovernance(() => expect(harness.requestsFor(exactPath)).toHaveLength(exactReadsBeforeMount + 1));
            await waitForHomeGovernance(() => expect(reader.getCurrent()?.readCurrentAutomationEventContribution({ pluginId: PLUGIN_ID,
                version: '1.0.0', eventLocalId: EVENT_LOCAL_ID, sourceContractVersion: 3,
                machineId: WATCHER_MACHINE_ID, machineInstallationId: 'test-installation' }) != null).toBe(declared));
            const machineIdFor = (origin: NonNullable<ReturnType<typeof hook.getCurrent>['selectedWatcherOrigin']>) =>
                'materializationRef' in origin ? origin.materializationRef.machineId : origin.sourceRef.machineId;
            expect.soft(hook.getCurrent().watcherCandidates.map(candidate => machineIdFor(getPluginExecutionOriginCandidateOrigin(candidate))))
                .toEqual(declared ? [WATCHER_MACHINE_ID] : []);
            const selected = hook.getCurrent().selectedWatcherOrigin;
            expect(selected && machineIdFor(selected)).toBe(declared ? WATCHER_MACHINE_ID : null);
        } finally { disposeProjection(); }
    });

    it.each(['sentry', 'posthog'] as const)('admits the real %s source through shared watcher selection without a portable release', async (provider) => {
        const { PLUGIN_MANIFEST: declared } = provider === 'sentry'
            ? await import('../../../../../../packages/plugins/sentry/src/manifest')
            : await import('../../../../../../packages/plugins/posthog/src/manifest');
        // Hosts consume the admitted manifest, not the cold emitted declaration facts.
        const { ingestPluginManifestV2 } = await import('@happier-dev/protocol/plugins/manifest');
        const admittedManifest = ingestPluginManifestV2(declared);
        if (!admittedManifest.ok) throw new Error('Expected the admitted source manifest');
        const manifest = admittedManifest.manifest;
        const declaration = manifest.contributes.events?.filter(row => row.kind === 'event').find(row => row.automation?.eligible);
        if (!declaration?.automation) throw new Error('Expected the real source Event declaration');
        const pluginId = manifest.id;
        const sourceCustody = { kind: 'development' as const, registeredRootId: `${pluginId}-root` };
        const executionOrigin = { serverIdentityId: SERVER_IDENTITY_ID,
            sourceRef: { machineId: WATCHER_MACHINE_ID, pluginId, sourceCustody } };
        const materializationRef = { machineId: WATCHER_MACHINE_ID, pluginId, materializationId: `${pluginId}-observer` };
        const sourceProjection = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: manifest.version,
                enabled: true, source: { kind: 'path', locator: `/sources/${pluginId}` }, occurrenceId: 'source-occurrence-a', sourceCustody, executionOrigin } },
        }) });
        const facts = readPluginUiExecutionOriginCandidates({ pluginId, projection: sourceProjection.pluginUiProjection,
            members: [{ machineId: WATCHER_MACHINE_ID, serverId, serverIdentityId: SERVER_IDENTITY_ID,
                projection: sourceProjection.pluginUiProjection, phase: 'current', interactionEnabled: true }] });
        const dispose = publishCommittedAppShellPluginUiProjection(() => sourceProjection.pluginUiProjection,
            id => id === pluginId ? facts : null);
        try {
            const setupRef: unknown = declaration.automation.source.setupActionRef;
            const { PluginContributionIdentityV1Schema } = await import('@happier-dev/protocol/plugins/contribution-identity');
            const qualifiedSetupRef = PluginContributionIdentityV1Schema.safeParse(setupRef);
            const setupLocalId = typeof setupRef === 'string' ? setupRef : qualifiedSetupRef.success ? qualifiedSetupRef.data.localId : null;
            if (!setupLocalId) throw new Error('Expected declared setup Action');
            const setupAction = manifest.contributes.actions?.find(row => row.id === setupLocalId);
            if (!setupAction?.inputSchema) throw new Error('Expected the real source setup Action input schema');
            const { normalizePluginActionInputHintsV2 } = await import('@happier-dev/protocol/plugins/actions/v2');
            const source = declaration.automation.source;
            const fixture = eligibleEvent();
            const event = { ...fixture,
                event: { ...fixture.event, id: `${pluginId}/${declaration.id}`, identity: { pluginId, localId: declaration.id },
                    occurrenceId: 'source-occurrence-a', sourceCustody, payloadSchema: declaration.payloadSchema,
                    automation: { v: 1 as const, eligible: true as const, source: {
                        sourceContractVersion: source.sourceContractVersion,
                        supportedObservationTransports: source.supportedObservationTransports,
                        sourceConfigSchema: source.sourceConfigSchema,
                        setupActionRef: { pluginId, localId: setupLocalId },
                    } } },
                setupAction: { ...fixture.setupAction, id: `${pluginId}/${setupLocalId}`, identity: { pluginId, localId: setupLocalId },
                    occurrenceId: 'source-occurrence-a', inputSchema: setupAction.inputSchema,
                    inputHints: normalizePluginActionInputHintsV2(setupAction.inputHints, setupAction.inputSchema) ?? null },
                observationBinding: { executionOrigin, materializationRef },
            } satisfies DaemonContributionRegistryProjectionAutomationEligibleEventV1 & { observationBinding: unknown };
            const inputs = { ...sourceProjection, automationEligibleEvents: [event] };
            const hook = await renderHook((projectionInputs: DaemonMergedProjectionInputs | null) => usePluginEventAutomationComposer({
                machineId: projectionInputs ? WATCHER_MACHINE_ID : null, serverId,
                projectionInputs, projectionPhase: projectionInputs ? 'ready' : 'idle', initialEventRef: event.event.identity,
            }), { initialProps: null as DaemonMergedProjectionInputs | null });
            expect(hook.getCurrent().watcherCandidates).toHaveLength(1);
            const candidate = hook.getCurrent().watcherCandidates[0]!;
            expect(isPluginMachineExecutionOriginCandidateSelectable(candidate)).toBe(true);
            expect(getPluginExecutionOriginCandidateOrigin(candidate)).toEqual(executionOrigin);
            await act(async () => hook.getCurrent().selectWatcher(candidate));
            expect(hook.getCurrent().selectedWatcherOrigin).toEqual(executionOrigin);
            await hook.rerender(inputs);
            await waitForHomeGovernance(() => expect(hook.getCurrent().selectedEvent?.event.identity).toEqual(event.event.identity));
            expect(hook.getCurrent().watcherCandidates[0]?.validation).toEqual({ kind: 'admitted' });
            expect(hook.getCurrent().sourceStatus).toBe('idle');
        } finally { dispose(); }
    });

    it.each([
        { name: 'one other admitted observer still requires a choice', others: ['observer-c'], expected: null },
        { name: 'one other admitted observer before its Event catalog loads still requires a choice', others: ['observer-c'], catalogPending: true, expected: null },
        { name: 'several other admitted observers require a choice', others: ['observer-c', 'observer-d'], expected: null },
        { name: 'the service Machine when it is the only admitted observer still requires a choice', others: [], expected: null },
        { name: 'an explicit service-Machine choice despite another observer', others: ['observer-c'], explicit: WATCHER_MACHINE_ID, expected: WATCHER_MACHINE_ID },
        { name: 'an unavailable explicit observer without relocation', others: ['observer-c'], explicit: 'retired-observer', expected: null },
    ])('keeps observer selection independent of a watched-service subject: $name', async ({ others, explicit, expected, catalogPending }) => {
        const { sync } = await import('@/sync/sync');
        const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        const machines = [WATCHER_MACHINE_ID, ...others];
        harness.answer(serverId, '/v1/machines', { body: machines.map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' })) });
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('Expected the connected Account scope');
        await sync.refreshMachines({ serverId: scope.serverId });
        const materializations = machines.map((machineId, index) => ({ ...stableMaterialization, machineId,
            materializationId: `${MATERIALIZATION_ID}-${index}` }));
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 2, intentReads: [{ pluginId: PLUGIN_ID, response: { ...availabilityResponse, availabilityCursor: 2 } }], materializations,
            snapshots: materializations.map(materialization => ({ serverIdentityId: SERVER_IDENTITY_ID,
                machineId: materialization.machineId, materializations: [materialization] })),
        } });
        expect(readPluginAccountAvailability(scope).readMaterializations()).toMatchObject({ kind: 'available', materializations });
        const event = eligibleEvent();
        const hook = await renderHook((inputs: DaemonMergedProjectionInputs | null) => usePluginEventAutomationComposer({ machineId: inputs ? WATCHER_MACHINE_ID : null, serverId,
            projectionPhase: inputs ? 'ready' : 'idle', projectionInputs: inputs, initialEventRef: event.event.identity,
            initialSetupSeed: { eventRef: event.event.identity, ...(explicit ? { monitoringMachineId: explicit } : {}),
                setupInput: { subject: { kind: 'machineService', machineId: WATCHER_MACHINE_ID, serviceId: 'watched-service' } } },
        }), { initialProps: catalogPending ? null : projectionInputs(event) });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().watcherCandidates).toHaveLength(machines.length);
            expect(hook.getCurrent().watcherFailures).toEqual([]);
            if (!catalogPending) expect(hook.getCurrent().selectedEvent?.event.identity).toEqual(event.event.identity);
        });
        await flushHookEffects();
        const origin = hook.getCurrent().selectedWatcherOrigin;
        expect(origin ? ('materializationRef' in origin ? origin.materializationRef.machineId : origin.sourceRef.machineId) : null).toBe(expected);
        expect(hook.getCurrent().sourceStatus).toBe('idle');
        expect(hook.getCurrent().createDraft).toBeNull();
        expect(endpointReads()).toHaveLength(0);
        expect(editorProjectionReads).toHaveLength(0);
        if (catalogPending) {
            await hook.rerender(projectionInputs(event));
            await waitForHomeGovernance(() => expect(hook.getCurrent().selectedEvent?.event.identity).toEqual(event.event.identity));
            expect(hook.getCurrent().selectedWatcherOrigin).toEqual(origin);
        }
        if (!explicit) {
            const serviceCandidate = hook.getCurrent().watcherCandidates.find(candidate => {
                const current = getPluginExecutionOriginCandidateOrigin(candidate);
                return ('materializationRef' in current ? current.materializationRef.machineId : current.sourceRef.machineId) === WATCHER_MACHINE_ID;
            });
            if (!serviceCandidate) throw new Error('Expected the admitted service Machine');
            await act(async () => hook.getCurrent().selectWatcher(serviceCandidate));
            await hook.rerender();
            expect(hook.getCurrent().selectedWatcherOrigin).toEqual(getPluginExecutionOriginCandidateOrigin(serviceCandidate));
        }
    });

    it('bootstraps an unseeded Event only from an explicit current watcher choice', async () => {
        const event = eligibleEvent();
        const seed = { eventRef: event.event.identity, setupInput: { repository: 'acme/widgets' } };
        const hook = await renderHook((phase: DaemonMergedProjectionPhase) => usePluginEventAutomationComposer({
            machineId: phase === 'idle' ? null : WATCHER_MACHINE_ID, serverId,
            projectionPhase: phase, projectionInputs: phase === 'ready' ? projectionInputs(event) : null,
            initialEventRef: event.event.identity, initialSetupSeed: seed,
        }), { initialProps: 'idle' });
        expect(hook.getCurrent().eventCatalogStatus).toBe('idle');
        expect(hook.getCurrent().watcherCandidates).toHaveLength(1);
        expect(hook.getCurrent().selectedWatcherOrigin).toBeNull();
        expect(hook.getCurrent().selectedEvent).toBeNull();
        expect(hook.getCurrent().createDraft).toBeNull();
        const candidate = hook.getCurrent().watcherCandidates[0]!;
        await act(async () => hook.getCurrent().selectWatcher({ ...candidate,
            ...('materialization' in candidate ? { materialization: { ...candidate.materialization, materializationId: 'retired-materialization' } } : {}) }));
        expect(hook.getCurrent().selectedWatcherOrigin).toBeNull();
        await act(async () => hook.getCurrent().selectWatcher(hook.getCurrent().watcherCandidates[0]!));
        expect(hook.getCurrent().selectedWatcherOrigin).toMatchObject({ materializationRef: { machineId: WATCHER_MACHINE_ID } });
        await hook.rerender('loading');
        expect(hook.getCurrent().eventCatalogStatus).toBe('loading');
        await hook.rerender('error');
        expect(hook.getCurrent().eventCatalogStatus).toBe('unavailable');
        expect(hook.getCurrent().createDraft).toBeNull();
        await hook.rerender('ready');
        await waitForHomeGovernance(() => expect(hook.getCurrent().selectedEvent?.event.identity).toEqual(event.event.identity));
        expect(hook.getCurrent().eventCatalogStatus).toBe('ready');
        expect(hook.getCurrent().selectedWatcherOrigin).toMatchObject({ materializationRef: { machineId: WATCHER_MACHINE_ID } });
        expect(hook.getCurrent().sourceStatus).toBe('idle');
        expect(hook.getCurrent().createDraft).toBeNull();
        expect(endpointReads()).toHaveLength(0);
    });

    it('loads the real editor catalog only after its pending Event watcher is explicitly selected', async () => {
        const { PluginEventAutomationEditor, InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
        const event = eligibleEvent();
        const hook = await renderHook(() => null, { wrapper: ({ children }) => <>{children}
            <PluginEventAutomationEditor automationId="new" clientId="event-row" value={null} seed={null}
                initialSetupSeed={{ eventRef: event.event.identity, setupInput: { repository: 'acme/widgets' } }}
                authoringMachineId={null} serverId={serverId} onComplete={() => { throw new Error('must not enroll'); }} onCancel={() => {}} />
        </> });
        const model = () => hook.tree.root.findByType(InlinePluginEventEditor).props.model as ReturnType<typeof usePluginEventAutomationComposer>;
        expect(model().eventCatalogStatus).toBe('idle');
        expect(model().selectedEvent).toBeNull();
        expect(editorProjectionReads).toEqual([]);
        await act(async () => model().selectWatcher(model().watcherCandidates[0]!));
        await flushHookEffects();
        expect(editorProjectionReads).toEqual([WATCHER_MACHINE_ID]);
        await waitForHomeGovernance(() => expect(model().selectedEvent?.event.identity).toEqual(event.event.identity));
        expect(model().selectedWatcherOrigin).toMatchObject({ materializationRef: { machineId: WATCHER_MACHINE_ID } });
        expect(model().sourceStatus).toBe('idle');
        expect(model().createDraft).toBeNull();
        expect(endpointReads()).toHaveLength(0);
    });

    it('does not borrow the trigger Project Machine for repository-only Event intent', async () => {
        const { TriggerPluginEventRows } = await import('@/components/workflows/triggers/TriggerPluginEventRows');
        const { InlinePluginEventEditor } = await import('./PluginEventAutomationEditor');
        const event = eligibleEvent();
        const hook = await renderHook(() => null, { wrapper: ({ children }) => <>{children}
            <TriggerPluginEventRows testID="event-row" editing when={{ kind: 'pluginEvent', value: null, eventRef: event.event.identity }}
                initialEventSeed={{ eventRef: event.event.identity, setupInput: { repository: 'acme/widgets' } }}
                machineId="unrelated-project-machine" serverId={serverId} onChange={() => { throw new Error('must not enroll'); }} />
        </> });
        const model = () => hook.tree.root.findByType(InlinePluginEventEditor).props.model as ReturnType<typeof usePluginEventAutomationComposer>;
        expect(editorProjectionReads).toEqual([]);
        expect(model().selectedEvent).toBeNull();
        expect(model().selectedWatcherOrigin).toBeNull();
        await act(async () => model().selectWatcher(model().watcherCandidates[0]!));
        await flushHookEffects();
        expect(editorProjectionReads).toEqual([WATCHER_MACHINE_ID]);
        await waitForHomeGovernance(() => expect(model().selectedEvent?.event.identity).toEqual(event.event.identity));
        expect(model().sourceStatus).toBe('idle');
        expect(model().createDraft).toBeNull();
    });

    it('releases an unresolved refresh latch when the setup scope rotates', async () => {
        const staleRead = createDeferred<void>();
        const hook = await configureSeededComposer();
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult(), respondAfter: staleRead.promise });

        await refresh(hook);
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);

        await hook.rerender('composer-machine-b');

        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(false);
        staleRead.resolve();
    });

    it('refreshes shared watcher selection when its current observer binding first becomes available', async () => {
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult() });
        const original = eligibleEvent();
        const seed = editSeed(original);
        const replacement = { ...original, observationBinding: {
            executionOrigin: { serverIdentityId: SERVER_IDENTITY_ID, materializationRef: {
                machineId: WATCHER_MACHINE_ID, pluginId: PLUGIN_ID, materializationId: MATERIALIZATION_ID } },
            materializationRef: { machineId: WATCHER_MACHINE_ID, pluginId: PLUGIN_ID, materializationId: MATERIALIZATION_ID },
        } };
        const hook = await renderHook((event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => usePluginEventAutomationComposer({
            machineId: WATCHER_MACHINE_ID, serverId, projectionPhase: 'ready', projectionInputs: projectionInputs(event), initialEditSeed: seed,
        }), { initialProps: original });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sourceStatus).toBe('configured'));
        await hook.rerender(replacement);
        await flushHookEffects();
        expect(hook.getCurrent().selectedEvent?.observationBinding).toEqual(replacement.observationBinding);
    });

    it('retires and replaces a selected custom setup presentation when only its renderer projection changes', async () => {
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult() });
        const original = eligibleEventWithSetupSurface(17, 'repository-picker-native');
        const replacement = eligibleEventWithSetupSurface(18, 'repository-picker-hosted');
        const seed = editSeed(original);
        const hook = await renderHook(
            (event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => (
                usePluginEventAutomationComposer({
                    machineId: 'composer-machine-a',
                    serverId,
                    projectionPhase: 'ready',
                    projectionInputs: projectionInputs(event),
                    initialEditSeed: seed,
                })
            ),
            { initialProps: original },
        );
        await waitForHomeGovernance(() => expect(hook.getCurrent().selectedEvent?.setupSurface?.selectedRenderer.identity.localId)
            .toBe('repository-picker-native'));

        await hook.rerender(replacement);
        await flushHookEffects({ cycles: 4, turns: 3 });

        expect(hook.getCurrent().selectedEvent?.setupSurface).toMatchObject({
            projectionGeneration: 18,
            selectedRenderer: {
                identity: { pluginId: PLUGIN_ID, localId: 'repository-picker-hosted' },
            },
        });
    });

    it('does not let stale A clear B or admit a duplicate current reread', async () => {
        const staleRead = createDeferred<void>();
        const currentRead = createDeferred<void>();
        const hook = await configureSeededComposer();
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult(), respondAfter: staleRead.promise });

        await refresh(hook);
        await waitForHomeGovernance(() => expect(endpointReads()).toHaveLength(2));
        await hook.rerender('composer-machine-b');
        harness.answer(serverId, endpointReadPath, { body: endpointReadResult('ready'), respondAfter: currentRead.promise });
        await refresh(hook);
        await waitForHomeGovernance(() => expect(endpointReads()).toHaveLength(3));
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);

        staleRead.resolve();
        await flushHookEffects({ cycles: 4, turns: 3 });

        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);
        await refresh(hook);
        await flushHookEffects({ cycles: 4, turns: 3 });
        expect(endpointReads()).toHaveLength(3);

        currentRead.resolve();
        await waitForHomeGovernance(() => expect(hook.getCurrent().webhookEndpoint?.readiness).toBe('ready'));
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(false);
        expect(hook.getCurrent().webhookEndpoint?.readiness).toBe('ready');
    });
});
