import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    PluginEventAutomationSetupResultV1Schema,
    PluginMachineMaterializationV1Schema,
    PluginWebhookEndpointIdV1Schema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
} from '@happier-dev/protocol';

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createDeferred,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import type { PluginWebhookEndpointUiActionExecutor } from '@/sync/api/plugins/webhooks/endpointActions';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { PluginEventAutomationEditSeed } from './pluginEventAutomationEditSeed';
import { usePluginEventAutomationComposer } from './usePluginEventAutomationComposer';

const PLUGIN_ID = 'acme.github';
const EVENT_LOCAL_ID = 'events/repository';
const SETUP_ACTION_LOCAL_ID = 'setup/repository-source';
const WEBHOOK_LOCAL_ID = 'webhooks/repository';
const WEBHOOK_ENDPOINT_ID = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ';
const SOURCE_INSTANCE_ID = 'repository:42';
const SERVER_ID = 'server-a';
const SERVER_IDENTITY_ID = 'srv_account_a';
const WATCHER_MACHINE_ID = 'watcher-machine';
const MATERIALIZATION_ID = 'github-materialization-a';

type AccountLifetimeState = {
    value: ActiveServerAccountScopeLifetime | null;
};

const activeAccountLifetime = vi.hoisted((): AccountLifetimeState => ({ value: null }));
const endpointActionExecutor = vi.hoisted(() => vi.fn<PluginWebhookEndpointUiActionExecutor>());

vi.mock('@/sync/api/plugins/webhooks/endpointActions', () => ({
    createPluginWebhookEndpointHttpActionExecutor: () => endpointActionExecutor,
}));

vi.mock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
    loadDaemonMergedProjectionInputs: vi.fn(async () => null),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
}));

vi.mock('@/sync/domains/plugins/availability/projection', () => ({
    useActivePluginAccountAvailabilityReader: () => stableAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier: () => stableReleaseClassifier,
}));

vi.mock('@/sync/domains/machines/useMachineInventorySnapshots', () => ({
    useAllProfileMachineInventorySnapshots: () => stableMachineSnapshots,
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => stableSessionHydration,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({ sessions: {}, settings: {} }),
    },
    useSession: () => null,
    useSessionListIndexByServerId: () => stableSessionListIndexByServerId,
    useSessionListRowRenderablesForItems: () => stableSessionListRowRenderablesByKey,
    useSessions: () => stableSessions,
    useSettings: () => stableSettings,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionEncryptionKeyBase64ForResume: () => null,
    },
}));

function watcherMaterialization() {
    return PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: SERVER_IDENTITY_ID,
        machineId: WATCHER_MACHINE_ID,
        materializationId: MATERIALIZATION_ID,
        pluginId: PLUGIN_ID,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    });
}

const stableMaterialization = watcherMaterialization();
const stableMaterializationAdmission = Object.freeze({
    kind: 'available' as const,
    availabilityCursor: 1,
    materializations: Object.freeze([stableMaterialization]),
    snapshots: Object.freeze([]),
});
const stableAvailabilityReader = Object.freeze({
    readMaterializations: () => stableMaterializationAdmission,
});
const stableReleaseClassifier = (materialization: typeof stableMaterialization) => Object.freeze({
    serverIdentityId: materialization.serverIdentityId,
    materializationRef: Object.freeze({
        machineId: materialization.machineId,
        materializationId: materialization.materializationId,
        pluginId: materialization.pluginId,
    }),
    releaseContent: 'matched' as const,
    validation: Object.freeze({ kind: 'admitted' as const }),
});
const stableMachineSnapshots = Object.freeze([
    Object.freeze({
        kind: 'resolved' as const,
        profileId: SERVER_ID,
        serverIdentityId: SERVER_IDENTITY_ID,
        serverName: 'Server A',
        observation: 'live' as const,
        machines: Object.freeze([Object.freeze({
            id: WATCHER_MACHINE_ID,
            updatedAt: 1,
            active: true,
            activeAt: 0,
            metadataVersion: 1,
            metadata: null,
        })]),
    }),
]);
const stableSessionHydration = Object.freeze({ kind: 'available' as const, sessionId: '' });
const stableSessionListIndexByServerId = Object.freeze({});
const stableSessionListRowRenderablesByKey = Object.freeze({});
const stableSessions = Object.freeze([]);
const stableSettings = Object.freeze({});

function accountLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: SERVER_ID, accountId: 'account-a' }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose() {} }),
    });
}

function eligibleEvent(): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            immutableGenerationId: 'github-generation-a',
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
            immutableGenerationId: 'github-generation-a',
            title: 'Configure repository source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
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
        expectedTemplateVersion: 1,
        name: 'Repository triage',
        description: null,
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
        prompt: 'Review {{input}}',
        mentions: [],
        target: {
            kind: 'newSession',
            spawn: {
                executionTarget: { serverId: SERVER_ID, machineId: 'executor-machine' },
                directory: '/workspace/acme',
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
            },
        },
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
    endpointActionExecutor.mockResolvedValueOnce(endpointReadResult());
    const event = eligibleEvent();
    const inputs = projectionInputs(event);
    const seed = editSeed(event);
    const hook = await renderHook(
        (machineId: string) => usePluginEventAutomationComposer({
            machineId,
            serverId: SERVER_ID,
            projectionPhase: 'ready',
            projectionInputs: inputs,
            initialEditSeed: seed,
        }),
        { initialProps: 'composer-machine-a' },
    );

    await flushHookEffects({ cycles: 8, turns: 3 });
    expect(endpointActionExecutor).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent()).toMatchObject({
        sourceStatus: 'configured',
        webhookEndpoint: {
            webhookEndpointId: WEBHOOK_ENDPOINT_ID,
            readiness: 'providerConfirmationRequired',
        },
    });
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
    beforeEach(() => {
        activeAccountLifetime.value = accountLifetime();
        endpointActionExecutor.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        activeAccountLifetime.value = null;
    });

    it('releases an unresolved refresh latch when the setup scope rotates', async () => {
        const staleRead = createDeferred<unknown>();
        const hook = await configureSeededComposer();
        endpointActionExecutor.mockImplementationOnce(async () => await staleRead.promise);

        await refresh(hook);
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);

        await hook.rerender('composer-machine-b');

        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(false);
    });

    it('does not let stale A clear B or admit a duplicate current reread', async () => {
        const staleRead = createDeferred<unknown>();
        const currentRead = createDeferred<unknown>();
        const hook = await configureSeededComposer();
        endpointActionExecutor
            .mockImplementationOnce(async () => await staleRead.promise)
            .mockImplementationOnce(async () => await currentRead.promise);

        await refresh(hook);
        await hook.rerender('composer-machine-b');
        await refresh(hook);
        expect(endpointActionExecutor).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);

        staleRead.resolve(endpointReadResult());
        await flushHookEffects({ cycles: 4, turns: 3 });

        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(true);
        await refresh(hook);
        expect(endpointActionExecutor).toHaveBeenCalledTimes(3);

        currentRead.resolve(endpointReadResult('ready'));
        await flushHookEffects({ cycles: 4, turns: 3 });
        expect(hook.getCurrent().webhookEndpointRefreshing).toBe(false);
        expect(hook.getCurrent().webhookEndpoint?.readiness).toBe('ready');
    });
});
