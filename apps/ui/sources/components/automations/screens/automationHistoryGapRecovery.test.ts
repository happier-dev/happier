import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    AutomationDefinitionListItemSchema,
    AutomationDefinitionListResponseSchema,
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginActionSchemasReadRequestSchema,
    DaemonPluginActionSchemasReadResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginMachineMaterializationV1Schema,
    type AutomationDefinitionListItem,
    type AutomationEventSourceStatusV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type DaemonPluginStructuredMessageActionExecuteRequest,
    type DaemonPluginStructuredMessageActionExecuteResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { resolveFreshPluginMachineExecutionOrigin } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { composePluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { applyPluginAccountAvailabilityProjectionRefresh, clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createActivePluginAccountAvailabilityProjectionHydrator } from '@/sync/api/plugins/availability/pluginAvailabilityProjection';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    type AutomationDefinition,
    isPluginEventAutomationTrigger,
    type PluginEventAutomationTrigger,
} from '@/sync/domains/automations/automationTypes';

import { installAutomationScreensCommonModuleMocks } from './automationScreensTestHelpers';

import {
    readAutomationHistoryGapRecoveryStatus,
    readAutomationHistoryGapRecoveryEligibleEvent,
    recoverAutomationHistoryGap,
} from './automationHistoryGapRecovery';

const AUTOMATION_ID = 'automation-a';
const TRIGGER_ID = AutomationTriggerIdSchema.parse('trigger-event-a');
const TRIGGER_REVISION = 4;
const OTHER_TRIGGER_ID = AutomationTriggerIdSchema.parse('trigger-event-b');
const PLUGIN_ID = 'acme.github';
const EVENT_LOCAL_ID = 'events/repository';
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse('11111111-1111-4111-8111-111111111111');
const ACTION_LOCAL_ID = 'automations/reset-history-gap';
const MACHINE_ID = 'watcher-machine';
const SERVER_URL = 'https://history-gap.test';
const ACCOUNT_ID = 'account-a';
let SERVER_ID: string;
const SERVER_IDENTITY_ID = 'srv_account_a';
const MATERIALIZATION_ID = 'github-materialization';
const GENERATION = 17;

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let ACCOUNT_LIFETIME: ActiveServerAccountScopeLifetime;
let rpcEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
let rpcProjection: ReturnType<typeof projectionResponse>;
let actionResult: DaemonPluginStructuredMessageActionExecuteResponse;
const actionRequests: DaemonPluginStructuredMessageActionExecuteRequest[] = [];
const AUTOMATIONS_PATH = '/v3/automations?limit=100';

installAutomationScreensCommonModuleMocks({
    storage: async (importOriginal) => await importOriginal(),
    text: {
        translate: (key: string) => ({
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryTitle': 'History gap needs attention',
            'settingsPlugins.eventAutomationComposer.historyGapRecoverySubtitle': 'Reset the source baseline to resume observing new Events.',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryUnavailable': 'The source recovery action is not available on its current watcher.',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureTitle': 'Source recovery needs another try',
            'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureBody': 'The recovery was not confirmed. The source still needs attention.',
            'common.retry': 'Retry',
        }[key] ?? key),
    },
});

// Only the external Socket.IO ACK is substituted. Account admission, codecs,
// exact Action selection, policy, and the contributed-action dispatcher stay real.
const rpcRequests = installSessionActionRpcBoundary((request) => {
    const prefix = `${MACHINE_ID}:`;
    if (!request.method.startsWith(prefix)) throw new Error('History recovery RPC reached a different Machine');
    const method = request.method.slice(prefix.length);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return rpcProjection;
    if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
        const input = DaemonPluginActionSchemasReadRequestSchema.parse(request.params);
        const action = [rpcEvent.setupAction, rpcEvent.historyGapResetAction]
            .find((candidate) => candidate?.id === input.qualifiedActionId);
        return DaemonPluginActionSchemasReadResponseSchema.parse(action
            ? { ok: true, inputSchema: action.inputSchema }
            : { ok: false, code: 'plugin_action_schemas_unavailable' });
    }
    if (method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
        actionRequests.push(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.params));
        return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(actionResult);
    }
    throw new Error(`Unexpected history recovery RPC: ${method}`);
});

function eventSourceStatus(
    input: Partial<AutomationEventSourceStatusV1> = {},
): AutomationEventSourceStatusV1 {
    return {
        automationId: AUTOMATION_ID,
        triggerId: TRIGGER_ID,
        triggerRevision: TRIGGER_REVISION,
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceSelectorId: SOURCE_SELECTOR_ID,
        reporterMaterializationRef: {
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: PLUGIN_ID,
        },
        reporterSourceCustody: { kind: 'managed', immutableGenerationId: 'github-occurrence-a', installSource: 'archive' },
        state: 'attention',
        code: 'historyGap',
        lastObservedAt: 10,
        lastDispositionAt: 10,
        nextRetryAt: null,
        observedCount: 0,
        admittedCount: 0,
        skippedCount: 0,
        revision: 4,
        ...input,
    };
}

function eventTrigger(
    input: Partial<PluginEventAutomationTrigger> = {},
): PluginEventAutomationTrigger {
    const id = input.id ?? TRIGGER_ID;
    const revision = input.revision ?? TRIGGER_REVISION;
    const sourceSelectorId = input.sourceSelectorId ?? SOURCE_SELECTOR_ID;
    return {
        id,
        revision,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'pluginEvent',
        eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceSelectorId,
        sourceContractVersion: 1,
        observation: { kind: 'checkpointedPull', watcher: null },
        sourceStatus: eventSourceStatus({
            triggerId: id,
            triggerRevision: revision,
            sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(sourceSelectorId),
        }),
        sourceCatalogStatus: null,
        ...input,
    };
}

function automation(input: Partial<AutomationDefinitionListItem> = {}): AutomationDefinitionListItem {
    const parsed = AutomationDefinitionListItemSchema.parse({
        id: AUTOMATION_ID,
        name: 'Repository triage',
        description: null,
        enabled: true,
        targetType: 'newSession',
        existingSessionId: null,
        templateVersion: 3,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 1,
        assignments: [],
        triggers: [eventTrigger()],
        ...input,
    });
    return parsed;
}

function automationForScreen(
    input: Partial<AutomationDefinitionListItem> = {},
): AutomationDefinition {
    const summary = automation(input);
    return {
        ...summary,
        detail: { kind: 'unloaded', templateVersion: summary.templateVersion },
        linkedExistingSessionId: null,
    };
}

function readEventTrigger(
    value: AutomationDefinitionListItem,
    triggerId = TRIGGER_ID,
): PluginEventAutomationTrigger {
    const trigger = value.triggers.find((candidate) => candidate.id === triggerId);
    if (!isPluginEventAutomationTrigger(trigger)) throw new Error(`expected plugin Event trigger ${triggerId}`);
    return trigger;
}

function eligibleEvent(
    occurrenceId = 'github-occurrence-a',
): DaemonContributionRegistryProjectionAutomationEligibleEventV1 {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            occurrenceId,
            sourceCustody: { kind: 'managed', immutableGenerationId: occurrenceId, installSource: 'archive' },
            title: 'Repository updates',
            description: null,
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: { type: 'object', additionalProperties: false },
                    setupActionRef: { pluginId: PLUGIN_ID, localId: 'automations/setup' },
                    historyGapResetActionRef: { pluginId: PLUGIN_ID, localId: ACTION_LOCAL_ID },
                },
            },
        },
        setupAction: {
            id: `${PLUGIN_ID}/automations/setup`,
            identity: { pluginId: PLUGIN_ID, localId: 'automations/setup' },
            occurrenceId,
            title: 'Configure source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
        historyGapResetAction: {
            id: `${PLUGIN_ID}/${ACTION_LOCAL_ID}`,
            identity: { pluginId: PLUGIN_ID, localId: ACTION_LOCAL_ID },
            occurrenceId,
            title: 'Reset source baseline',
            description: null,
            inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
            inputHints: null,
        },
    });
}

function projectionResponse(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
) {
    const action = event.historyGapResetAction;
    if (!action) throw new Error('expected recovery Action');
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: {
            v: 2,
            generation: GENERATION,
            installedPackagesById: { [PLUGIN_ID]: {
                id: PLUGIN_ID, displayName: 'Acme GitHub', version: '1.0.0', enabled: true,
                source: { kind: 'archive', locator: `sha256:${'a'.repeat(64)}` },
                immutableGenerationId: event.event.occurrenceId,
                occurrenceId: event.event.occurrenceId, sourceCustody: event.event.sourceCustody,
                executionOrigin: { serverIdentityId: SERVER_IDENTITY_ID,
                    materializationRef: { machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID, pluginId: PLUGIN_ID } },
            } },
            agentsById: {},
            actionsById: {
                [`${PLUGIN_ID}/${action.identity.localId}`]: {
                    id: action.identity.localId,
                    pluginId: PLUGIN_ID,
                    occurrenceId: action.occurrenceId,
                    title: action.title,
                    scopes: ['settings'],
                    surfaces: ['ui', 'plugin'],
                    execution: { target: 'daemon' },
                    executionOrigin: { serverIdentityId: SERVER_IDENTITY_ID,
                        materializationRef: { machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID, pluginId: PLUGIN_ID } },
                    placementBindings: [],
                    priority: 0,
                    dangerLevel: 'safe',
                    available: true,
                },
            },


            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        },
        automationEligibleEvents: [event],
    });
}

async function projectionInputs(event: DaemonContributionRegistryProjectionAutomationEligibleEventV1): Promise<DaemonMergedProjectionInputs | null> {
    rpcEvent = event;
    rpcProjection = projectionResponse(event);
    return await loadDaemonMergedProjectionInputs({ machineId: MACHINE_ID, serverId: SERVER_ID, staleMs: 0 });
}

function materialization() {
    return PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: SERVER_IDENTITY_ID,
        machineId: MACHINE_ID,
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

function executionOrigin(): FreshPluginMachineExecutionOriginV1 | null {
    const reader = readPluginAccountAvailability(ACCOUNT_LIFETIME.scope);
    return resolveFreshPluginMachineExecutionOrigin({ pluginId: PLUGIN_ID,
        origin: composePluginMachineExecutionOriginV1(materialization()), reader, classifyRelease: reader.classifyRelease });
}

await loadSyncSingletonForTests();
await import('./AutomationHistoryGapRecoveryAction');
const { sync } = await import('@/sync/sync');

async function rereadAutomationStatus() {
    await sync.refreshAutomations();
}

beforeEach(async () => {
    await home.reset();
    await loadSyncSingletonForTests();
    clearDaemonMergedProjectionCacheForTests();
    resetMachineProjectionReadsForTests();
    rpcEvent = eligibleEvent();
    rpcProjection = projectionResponse(rpcEvent);
    actionResult = { ok: true, result: { kind: 'baselined' } };
    actionRequests.length = 0;
    rpcRequests.length = 0;
    const credentials = { token: createAccountTokenForTests(ACCOUNT_ID, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'History gap', serverUrl: SERVER_URL, serverIdentityId: SERVER_IDENTITY_ID,
        accountId: ACCOUNT_ID, credentials });
    const machine = createPlainMachineRowFixture({ id: MACHINE_ID, accountId: ACCOUNT_ID });
    home.answer(serverId, '/v1/machines', { body: [machine] });
    // Account-qualified daemon reads admit transport from the Home's exact
    // Machine row; the display census alone does not authorize that RPC.
    home.answer(serverId, `GET /v1/machines/${MACHINE_ID}`, { body: { machine } });
    home.answer(serverId, '/v3/automations', { body: AutomationDefinitionListResponseSchema.parse({ automations: [automation()], nextCursor: null }) });
    const installed = materialization();
    const intentRead = PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: { pluginId: PLUGIN_ID, desiredVersion: '1.0.0', enabled: true,
            offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
        release: { ref: { pluginId: PLUGIN_ID, version: '1.0.0' }, archiveDigestSha256: installed.archiveDigestSha256,
            normalizedManifest: { schemaVersion: 2, id: PLUGIN_ID, version: '1.0.0', displayName: 'GitHub',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} },
            collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
        packageAssets: [], uiArtifacts: [],
    });
    home.answer(serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
        body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            snapshots: [{ serverIdentityId: SERVER_IDENTITY_ID, machineId: MACHINE_ID, materializations: [installed] }] }),
    });
    home.answer(serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`, {
        body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [PLUGIN_ID],
            intentReads: [{ pluginId: PLUGIN_ID, response: intentRead }], failedPluginIds: [], nextCursor: null }),
    });
    connection = await restoreServerAccountForTest({ serverUrl: SERVER_URL, serverIdentityId: SERVER_IDENTITY_ID,
        accountId: ACCOUNT_ID, credentials, request: async (url, init) => {
            const response = await home.request(url, init);
            return response.status === 404
                ? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init) ?? response
                : response;
        } });
    SERVER_ID = connection.serverId;
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(storage.getState().profileScope).toEqual({ serverId: SERVER_ID, accountId: ACCOUNT_ID }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('History recovery Account lifetime is unavailable');
    ACCOUNT_LIFETIME = lifetime;
    await sync.refreshMachines({ serverId: SERVER_ID });
    await sync.refreshAutomations();
    const refreshed = await createActivePluginAccountAvailabilityProjectionHydrator().refresh();
    if (!refreshed) throw new Error('History recovery Availability scope retired');
    applyPluginAccountAvailabilityProjectionRefresh(refreshed);
    expect(executionOrigin()).not.toBeNull();
    const inputs = await projectionInputs(rpcEvent);
    const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId: MACHINE_ID, serverId: SERVER_ID });
    expect(inputs, JSON.stringify({ methods: rpcRequests.map(request => request.method), kind: cached?.kind,
        reason: cached && 'reason' in cached ? cached.reason : null })).not.toBeNull();
    expect(readAutomationHistoryGapRecoveryEligibleEvent({ inputs, automation: automation(), triggerId: TRIGGER_ID })).toEqual(rpcEvent);
});

afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    clearPluginAccountAvailabilityProjection();
    clearDaemonMergedProjectionCacheForTests();
    await home.reset();
});

describe('automation history-gap recovery status', () => {
    it('recognizes the exact Plugin Event trigger without treating another trigger as the source', () => {
        const event = automation();
        expect(isPluginEventAutomationTrigger(readEventTrigger(event, TRIGGER_ID))).toBe(true);

        const scheduled = AutomationDefinitionListItemSchema.parse({
            ...event,
            triggers: [{
                id: 'schedule-trigger',
                revision: 1,
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                kind: 'schedule',
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                nextRunAt: 60_000,
            }],
        });
        expect(isPluginEventAutomationTrigger(
            scheduled.triggers.find((candidate) => candidate.id === 'schedule-trigger'),
        )).toBe(false);
    });

    it('admits only the exact current trigger-scoped checkpointed Event source attention status', () => {
        const current = automation();
        const currentTrigger = readEventTrigger(current);

        expect(readAutomationHistoryGapRecoveryStatus(current, TRIGGER_ID)).toMatchObject({
            triggerId: TRIGGER_ID,
            triggerRevision: TRIGGER_REVISION,
            state: 'attention',
            code: 'historyGap',
            revision: 4,
        });
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
                        '22222222-2222-4222-8222-222222222222',
                    ),
                }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ triggerRevision: TRIGGER_REVISION + 1 }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ state: 'observing', code: null }),
            })],
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            enabled: false,
        }), TRIGGER_ID)).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({
                observation: {
                    kind: 'durablePush',
                    webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                    endpointMaterializationRef: null,
                    observationStartsAt: 1,
                },
            })],
        }), TRIGGER_ID)).toBeNull();

        const otherTrigger = eventTrigger({
            id: OTHER_TRIGGER_ID,
            revision: 9,
            sourceStatus: eventSourceStatus({
                triggerId: OTHER_TRIGGER_ID,
                triggerRevision: 9,
            }),
        });
        const plural = automation({ triggers: [currentTrigger, otherTrigger] });
        expect(readAutomationHistoryGapRecoveryStatus(plural, TRIGGER_ID)).toEqual(currentTrigger.sourceStatus);
        expect(readAutomationHistoryGapRecoveryStatus(plural, 'missing-trigger')).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(automation({
            triggers: [eventTrigger({ sourceStatus: otherTrigger.sourceStatus })],
        }), TRIGGER_ID)).toBeNull();
    });

    it('dispatches only the exact current recovery Action with host-filled source identity', async () => {
        const event = eligibleEvent();
        let currentAutomation = automation();

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
        })).resolves.toEqual({ kind: 'settled' });

        expect(actionRequests).toEqual([expect.objectContaining({
            machineId: MACHINE_ID,
            qualifiedActionId: `${PLUGIN_ID}/${ACTION_LOCAL_ID}`,
            expectedContributorOccurrenceId: event.event.occurrenceId,
            executionSurface: 'ui',
            input: {
                automationId: AUTOMATION_ID,
                triggerId: TRIGGER_ID,
                triggerRevision: TRIGGER_REVISION,
                sourceSelectorId: SOURCE_SELECTOR_ID,
            },
        })]);

        currentAutomation = automation({
            triggers: [eventTrigger({
                sourceStatus: eventSourceStatus({ state: 'baselined', code: null, revision: 5 }),
            })],
        });
        actionRequests.length = 0;
        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(actionRequests).toHaveLength(0);
    });

    it('does not dispatch when the current Automation is disabled during the currentness recheck before generic action selection', async () => {
        const event = eligibleEvent();
        let currentAutomation = automation();
        let projectionLoads = 0;

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) currentAutomation = automation({ enabled: false });
                return projectionInputs(event);
            },
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(actionRequests).toHaveLength(0);
    });

    it('does not dispatch a history gap reported by a replaced immutable contributor generation at the same release and materialization', async () => {
        const base = eligibleEvent('github-generation-b');
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            ...base,
            event: {
                ...base.event,
                sourceCustody: { kind: 'managed', immutableGenerationId: 'github-generation-b', installSource: 'archive' },
            },
        });
        const currentAutomation = automation({
            triggers: [eventTrigger({ sourceStatus: eventSourceStatus({
                reporterSourceCustody: { kind: 'managed', immutableGenerationId: 'github-generation-a', installSource: 'archive' },
            }) })],
        });

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
        })).resolves.toEqual({ kind: 'stale' });

        expect(actionRequests).toHaveLength(0);
    });

    it('treats a source-status revision that changes during the currentness recheck as stale without dispatching', async () => {
        const event = eligibleEvent();
        let currentAutomation = automation();
        let projectionLoads = 0;

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) {
                    currentAutomation = automation({
                        triggers: [eventTrigger({
                            sourceStatus: eventSourceStatus({
                                revision: readEventTrigger(currentAutomation).sourceStatus!.revision + 1,
                            }),
                        })],
                    });
                }
                return projectionInputs(event);
            },
        })).resolves.toEqual({ kind: 'stale' });
        expect(actionRequests).toHaveLength(0);
    });

    it('does not recover a different trigger and treats target trigger revision replacement as stale', async () => {
        const event = eligibleEvent();
        let currentAutomation = automation({
            triggers: [
                eventTrigger(),
                eventTrigger({
                    id: OTHER_TRIGGER_ID,
                    revision: 1,
                    sourceStatus: eventSourceStatus({
                        triggerId: OTHER_TRIGGER_ID,
                        triggerRevision: 1,
                        state: 'observing',
                        code: null,
                    }),
                }),
            ],
        });

        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: OTHER_TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => projectionInputs(event),
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(actionRequests).toHaveLength(0);

        let projectionLoads = 0;
        await expect(recoverAutomationHistoryGap({
            eligibleEvent: event,
            triggerId: TRIGGER_ID,
            accountLifetime: ACCOUNT_LIFETIME,
            resolveCurrentAutomation: () => currentAutomation,
            resolveExecutionOrigin: executionOrigin,
            loadCurrentProjection: async () => {
                projectionLoads += 1;
                if (projectionLoads === 2) {
                    currentAutomation = automation({
                        triggers: [
                            eventTrigger({ revision: TRIGGER_REVISION + 1 }),
                            readEventTrigger(currentAutomation, OTHER_TRIGGER_ID),
                        ],
                    });
                }
                return projectionInputs(event);
            },
        })).resolves.toEqual({ kind: 'stale' });
        expect(actionRequests).toHaveLength(0);
    });
});

describe('AutomationHistoryGapRecoveryAction', () => {
    it('keeps an unavailable recovery visible, announced, and retryable while source status remains authoritative', async () => {
        const currentAutomation = automationForScreen();
        actionResult = { ok: false, code: 'plugin_action_failed', message: 'do-not-disclose' };

        const { AutomationHistoryGapRecoveryAction } = await import('./AutomationHistoryGapRecoveryAction');
        const screen = await renderScreen(React.createElement(AutomationHistoryGapRecoveryAction, {
            automation: currentAutomation,
            triggerId: TRIGGER_ID,
            isCurrentRoute: () => true,
            rereadAutomationStatus,
        }));
        await waitForHomeGovernance(() => expect(screen.findAll((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        )).length).toBeGreaterThan(0));
        const recoveryRow = screen.find((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        ));
        const readsBeforeRecovery = home.requestsFor(AUTOMATIONS_PATH).length;

        await pressTestInstanceAsync(recoveryRow, 'history-gap recovery');
        await waitForHomeGovernance(() => expect(home.requestsFor(AUTOMATIONS_PATH)).toHaveLength(readsBeforeRecovery + 1));

        const failure = screen.findByTestId('automation-history-gap-recovery-failure');
        expect(failure).toEqual(expect.objectContaining({
            props: expect.objectContaining({
                role: 'alert',
                accessibilityLiveRegion: 'assertive',
            }),
        }));
        expect(screen.getTextContent()).toContain('Source recovery needs another try');
        expect(screen.getTextContent()).not.toContain('do-not-disclose');
        expect(readAutomationHistoryGapRecoveryStatus(currentAutomation, TRIGGER_ID)).toEqual(
            readEventTrigger(currentAutomation).sourceStatus,
        );

        await screen.pressByTestIdAsync('automation-history-gap-recovery-retry');
        await waitForHomeGovernance(() => expect(actionRequests).toHaveLength(2));
        await waitForHomeGovernance(() => expect(home.requestsFor(AUTOMATIONS_PATH)).toHaveLength(readsBeforeRecovery + 2));
    });

    it('does not clear source attention or show failure after a settled Action before the canonical reread changes it', async () => {
        const currentAutomation = automationForScreen();

        const { AutomationHistoryGapRecoveryAction } = await import('./AutomationHistoryGapRecoveryAction');
        const screen = await renderScreen(React.createElement(AutomationHistoryGapRecoveryAction, {
            automation: currentAutomation,
            triggerId: TRIGGER_ID,
            isCurrentRoute: () => true,
            rereadAutomationStatus,
        }));
        await waitForHomeGovernance(() => expect(screen.findAll((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        )).length).toBeGreaterThan(0));
        const recoveryRow = screen.find((node) => (
            node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function'
        ));
        const readsBeforeRecovery = home.requestsFor(AUTOMATIONS_PATH).length;

        await pressTestInstanceAsync(recoveryRow, 'history-gap recovery');
        await waitForHomeGovernance(() => expect(home.requestsFor(AUTOMATIONS_PATH)).toHaveLength(readsBeforeRecovery + 1));

        expect(screen.findByTestId('automation-history-gap-recovery-failure')).toBeNull();
        expect(readAutomationHistoryGapRecoveryStatus(currentAutomation, TRIGGER_ID)).toEqual(
            readEventTrigger(currentAutomation).sourceStatus,
        );
    });
});
