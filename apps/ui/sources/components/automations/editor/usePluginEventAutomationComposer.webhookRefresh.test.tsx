import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    AutomationTriggerIdSchema,
    PluginEventAutomationSetupResultV1Schema,
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema,
    PluginWebhookEndpointIdV1Schema,
    getActionSpec,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

import type { PluginEventAutomationEditSeed } from './pluginEventAutomationEditSeed';

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
const { usePluginEventAutomationComposer } = await import('./usePluginEventAutomationComposer');
const endpointReadPath = getActionSpec('plugin.webhook.endpoint.read').serverTransport!.path;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreActionLoader: (() => void) | null = null;

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
                renderer: { kind: 'hostedWeb', contributionId: rendererLocalId },
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
        mergedProviderProjectionById: {},
        mergedBackendProjectionById: {},
        discoveredBackendIds: [],
        pluginProjectionById: {},
        pluginProjectionV2: null,
        automationEligibleEvents: [event],
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
    beforeEach(async () => {
        await harness.reset();
        await loadSyncSingletonForTests();
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        serverId = await harness.addHome({
            name: 'Webhook composer', serverUrl: SERVER_URL,
            serverIdentityId: SERVER_IDENTITY_ID, accountId: 'account-a',
        });
        connection = await restoreServerAccountForTest({ serverUrl: SERVER_URL, accountId: 'account-a' });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        const scope = { serverId: SERVER_IDENTITY_ID, accountId: 'account-a' };
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: 'account-a' }, isDataReady: true });
        storage.getState().applyMachines([createMachineFixture({ id: WATCHER_MACHINE_ID })], true, { sourceServerId: serverId });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1,
            intentReads: [{ pluginId: PLUGIN_ID, response: availabilityResponse }],
            materializations: [stableMaterialization],
            snapshots: [{ serverIdentityId: SERVER_IDENTITY_ID, machineId: WATCHER_MACHINE_ID, materializations: [stableMaterialization] }],
        } });
    });

    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = null;
        restoreActionLoader?.();
        restoreActionLoader = null;
        const { clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        clearPluginAccountAvailabilityProjection();
        await harness.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(storage.getInitialState(), true);
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
