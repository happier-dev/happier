import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import tweetnacl from 'tweetnacl';
import { openSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import {
    createAccountScopedCryptoMaterialSnapshotV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    prepareWorkflowRunDataKeyV1} from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    AutomationTriggerDefinitionBindingV1Schema} from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import {
    AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import {
    AutomationSourceSelectorIdV1Schema} from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import {
    ArtifactAccessRecipientCensusResponseV1Schema} from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
    validateWorkflowDefinition} from '@happier-dev/protocol/workflows/workflowValidationV1';
import {
    getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import {
    WorkflowRunStartRequestV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowActionFailureV1Schema} from '@happier-dev/protocol/workflows/workflowProgressV1';
import {
    WorkflowTriggerWriteResultV1Schema,
    WorkflowTriggerUpdateRequestV1Schema} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import {
    ScmPullRequestListResponseSchema} from '@happier-dev/protocol/scm/pullRequests';
import {
    PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    compilePluginJsonSchema} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import {
    encodePluginCollectionLogicalValueV1} from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import {
    isValidPluginJsonSchemaValue} from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    normalizePluginAccountCollectionContractV1} from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
    PluginAccountCollectionContributionV1Schema} from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import {
    sealEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    type AvailableAutomationAccountEncryptionV1} from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import {
    type AutomationDefinitionCreateRequest,
    type AutomationDefinitionDetail,
    type AutomationDefinitionListItem,
    type AutomationDefinitionReconcileRequest} from '@happier-dev/protocol/automations/automationApiV3';
import {
    type AutomationTriggerDefinitionInput,
    projectAutomationSessionLifecycleStructuralTrigger,
} from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createUsageCoachController } from '@/components/settings/usage/widgets/usageCoachController';
import { UsageCoachWidget } from '@/components/settings/usage/widgets/UsageCoachWidget';
import type { UsageWidgetBodyModel } from '@/components/settings/usage/useUsageWidgetResource';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import type { AccountActionTransport } from './accountActionTransport';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { buildWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { WorkflowTriggerBlock } from '@/components/workflows/triggers/WorkflowTriggerBlock';
import { buildTriggerDefinition, buildTriggerTarget, createDefaultWhen } from '@/components/workflows/triggers/sessionTriggerForm';
import { ConversationBindingV1Schema, SessionPullRequestBindingInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { clearPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { addWorkflowTrigger, listWorkflowTriggerPage } from '@/sync/domains/workflows/workflowTriggerActions';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useSessionWorkflowContext } from '@/components/workflows/triggers/useSessionWorkflowContext';
import { publishActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { AutomationV3RunDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { WorkflowDefinitionListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { buildKeepGoingTriggerAddRequest } from '@/components/sessions/workState/sessionGoalContinuation';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';

let goalRpcBoundary: { reply: Promise<unknown>; issued: boolean } | null = null;

// Home remains reachable while Machine daemons are offline. Keep the real
// connection supervisor and replace only its external Socket.IO transport.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket) => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    if (!goalRpcBoundary) return;
    const emitWithAck = socket.emitWithAck.bind(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (...emission) => {
        const [event, payload] = emission;
        if (goalRpcBoundary && event === SOCKET_RPC_EVENTS.CALL && payload && typeof payload === 'object'
            && 'method' in payload && typeof payload.method === 'string' && payload.method.endsWith(':session.goal.get')) {
            goalRpcBoundary.issued = true;
            return await goalRpcBoundary.reply;
        }
        return await emitWithAck(...emission);
    });
});

// HTTP, native Machine transport, credentials and rendering adapters are boundaries;
// Account composition, feature decisions, content codecs and Action execution stay real.
const runtimeFetch = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
    // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type.
    const mocked = {
        ...original,
        runtimeFetch: (...args: unknown[]) => runtimeFetch(...args),
        // Let the canonical Account connection harness configure this HTTP boundary.
        setRuntimeFetch: (request: NonNullable<Parameters<typeof import('@/utils/system/runtimeFetch').setRuntimeFetch>[0]>) => runtimeFetch.mockImplementation(request),
        resetRuntimeFetch: () => runtimeFetch.mockReset(),
        get runtimeFetchManualResponse() { return this.runtimeFetch; },
    };
    return mocked;
});
// The machine RPC is the network boundary; projection parsing and cache ownership stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// The user accepts native confirmation at the presentation boundary; Action
// policy, approval selection and the eventual Account write remain real.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Metro's lazy module loader is a platform boundary unavailable in Vitest. Substitute
// only its module loading; the real default factory and Action front door still execute.
vi.mock('./frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('./frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const accountId = 'workflow-account';
const runId = '00000000-0000-4000-8000-000000000001';
const definition = validateWorkflowDefinition({ version: 1,
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
    blocks: ['Do the thing'],
}).normalizedDefinition!;
const triggerSetRow = (id: string, workflowDefinitionId: string, scopeSessionId: string | null = null): AutomationDefinitionListItem => ({
    id, name: 'Workflow triggers', description: null, enabled: true, workflowDefinitionId, scopeSessionId,
    targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
});
const scheduleTrigger = { kind: 'schedule' as const, enabled: true,
    schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
// The server's Automation definition owner is the external persistent boundary.
// This in-memory stand-in applies only the stored row shape and CAS; trigger
// semantics, sealing and Account currentness run through the real UI host.
function storedTrigger(triggerId: string, trigger: AutomationTriggerDefinitionInput, revision = 0,
    scope?: Readonly<{ automationId: string; sourceSessionId: string | null }>): AutomationDefinitionDetail['triggers'][number] {
    if (trigger.kind === 'prComment' || trigger.kind === 'ciFailed') {
        if (!scope?.sourceSessionId) throw new Error('Pull-request fixture needs the serving Automation scope');
        const id = AutomationTriggerIdSchema.parse(triggerId);
        // Mirrors normalizeTriggerWrite + triggerProjection: plain is enveloped
        // by the server, while E2EE content is already sealed by the real host.
        const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
            : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId: scope.automationId, triggerId: id, triggerRevision: revision, triggerKind: trigger.kind },
                definition: { kind: trigger.kind, pullRequest: trigger.pullRequest },
            });
        return { kind: trigger.kind, enabled: trigger.enabled, sourceSessionId: scope.sourceSessionId,
            id, revision, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: JSON.stringify(envelope) };
    }
    if (trigger.kind === 'runLifecycle') return { ...trigger, id: AutomationTriggerIdSchema.parse(triggerId), revision, createdAt: 1, updatedAt: 1,
        remainingOccurrences: 1, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null };
    if (trigger.kind === 'sessionLifecycle') {
        if (!scope) throw new Error('Session fixture needs the serving Automation identity');
        const id = AutomationTriggerIdSchema.parse(triggerId);
        const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
            : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId: scope.automationId, triggerId: id, triggerRevision: revision,
                    triggerKind: 'sessionLifecycle' },
                definition: { kind: 'sessionLifecycle', ...(trigger.subject ? { subject: trigger.subject } : {}),
                    events: trigger.events, policy: trigger.policy },
            });
        const structural = 'triggerDefinitionEnvelope' in trigger ? trigger : projectAutomationSessionLifecycleStructuralTrigger(trigger);
        return { ...structural, enabled: trigger.enabled, id, revision, createdAt: 1, updatedAt: 1,
            remainingOccurrences: null, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: JSON.stringify(envelope) };
    }
    if (trigger.kind === 'pluginEvent') {
        const id = AutomationTriggerIdSchema.parse(triggerId);
        const sourceSelectorId = 'sourceSelectorId' in trigger ? trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse(crypto.randomUUID());
        if (!scope) throw new Error('Event fixture needs the serving Automation identity');
        const envelope = 'triggerDefinitionEnvelope' in trigger ? trigger.triggerDefinitionEnvelope
            : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, automationId: scope.automationId, triggerId: id, triggerRevision: revision,
                    triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId },
                definition: { v: 1, sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig,
                    displayLabel: trigger.displayLabel, filter: trigger.filter, maximumObservationAgeMs: trigger.maximumObservationAgeMs },
            });
        if (trigger.observationTransport.kind !== 'checkpointedPull') throw new Error('Event fixture requires the pull watcher');
        return { kind: 'pluginEvent', id, revision, enabled: trigger.enabled, createdAt: 1, updatedAt: 1,
            eventRef: trigger.eventRef, sourceSelectorId, sourceContractVersion: trigger.sourceContractVersion,
            observation: { kind: 'checkpointedPull', watcher: { ...trigger.observationTransport.watcherMaterializationRef,
                machineInstallationId: 'installation-current' } }, sourceStatus: null, sourceCatalogStatus: null,
            triggerDefinitionEnvelope: JSON.stringify(envelope) };
    }
    if (trigger.kind !== 'schedule') throw new Error('fixture_supports_schedule_triggers_only');
    return { ...trigger, id: triggerId as AutomationDefinitionDetail['triggers'][number]['id'], revision, createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null };
}
function createdAutomation(input: AutomationDefinitionCreateRequest): AutomationDefinitionDetail {
    return { id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
        workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
        targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
        assignments: (input.assignments ?? []).map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
        triggers: input.triggers.map((value) => storedTrigger(value.triggerId, value.trigger, 0,
            { automationId: input.automationId, sourceSessionId: input.scopeSessionId ?? null })),
        ...(input.executionRecipe ? { executionRecipe: input.executionRecipe } : {}),
        ...(input.executionRecipe?.v === 2 && input.executionRecipe.managedTarget !== undefined
            ? { managedTarget: input.executionRecipe.managedTarget } : {}),
        ...(input.observationOnly ? { observationOnly: input.observationOnly } : {}) } as AutomationDefinitionDetail;
}
function reconciledAutomation(row: AutomationDefinitionDetail, input: AutomationDefinitionReconcileRequest): AutomationDefinitionDetail {
    return { ...row, enabled: input.enabled, templateVersion: row.templateVersion + 1,
        ...(input.workflowDefinitionId === undefined ? {} : { workflowDefinitionId: input.workflowDefinitionId }),
        ...(input.executionRecipe ? { executionRecipe: input.executionRecipe, templateCiphertext: undefined, targetType: null, existingSessionId: null } : {}),
        ...(input.executionRecipe?.v === 2 && input.executionRecipe.managedTarget !== undefined
            ? { managedTarget: input.executionRecipe.managedTarget } : {}),
        ...(row.observationOnly ? { observationOnly: { ...row.observationOnly, templateVersion: row.templateVersion + 1 } } : {}),
        assignments: input.assignments.map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 2 })),
        triggers: input.triggers.map((item) => {
            if (item.kind === 'new') return storedTrigger(item.triggerId, item.trigger, 0,
                { automationId: row.id, sourceSessionId: row.scopeSessionId ?? null });
            const current = row.triggers.find((trigger) => trigger.id === item.triggerId)!;
            const changed = item.enabled !== undefined || item.trigger !== undefined;
            if (item.trigger) return storedTrigger(item.triggerId, { ...item.trigger, enabled: item.enabled ?? current.enabled },
                current.revision + 1, { automationId: row.id, sourceSessionId: row.scopeSessionId ?? null });
            const metadata = { ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
                revision: changed ? current.revision + 1 : current.revision };
            if ((current.kind === 'sessionLifecycle' || current.kind === 'pluginEvent' || current.kind === 'prComment' || current.kind === 'ciFailed') && item.triggerDefinitionEnvelope) {
                return { ...current, ...metadata, triggerDefinitionEnvelope: JSON.stringify(item.triggerDefinitionEnvelope) };
            }
            if (current.kind === 'pluginEvent' && item.enabled !== undefined) {
                // The real server rebinds plain stored Event content on an enable-only revision.
                // E2EE clients instead supply the exact next-revision envelope above.
                const binding = AutomationTriggerDefinitionBindingV1Schema.parse({ v: 1, automationId: row.id,
                    triggerId: current.id, triggerRevision: current.revision, triggerKind: 'pluginEvent',
                    eventRef: current.eventRef, sourceSelectorId: current.sourceSelectorId });
                const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                    envelope: JSON.parse(current.triggerDefinitionEnvelope) });
                if (opened.kind !== 'available') throw new Error('Fixture cannot rebind the plain Event envelope');
                return { ...current, ...metadata, triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: 'plain', binding: { ...binding, triggerRevision: metadata.revision }, definition: opened.definition,
                })) };
            }
            return { ...current, ...metadata };
        }) };
}
function listedAutomation(row: AutomationDefinitionDetail): AutomationDefinitionListItem {
    const { executionRecipe: _recipe, templateCiphertext: _template, triggers, ...item } = row;
    return { ...item, triggers: triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) } as AutomationDefinitionListItem;
}
afterEach(() => { runtimeFetch.mockReset(); machineRpc.mockReset(); clearDaemonMergedProjectionCacheForTests(); clearPluginAccountAvailabilityProjection(); vi.restoreAllMocks(); });

async function installPullRequestProjection(h: Awaited<ReturnType<typeof createHarness>>, sessionId: string, publishProjection = true, version?: string) {
    const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
    const { activate } = await import('@happier-dev/plugins-channels/happier-plugin-ui/channels-account-runtime');
    if (!h.account.serverIdentityId) throw new Error('Channels fixture requires a Home identity before Account capture');
    const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find((entry) => entry.id === 'channel-state');
    if (!contribution) throw new Error('Missing canonical Channels collection');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
        contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
    const validate = compilePluginJsonSchema(contract.schema);
    let links: readonly Readonly<{ provider: 'github'; repository: string; number: number }>[] = [];
    let changeCursor = 1;
    let failure = false;
    let sessionProjection: { available: boolean; directory: string; active?: boolean; machineId?: string } = { available: true, directory: '/repo' };
    const request = runtimeFetch.getMockImplementation();
    if (!request) throw new Error('Expected the Workflow HTTP boundary');
    const sessionBoundary = createSessionReadBatchHttpBoundary(component => component.path === `/v2/sessions/${encodeURIComponent(sessionId)}`
        ? sessionProjection.available ? json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: sessionProjection.active ?? false,
            metadata: { name: 'Session', path: sessionProjection.directory, host: 'host', homeDir: '/home', machineId: sessionProjection.machineId ?? 'machine-a' } }) })
            : json({ error: 'session_not_found' }, 404) : undefined);
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = new URL(String(url));
        const path = target.pathname;
        if (path === '/v2/sessions/read-batch' || path === `/v2/sessions/${encodeURIComponent(sessionId)}`) {
            return await sessionBoundary.handle({ home: h.account.serverId, accountId, url: target, path,
                method: init?.method ?? 'GET', headers: new Headers(init?.headers), signal: init?.signal,
                body: init?.body ? JSON.parse(String(init.body)) : undefined }) ?? request(url, init);
        }
        if (path === '/v1/plugins/data/contract') return json({ access: 'readOnly', contract });
        if (path === '/v1/account/plugin-settings/happier.channels') return json({ status: 'absent' });
        if (path === '/v1/plugins/data/get') return json({ row: null, absenceEpoch: 0 });
        if (path !== '/v1/plugins/data/query') return request(url, init);
        if (failure) throw new Error('Channels transport unavailable');
        const rows = links.map((link, index) => {
            const binding = ConversationBindingV1Schema.parse({
                v: 1, id: `binding-${index}`, connectionId: 'connection-1', createdAt: 1, updatedAt: 1,
                endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${link.number}` },
                target: { kind: 'session', sessionId, pullRequestLink: { repository: link.repository, number: link.number },
                    policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
                allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly', inboundDebounceMs: 0,
                linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none',
            });
            const { v, id, connectionId, createdAt, updatedAt, ...payload } = binding;
            const encoded = encodePluginCollectionLogicalValueV1({ contract,
                isValidLogicalValue: (value) => isValidPluginJsonSchemaValue(validate, value),
                value: { id, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': id,
                    'session-id': sessionId, 'pr-binding': true,
                    'created-at': createdAt, 'updated-at': updatedAt, payload }, encryptionMode: 'plain', material: null,
                randomBytes: (length) => new Uint8Array(length).fill(9) });
            if (encoded.status !== 'encoded') throw new Error(`Invalid Channels fixture: ${encoded.reason}`);
            return { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
        });
        return json({ rows, changeCursor });
    });
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: version ? { ...PLUGIN_MANIFEST, version } : PLUGIN_MANIFEST,
        activate, accountLifetime: h.account.accountLifetime, publishProjection });
    onTestFinished(() => installed.dispose());
    return { projection: installed.projection, disable: installed.disable,
        get changeCursor() { return changeCursor; },
        setLinks: (next: typeof links) => { links = next; changeCursor += 1; }, fail: (next = true) => { failure = next; },
        setSessionProjection: (next: typeof sessionProjection) => { sessionProjection = next; } };
}

async function createHarness(mode: 'plain' | 'e2ee' = 'plain', options: Readonly<{ workflowResult?: boolean; malformed?: boolean; locked?: boolean; identity?: boolean; historicalSecret?: Uint8Array; credentialKind?: 'account' | 'account_directory' | 'ephemeral_session_runner'; automations?: readonly AutomationDefinitionListItem[]; cleanupFailure?: boolean; beforeAutomationDeleteResponse?: () => Promise<void>; beforeAutomationListResponse?: () => Promise<void>; featureReadFailure?: boolean; featureReadStatus?: number; automationsEnabled?: boolean; sharedMachine?: boolean; automationCreateRefusal?: string }> = {}) {
    const home = await upsertAndActivateServer({ serverUrl: `https://workflow-${mode}-${crypto.randomUUID()}.test`, scope: 'tab' });
    if (options.identity) await setServerProfileIdentityForUrl(home.serverUrl, `srv_workflow-${crypto.randomUUID()}`);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: accountId,
        ...(options.credentialKind ? { provenance: { v: 1, kind: options.credentialKind,
            authority: options.credentialKind === 'ephemeral_session_runner' ? 'session_runtime' : 'present_user' },
            ...(options.credentialKind === 'account' ? { tokenEpoch: 0 } : {}) } : {}),
    })), 'base64url')}.signature`;
    const secret = new Uint8Array(32).fill(24);
    const credentials: AuthCredentials = options.historicalSecret
        ? { token, secret: encodeBase64(options.historicalSecret, 'base64url'), custody: 'historical' }
        : mode === 'plain' || options.locked ? { token } : { token, secret: encodeBase64(secret, 'base64url') };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }) : undefined;
    // Stored Run content has its own key even when the current reader is locked.
    // The real Account key seals only the owner's recipient envelope.
    const encryption: AvailableAutomationAccountEncryptionV1 = material ? {
        kind: 'available', material, witness: { mode: 'e2ee', version: 1,
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) },
    } : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
    const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
    const preparedKey = prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes });
    const ownerEnvelope = preparedKey.recipientKeyEnvelopes.find((entry) => entry.recipientAccountId === accountId)?.encryptedDataKey ?? null;
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: accountId, access: 'owner',
        encryptionMode: mode, dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope,
        recipients: [], visibleTeamId: null, ownerAccountCurrentness: encryption.witness,
    });
    const run = createWorkflowRunSummaryFixture({ id: runId, origin: options.workflowResult ? { kind: 'automation', automationId: 'automation-reply' } : { kind: 'direct' }, machineId: 'machine-a' });
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition,
        admission: { kind: 'user' },
        // Exact-Machine availability is an external boundary; frozen facts stay real.
        effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`workflow_fixture_not_materialized:${materialized.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        ...(preparedKey.runCrypto.mode === 'e2ee'
            ? { ...preparedKey.runCrypto, randomBytes }
            : preparedKey.runCrypto),
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        acceptedSnapshot: materialized.snapshot,
    }));
    const resultEnvelope = options.workflowResult ? serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
        ...(preparedKey.runCrypto.mode === 'e2ee' ? { ...preparedKey.runCrypto, randomBytes } : preparedKey.runCrypto),
        binding: { v: 1, purpose: 'final_result', accountId, runId },
        finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'Reply opened with the Run key' },
            producerInvocation: { recordId: 'prompt-invocation' } },
    })) : null;
    const operations: Readonly<Record<string, unknown>>[] = [];
    const deletedResources: string[] = [];
    const artifacts = new Map<string, Artifact>();
    const artifactCensus = (artifact: Artifact) => ArtifactAccessRecipientCensusResponseV1Schema.parse({
        artifactId: artifact.id, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        dataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
        callerDataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
        provenanceDataEncryptionKey: mode === 'plain' ? null : artifact.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: mode === 'plain' ? null : artifact.provenanceDataEncryptionKey,
        recipients: [],
    });
    const automationRows = new Map<string, AutomationDefinitionDetail>();
    const automationWrites: string[] = [];
    runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
        if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') {
            if (options.featureReadStatus) return json({ error: 'feature_read_refused' }, options.featureReadStatus);
            if (options.featureReadFailure) return json({ error: 'database_connection_unavailable' }, 503);
            const features = createRootLayoutFeaturesResponse();
            return json({ ...features, capabilities: { ...features.capabilities, accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                currentProtocolVersion: ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1' } },
            });
        }
        expect(target.origin).toBe(home.serverUrl);
        if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
        if (target.pathname === '/v1/account/profile') return json({ ...profileDefaults, id: accountId });
        if (target.pathname === '/v1/account/authoring-memory') return json({ rows: [] });
        if (target.pathname === '/v2/changes') return json({ changes: [], nextCursor: 0 });
        if (target.pathname === '/v2/sessions' || target.pathname === '/v2/sessions/active') {
            return json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (target.pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
        if (target.pathname === '/v1/machines') return json([]);
        if (target.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => ({
            ...createPlainMachineRowFixture({ id, accountId: options.sharedMachine ? 'custodian' : accountId }),
            installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey),
        }));
        if (target.pathname === '/v1/push-tokens') return json({ success: true });
        if (target.pathname === '/v2/account/settings') return json({ content: options.automationsEnabled === undefined ? null : { t: 'plain', v: {
            featureToggles: { automations: options.automationsEnabled ?? true },
        } }, version: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return json({ mode, version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null, updatedAt: 0,
            recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
        if (target.pathname === '/v1/artifacts') {
            if (init?.method !== 'POST') return createArtifactListHttpResponse(target, [...artifacts.values()]);
            const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
            const row: Artifact = { ...input, ...projectArtifactStoredKind(input.kind), ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            artifacts.set(input.id, row);
            return json(row);
        }
        if (target.pathname === '/v1/artifacts/read' && init?.method === 'POST') {
            return createArtifactReadBatchHttpResponse(JSON.parse(String(init.body)), artifactId => {
                const artifact = artifacts.get(artifactId);
                return artifact ? { artifactId, ok: true, artifact, recipientCensus: mode === 'plain' ? null : artifactCensus(artifact) }
                    : { artifactId, ok: false, status: 404, error: 'artifact_not_found', retryable: false };
            });
        }
        if (target.pathname.startsWith('/v1/artifacts/') && target.pathname.endsWith('/access/grants')) {
            const artifactId = decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length, -'/access/grants'.length));
            return json({ artifactId, ownerAccountId: accountId, access: 'owner', grants: [] });
        }
        if (target.pathname.startsWith('/v1/artifacts/') && target.pathname.endsWith('/access/recipients')) {
            const artifactId = decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length, -'/access/recipients'.length));
            const artifact = artifacts.get(artifactId);
            if (!artifact) return json({ error: 'not-found' }, 404);
            // The real E2EE open prepares the current audience; this transport
            // has no additional recipients, but echoes the exact stored key.
            return json(artifactCensus(artifact));
        }
        if (target.pathname.startsWith('/v1/artifacts/')) {
            const artifactId = target.pathname.slice('/v1/artifacts/'.length);
            if (init?.method === 'DELETE') {
                deletedResources.push(artifactId);
                artifacts.delete(artifactId);
                return new Response(null, { status: 204 });
            }
            return json(artifacts.get(artifactId) ?? { error: 'not-found' }, artifacts.has(artifactId) ? 200 : 404);
        }
        if (target.pathname === '/v3/automations' || target.pathname === '/v3/automations/query') {
            const query = target.pathname === '/v3/automations/query'
                ? JSON.parse(String(init?.body)) : null;
            if (init?.method === 'POST' && query === null) {
                if (options.automationCreateRefusal) return json({ error: options.automationCreateRefusal }, 400);
                const row = createdAutomation(JSON.parse(String(init.body)) as AutomationDefinitionCreateRequest);
                automationWrites.push(`create:${row.id}`);
                automationRows.set(row.id, row);
                return json(row);
            }
            await options.beforeAutomationListResponse?.();
            const workflowFilter = query?.workflowDefinitionId ?? target.searchParams.get('workflowDefinitionId');
            const workflowFilters: unknown = query?.workflowDefinitionIds;
            const sessionFilter = query?.scopeSessionId ?? target.searchParams.get('scopeSessionId');
            const accountInline = (query?.scope ?? target.searchParams.get('scope')) === 'account_inline';
            const listed = [...(options.automations ?? []), ...[...automationRows.values()].map(listedAutomation)].filter((row) => (
                (workflowFilter === null || row.workflowDefinitionId === workflowFilter)
                && (!Array.isArray(workflowFilters) || workflowFilters.includes(row.workflowDefinitionId))
                && (sessionFilter === null || row.scopeSessionId === sessionFilter)
                && (!accountInline || (row.workflowDefinitionId == null && row.scopeSessionId == null))
            ));
            return json({ automations: query?.details === true ? listed.map(row => automationRows.get(row.id)) : listed, nextCursor: null });
        }
        if (target.pathname.startsWith('/v3/automations/') && init?.method === 'DELETE') {
            if (options.cleanupFailure) return json({ error: 'cleanup_unavailable' }, 503);
            const automationId = target.pathname.slice('/v3/automations/'.length);
            deletedResources.push(automationId);
            await options.beforeAutomationDeleteResponse?.();
            automationRows.delete(automationId);
            return json({ ok: true });
        }
        const automationId = target.pathname.startsWith('/v3/automations/') && target.pathname !== '/v3/automations/runs/workflow-storage'
            ? decodeURIComponent(target.pathname.slice('/v3/automations/'.length)) : null;
        if (automationId !== null && init?.method === 'PUT') {
            const row = automationRows.get(automationId);
            const input = JSON.parse(String(init.body)) as AutomationDefinitionReconcileRequest;
            if (!row) return json({ error: 'automation_not_found' }, 404);
            if (row.templateVersion !== input.expectedTemplateVersion) return json({ error: 'currentness_conflict' }, 409);
            const next = reconciledAutomation(row, input);
            automationWrites.push(`reconcile:${automationId}`);
            automationRows.set(automationId, next);
            return json(next);
        }
        if (automationId !== null) {
            const row = automationRows.get(automationId);
            return row ? json(row) : json({ error: 'automation_not_found' }, 404);
        }
        // Unserved background reads are HTTP refusals, not a transport outage:
        // throwing here would make the real supervisor mark reachable Home offline.
        if (target.pathname !== '/v3/automations/runs/workflow-storage') return json({ error: 'route_not_found' }, 404);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        const operation = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        expect(operation).not.toHaveProperty('publisherMachineId');
        operations.push(operation);
        if (operation.operation === 'get') return json({ run, acceptedEnvelope: options.malformed ? '{"t":"plain","v":"bad"}' : acceptedEnvelope, checkpointEnvelope: null, resultEnvelope, keyCensus });
        if (operation.operation === 'run-key.census') return json(keyCensus);
        if (operation.operation === 'invocations.list') return json({ invocations: [], parentRevision: run.revision });
        if (operation.operation === 'pause') return json({ run: { ...run, state: 'pause_requested', revision: 2 }, intent: 'pause_requested' });
        if (operation.operation === 'cancel') return json({ run: { ...run, state: 'cancelled', revision: 2 }, intent: 'cancel_requested' });
        throw new Error(`unexpected_operation:${String(operation.operation)}`);
    });
    // Initial Home activation can probe before this HTTP boundary is installed. Refresh the
    // real discovery owner so an unrelated cold network refusal cannot stand in for policy.
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    await getServerFeaturesSnapshot({ serverId: home.id, force: true });
    await upsertAndActivateServer({ serverUrl: `https://focused-${crypto.randomUUID()}.test`, scope: 'tab' });
    let account = await captureLazyActionAccountContext(home.id);
    // Capture follows the app's Account bootstrap; family construction happens
    // afterwards, so its real machine relay cannot re-enter storage creation.
    const { createUiWorkflowAction } = await import('./workflowActionDeps');
    const transport = vi.fn<AccountActionTransport>(async () => ({ run, admission: 'created' }));
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
    // The mounted family's captured lifetime is real; the default factory still
    // owns settings policy, approval and every other Action dependency.
    let execute = createFrontDoorActionExecute(createDefaultActionExecutor({ workflowAction: createUiWorkflowAction({ account, transport }) }));
    const executeDefault = createFrontDoorActionExecute(createDefaultActionExecutor());
    const context = { surface: 'ui' as const, serverId: account.serverId, runtimeAccountId: accountId,
        authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const restoreAccount = async (request: NonNullable<ReturnType<typeof runtimeFetch.getMockImplementation>>) => {
        // Connection restoration is a real credential-lifetime replacement. Mount
        // consumers only after that lifecycle, as the app does after sign-in.
        const credentials = account.credentials;
        account.dispose();
        const connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId, credentials, request });
        runtimeFetch.mockImplementation(request);
        account = await captureLazyActionAccountContext(home.id);
        execute = createFrontDoorActionExecute(createDefaultActionExecutor({ workflowAction: createUiWorkflowAction({ account, transport }) }));
        return connection;
    };
    return { get account() { return account; }, get execute() { return execute; }, restoreAccount,
        executeDefault, context, transport, operations, home, createUiWorkflowAction, deletedResources, artifacts, automationRows, automationWrites, resultEnvelope };
}

function savedAutomationReceipt(automationId: string) {
    return {
            run: { id: runId, automationId, revision: 1, triggerId: null, triggerRetired: false,
                state: 'queued' as const, cause: { kind: 'manual' as const, invokedAt: 1 },
                dueAt: 1, claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null,
                leaseExpiresAt: null, attempt: 0, errorCode: null, producedSessionId: null,
                executionDispatchState: null, executionAttempt: 0, replyHandoffState: 'none' as const,
                replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1 },
            workflowRun: { recipeKind: 'workflow-v2' as const, workflowRunId: runId },
    };
}

/** The Session read owner as the presented Info host demands it. */
function useSessionTriggers(sessionId: string) {
    return useSessionWorkflowContext(sessionId, { demanded: true });
}

describe('UI Workflow Action front door', () => {
    it.each(['full', 'opaque'] as const)('saves a controller trigger from a %s Managed read and refuses a different controller', async format => {
        const h = await createHarness('plain', { identity: true });
        try {
            const homeId = h.account.serverIdentityId;
            if (!homeId) throw new Error('Expected authenticated Home identity');
            const request = runtimeFetch.getMockImplementation()!;
            let controllerMachineId = 'different-controller';
            runtimeFetch.mockImplementation(async (url, init) => {
                if (new URL(String(url)).pathname !== managedMachineActionEndpointPathV1('machines.managed.get')) return request(url, init);
                const row = { id: 'managed-trigger', homeId, custodianAccountId: accountId,
                    controller: { machineId: controllerMachineId, installationId: 'controller-install' }, enrolledMachineId: 'guest-machine',
                    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
                return json(ManagedGetOutputV1Schema.parse(format === 'opaque' ? {
                    machine: { ...row, preset: { id: 'preset-trigger', revision: 1, contentEncryptionMode: 'e2ee' } },
                    presetContent: { content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40), 'base64') }, recipientEnvelope: null },
                } : { ...row, launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                    resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} } }));
            });
            const input = { project: { machineId: 'machine-a', directory: '/repo' }, trigger: scheduleTrigger,
                target: { kind: 'inline' as const, definition: validateWorkflowDefinition({ version: 1, blocks: [{ kind: 'action', id: 'stop',
                    actionId: 'machines.managed.power.set', input: { homeId: { kind: 'literal', value: homeId },
                        managedId: { kind: 'literal', value: 'managed-trigger' }, when: { kind: 'literal', value: 'after-idle' },
                        intent: { kind: 'literal', value: 'stop' } },
                }] }).normalizedDefinition! } };
            await expect(h.execute('workflow.trigger.add', input, h.context)).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(h.automationRows.size).toBe(0);
            controllerMachineId = 'machine-a';
            const saved = await h.execute('workflow.trigger.add', input, h.context);
            expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, result: { set: { project: input.project } } });
            expect(h.automationRows.size).toBe(1);
        } finally { h.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('saves person action approval without %s captured-Home deployment content reads through the UI factory', async mode => {
        const h = await createHarness(mode, { identity: true });
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.serverId = h.account.serverIdentityId!;
        detail.environment.owner = { kind: 'account', accountId };
        try {
            const selected = detail.targetLinks[0]!;
            const request = runtimeFetch.getMockImplementation()!;
            const deploymentReads: string[] = [];
            const artifactBatches: string[][] = [];
            let sourceReads = 0;
            runtimeFetch.mockImplementation(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === `/v1/deployments/environments/${detail.environment.id}`) {
                    deploymentReads.push(path);
                }
                if (path === `/v1/projects/sources/${detail.environment.projectSourceId}`) sourceReads++;
                if (path === '/v1/artifacts/read') artifactBatches.push(JSON.parse(String(init?.body)).artifactIds);
                return request(url, init);
            });
            const target = { kind: 'inline' as const, definition: validateWorkflowDefinition({ version: 1, defaults: {},
                inputs: [{ name: 'sha', valueType: 'string', required: true }, { name: 'requestKey', valueType: 'string', required: true }],
                blocks: [{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy', input: {
                    serverId: { kind: 'literal', value: h.account.serverId },
                    environmentId: { kind: 'literal', value: detail.environment.id },
                    targetLinkId: { kind: 'literal', value: selected.targetLink.id },
                    whenBusy: { kind: 'literal', value: 'supersede' },
                    sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' },
                } }],
            }).normalizedDefinition! };
            const input = { target, project: { machineId: 'machine-a', directory: '/repo' },
                trigger: { kind: 'pluginEvent' as const, enabled: true,
                    eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
                    sourceInstanceId: 'repo-source', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
                    observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
                        machineId: 'machine-a', materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
                    filter: null, maximumObservationAgeMs: null },
                deployment: { branch: 'main' }, actionApproval: 'automatic' as const };
            const context = { ...h.context, actionRequestId: 'save-person-deployment-trigger' };
            const result = await h.execute('workflow.trigger.add', input, context);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { set: { context: {
                deploymentTriggers: [{ branch: 'main' }],
                actionApprovals: [{ operation: { approvedBy: { accountId }, steps: [{ actionId: 'deployments.deploy' }] } }],
            } } } });
            if (!result.ok) throw new Error('Expected saved action approval');
            const saved = WorkflowTriggerWriteResultV1Schema.parse(result.result);
            if (!saved.set.context) throw new Error('Expected saved action approval context');
            expect(saved.set.context.deploymentTriggers?.[0]).not.toHaveProperty('approval');
            expect(h.automationWrites).toHaveLength(1);
            expect({ deploymentReads, artifactBatches, sourceReads }).toEqual({ deploymentReads: [], artifactBatches: [], sourceReads: 0 });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('shares admitted %s identity across 200 Workflow projection arrivals while detail authority stays fresh', async mode => {
        const h = await createHarness(mode);
        const request = runtimeFetch.getMockImplementation()!;
        let currentnessReads = 0;
        let listReads = 0;
        const observedRequest: typeof request = async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') currentnessReads++;
            if (path === '/v3/automations/runs/workflow-storage' && JSON.parse(String(init?.body)).operation === 'list') {
                listReads++;
                const snapshot = await (await request(url, { ...init, body: JSON.stringify({ operation: 'get', runId }) })).json();
                return json({ runs: [snapshot.run],
                    acceptedEnvelopesByRunId: { [runId]: snapshot.acceptedEnvelope },
                    keyCensusByRunId: { [runId]: snapshot.keyCensus } });
            }
            return request(url, init);
        };
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        try {
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(observedRequest);
            await h.account.resolveAccountEncryption();
            const before = currentnessReads;
            for (let index = 0; index < 200; index++) {
                const result = await h.executeDefault('workflow.run.list', {}, h.context);
                expect(result).toMatchObject({ ok: true, result: { runs: [{ id: runId,
                    where: { machineId: 'machine-a', directory: '/repo' } }] } });
            }
            expect(listReads).toBe(200);
            expect.soft(currentnessReads - before).toBeLessThanOrEqual(1);
            const beforeDetail = currentnessReads;
            await expect(h.executeDefault('workflow.run.get', { runId }, h.context)).resolves.toMatchObject({ ok: true });
            expect(currentnessReads - beforeDetail).toBe(1);
        } finally { h.account.dispose(); await connection?.dispose(); }
    });
    it('keeps concurrent Automation set selections distinct at the shared read transport', async () => {
        const h = await createHarness();
        const held = createDeferred<void>();
        const request = runtimeFetch.getMockImplementation()!;
        const ids = ['00000000-0000-4000-8000-000000000083', '00000000-0000-4000-8000-000000000084'];
        let reads = 0;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            if (new URL(String(url)).pathname !== '/v3/automations/query') return request(url, init);
            const body: unknown = JSON.parse(String(init?.body));
            const selected: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'workflowDefinitionIds') : null;
            if (!Array.isArray(selected) || typeof selected[0] !== 'string') throw new Error('Expected selected Automation demand');
            reads += 1;
            await held.promise;
            return json({ automations: [triggerSetRow(`selected-${selected[0]}`, selected[0])], nextCursor: null });
        });
        try {
            const { listAutomationDefinitions } = await import('@/sync/api/automations/apiAutomations');
            const readsByDefinition = ids.map(id => listAutomationDefinitions(h.account.credentials,
                { workflowDefinitionIds: [id] }, h.account));
            await flushHookEffects();
            held.resolve();
            const pages = await Promise.all(readsByDefinition);
            expect(pages.map(page => page.automations[0]?.workflowDefinitionId)).toEqual(ids);
            expect(reads).toBe(2);
        } finally { held.resolve(); h.account.dispose(); }
    });
    it.each([false, true])('bounds a definition page summary read to its selected Automations through the real HTTP adapter (omitted-filter control: %s)', async omitFilter => {
        const ids = ['00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000082'];
        const unrelated = Array.from({ length: 2500 }, (_, index) => triggerSetRow(`unrelated-${index}`, 'builtin:unrelated'));
        const rows = [...unrelated, ...ids.map((id, index) => triggerSetRow(`selected-${index}`, id))];
        const h = await createHarness();
        const request = runtimeFetch.getMockImplementation()!;
        let pages = 0, unrelatedRows = 0;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            const query = target.pathname === '/v3/automations/query' && init?.method === 'POST'
                ? JSON.parse(String(init.body)) : null;
            if (query === null && (target.pathname !== '/v3/automations' || init?.method === 'POST')) return request(url, init);
            const selected: unknown = omitFilter ? undefined : query?.workflowDefinitionIds;
            const one = target.searchParams.get('workflowDefinitionId');
            const filtered = rows.filter(row => one !== null ? row.workflowDefinitionId === one
                : Array.isArray(selected) ? selected.includes(row.workflowDefinitionId) : true);
            const offset = Number(query?.cursor ?? target.searchParams.get('cursor') ?? 0);
            const page = filtered.slice(offset, offset + 100);
            pages += 1;
            unrelatedRows += page.filter(row => row.workflowDefinitionId === 'builtin:unrelated').length;
            return json({ automations: page, nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null });
        });
        try {
            await loadSyncSingletonForTests();
            for (const definitionId of ids) {
                expect(await h.execute('workflow.definition.create', { definitionId, definition,
                    metadata: { title: 'Selected workflow' } }, h.context)).toMatchObject({ ok: true });
            }
            const result = await h.execute('workflow.definition.list', { limit: 2 }, h.context);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            if (!result.ok) throw new Error('Expected a readable definition page');
            expect(WorkflowDefinitionListResultV1Schema.parse(result.result).definitions.map(row => row.definitionId).sort()).toEqual(ids);
            expect({ pages, unrelatedRows }).toEqual(omitFilter
                ? { pages: 26, unrelatedRows: 2500 } : { pages: 1, unrelatedRows: 0 });
        } finally { h.account.dispose(); }
    });
    it.each([404, 403, 503])('keeps definition content when the selected summary HTTP query refuses with %s', async status => {
        const h = await createHarness();
        const request = runtimeFetch.getMockImplementation()!;
        const definitionId = '00000000-0000-4000-8000-000000000083';
        let selectedReads = 0, unfilteredReads = 0;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v3/automations/query') {
                expect(JSON.parse(String(init?.body)).workflowDefinitionIds).toEqual([definitionId]);
                selectedReads++;
                return Response.json({ error: status === 403 ? 'run_access_denied' : 'storage_unavailable' }, { status });
            }
            if (path === '/v3/automations') unfilteredReads++;
            return request(url, init);
        });
        try {
            await loadSyncSingletonForTests();
            expect(await h.execute('workflow.definition.create', { definitionId, definition,
                metadata: { title: 'Readable workflow' } }, h.context)).toMatchObject({ ok: true });
            const result = await h.execute('workflow.definition.list', {}, h.context);
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) throw new Error('Expected readable definitions');
            expect(WorkflowDefinitionListResultV1Schema.parse(result.result).definitions).toMatchObject([
                { definitionId, contentStatus: 'available', triggerSummaryErrorCode: status === 403 ? 'run_access_denied' : 'storage_unavailable' },
            ]);
            expect({ selectedReads, unfilteredReads }).toEqual({ selectedReads: 1, unfilteredReads: 0 });
        } finally { h.account.dispose(); }
    });
    it('preserves a failed Home feature read as temporary storage unavailability', async () => {
        const h = await createHarness('plain', { featureReadFailure: true });
        try {
            await expect(h.execute('workflow.run.get', { runId }, h.context))
                .resolves.toMatchObject({ ok: false, errorCode: 'storage_unavailable' });
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });
    it('keeps a permanent Home feature refusal out of storage retry', async () => {
        const h = await createHarness('plain', { featureReadStatus: 403 });
        try {
            await expect(h.execute('workflow.run.get', { runId }, h.context))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });
    it.each(['absent', 'unprojected', 'not_found', 'forbidden', 'http_503', 'network_error', 'other_session', 'retired', 'native_owner'] as const)(
        'FIX81 resolves Keep going placement through the exact Home: %s', async cached => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'session-not-opened';
        const wire = createPlainSessionCurrentProjectionRecordFixture({ id: cached === 'other_session' ? 'different-session' : sessionId,
            active: cached === 'native_owner',
            metadata: { path: '/owned-project', host: 'host', homeDir: '/home', machineId: 'machine-a' } });
        const request = runtimeFetch.getMockImplementation()!;
        const sessionReads: string[] = [];
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        if (cached === 'native_owner') goalRpcBoundary = { issued: false,
            reply: Promise.resolve({ ok: true, result: { workState: null, nativeGoalOwner: true } }) };
        try {
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            const sessionBoundary = createSessionReadBatchHttpBoundary(async request => {
                if (request.path === `/v2/sessions/${sessionId}`) {
                    sessionReads.push(request.url.toString());
                    if (cached === 'not_found') return json({ error: 'Session not found' }, 404);
                    if (cached === 'forbidden') return json({ error: 'Forbidden' }, 403);
                    if (cached === 'http_503') return json({ error: 'Unavailable' }, 503);
                    if (cached === 'network_error') throw new TypeError('Failed to fetch');
                    if (cached === 'retired') await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl,
                        { serverId: h.account.serverId }, { token: 'replacement-account' });
                    return json({ session: wire });
                }
                return undefined;
            });
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                const target = new URL(String(url));
                if (target.pathname !== '/v2/sessions/read-batch' && target.pathname !== `/v2/sessions/${sessionId}`) return request(url, init);
                return await sessionBoundary.handle({ home: h.account.serverId, accountId, url: target,
                    path: target.pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers),
                    signal: init?.signal, body: init?.body ? JSON.parse(String(init.body)) : undefined }) ?? request(url, init);
            });
            expect(getActiveServerSnapshot().serverId).toBe(h.account.serverId);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId } });
            storage.setState({ sessions: cached !== 'unprojected' ? {} : { [sessionId]: createSessionFixture({ id: sessionId,
                metadataLayoutVersion: 1, ownerMetadataView: null }) } });
            const input = buildKeepGoingTriggerAddRequest({ sessionId, serverId: h.account.serverIdentityId! }, { maxRounds: 4, strikes: 3, secondOpinion: false });
            const result = await h.execute('workflow.trigger.add', input, h.context);
            if (cached !== 'absent' && cached !== 'unprojected') {
                expect(result).toMatchObject({ ok: false, ...(cached === 'native_owner' ? { errorCode: 'native_goal_owner' } : {}) });
                if (cached === 'not_found') expect(result).toMatchObject({
                    errorCode: 'target_unavailable', details: { code: 'target_unavailable', reason: 'session_unavailable' },
                });
                // The canonical Session reader keeps scoped 403 distinct from
                // Account authentication loss, even when requested with Account credentials.
                if (cached === 'forbidden') expect(result).toMatchObject({ errorCode: 'target_unavailable',
                    details: { code: 'target_unavailable', reason: 'session_unavailable' } });
                if (cached === 'http_503' || cached === 'network_error') {
                    expect(WorkflowActionFailureV1Schema.parse(result)).toMatchObject({ errorCode: 'storage_unavailable' });
                    expect(sessionReads).not.toEqual([]);
                    expect(h.transport).not.toHaveBeenCalled();
                }
                expect(h.automationWrites).toEqual([]);
                return;
            }
            expect(result, JSON.stringify({ result, sessionReads, wire })).toMatchObject({ ok: true, result: { set: {
                scopeSessionId: sessionId, project: { machineId: 'machine-a', directory: '/owned-project' },
                target: { kind: 'workflow', ref: 'builtin:keep-going' },
                triggers: [{ kind: 'sessionLifecycle', subject: { kind: 'session', serverId: h.account.serverIdentityId, sessionId }, events: ['parentTurnCompleted'] }],
            } } });
            if (!result.ok) throw new Error('Expected admitted trigger');
            expect(getActionSpec('workflow.trigger.add').outputSchema!.safeParse(result.result).success).toBe(true);
            expect(h.automationWrites).toHaveLength(1);
            expect(h.transport).not.toHaveBeenCalled();
            expect(storage.getState().sessions[sessionId]).toEqual(cached === 'absent' ? undefined
                : expect.objectContaining({ ownerMetadataView: null }));
        } finally { goalRpcBoundary = null; h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });

    it.each(['native', 'unsupported', 'abort'] as const)('retains Keep going capability readiness until %s settlement', async scenario => {
        const previousState = storage.getState();
        const h = await createHarness();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let release!: (value: unknown) => void;
        goalRpcBoundary = { issued: false, reply: new Promise(resolve => { release = resolve; }) };
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId } });
            storage.getState().applySessions([createSessionFixture({ id: 'session-opening', active: true,
                encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: { name: 'Session' } as ReturnType<typeof createSessionFixture>['metadata'],
                ownerMetadataView: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } as ReturnType<typeof createSessionFixture>['metadata'] })]);
            const controller = new AbortController();
            let settled = false;
            const pending = h.execute('workflow.trigger.add', { lifetimeSession: { sessionId: 'session-opening' },
                target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger: scheduleTrigger },
            { ...h.context, signal: controller.signal }).then(result => { settled = true; return result; });
            await vi.waitFor(() => expect(goalRpcBoundary?.issued).toBe(true));
            // Include the existing transport's auth-error settlement after an ACK timeout.
            if (scenario !== 'abort') await new Promise<void>(resolve => setTimeout(resolve, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1_000));
            expect(settled, 'native controls readiness outlives the generic RPC default').toBe(false);
            if (scenario === 'abort') {
                controller.abort();
                await vi.waitFor(() => expect(settled).toBe(true));
            }
            release({ ok: true, result: { workState: null, nativeGoalOwner: scenario !== 'unsupported' } });
            await expect(pending).resolves.toMatchObject(scenario === 'unsupported' ? { ok: true }
                : { ok: false, ...(scenario === 'native' ? { errorCode: 'native_goal_owner' } : {}) });
            expect(h.automationWrites).toHaveLength(scenario === 'unsupported' ? 1 : 0);
        } finally {
            release({ ok: true, result: { workState: null, nativeGoalOwner: true } });
            goalRpcBoundary = null;
            vi.useRealTimers();
            h.account.dispose();
            await connection?.dispose();
            storage.setState(previousState);
        }
    });

    it('runs one exact saved Automation occurrence on its captured Home and preserves the whole admission receipt', async () => {
        const h = await createHarness();
        const automationId = 'automation-upkeep';
        const receipt = savedAutomationReceipt(automationId);
        const request = runtimeFetch.getMockImplementation();
        if (!request) throw new Error('Expected the Workflow HTTP boundary');
        const admitted: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === `/v3/automations/${automationId}/run-now`) {
                expect(target.origin).toBe(h.home.serverUrl);
                expect(init?.method).toBe('POST');
                expect(init?.body).toBeUndefined();
                if (new Headers(init?.headers).get('Idempotency-Key') === 'lost-manual-reply') throw new Error('Reply lost');
                if (new Headers(init?.headers).get('Idempotency-Key') === 'paused-manual') return json({ error: 'automation_disabled' }, 409);
                admitted.push(automationId);
                return json(receipt);
            }
            return request(url, init);
        });
        try {
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context))
                .toEqual({ ok: true, result: receipt });
            expect(admitted).toEqual([automationId]);
            expect(await h.execute('workflow.trigger.run_now', { automationId, idempotencyKey: 'lost-manual-reply' }, h.context))
                .toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
            expect(await h.execute('workflow.trigger.run_now', { automationId, idempotencyKey: 'paused-manual' }, h.context))
                .toMatchObject({ ok: false, errorCode: 'ineligible_state' });
            expect(h.transport).not.toHaveBeenCalled();
            expect(h.automationWrites).toEqual([]);
            // Approval remains at the front door. Its already-admitted Account
            // continuation must not gain a Machine dependency solely from authority.
            expect(await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.trigger.run_now', input: { automationId },
                context: { ...h.context, authority: 'account_automation' },
            })).toEqual(receipt);
            expect(h.transport).not.toHaveBeenCalled();
            expect(await h.execute('workflow.trigger.run_now', { automationId, inputs: { prompt: 'replace saved task' } }, h.context))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(admitted).toEqual([automationId, automationId]);
        } finally { h.account.dispose(); }
    });
    it('publishes manual admission only into its focused Account cache and rejects retired receipt custody', async () => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const h = await createHarness();
        const ownRunKey = workflowRunStoreKey(runId, h.account.accountLifetime.scope);
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        const automationId = 'automation-cache';
        const receipt = savedAutomationReceipt(automationId);
        const request = runtimeFetch.getMockImplementation();
        if (!request) throw new Error('Expected the Workflow HTTP boundary');
        let retireBeforeReceipt = false;
        let misboundReceipt = false;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === `/v3/automations/${automationId}/run-now`) {
                expect(target.origin).toBe(h.home.serverUrl);
                if (retireBeforeReceipt) {
                    expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId },
                        { token: 'replacement-account' })).toBe(true);
                }
                return json(misboundReceipt ? { ...receipt, run: { ...receipt.run, automationId: 'another-automation' } } : receipt);
            }
            return request(url, init);
        });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            storage.setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId },
                workflowRunsById: {}, automationRunIdsByAutomationId: {} });
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context)).toEqual({ ok: true, result: receipt });
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();

            const admissionRequest = runtimeFetch.getMockImplementation();
            if (!admissionRequest) throw new Error('Expected the manual admission HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(admissionRequest);
            runtimeFetch.mockImplementation(admissionRequest);
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId: 'another-account' } });
            // Focused Sync scope controls cache publication, not captured Action authority.
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context)).toEqual({ ok: true, result: receipt });
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();

            await connection.dispose();
            connection = await h.restoreAccount(admissionRequest);
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId } });
            expect(getActiveServerAccountScope()).toEqual({ serverId: h.account.serverId, accountId });
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context)).toEqual({ ok: true, result: receipt });
            expect(storage.getState().workflowRunsById[ownRunKey]?.automation).toEqual(receipt.run);
            expect(storage.getState().automationRunIdsByAutomationId[automationId]).toEqual([runId]);
            expect(h.automationWrites).toEqual([]);

            storage.setState({ workflowRunsById: {}, automationRunIdsByAutomationId: {} });
            misboundReceipt = true;
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context))
                .toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();
            expect(storage.getState().automationRunIdsByAutomationId['another-automation']).toBeUndefined();

            const approval = { kind: 'approval_request_created', artifactId: 'manual-approval', actionId: 'workflow.trigger.run_now' };
            h.transport.mockResolvedValueOnce(approval);
            expect(await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.trigger.run_now', input: { automationId },
                context: { ...h.context, surface: 'agent',
                    externalActionTarget: { kind: 'machine', machineId: 'machine-a' } },
            })).toEqual(approval);
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();
            expect(storage.getState().automationRunIdsByAutomationId[automationId]).toBeUndefined();

            h.transport.mockResolvedValueOnce({ ...receipt, run: { ...receipt.run, automationId: 'another-automation' } });
            expect(await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.trigger.run_now', input: { automationId },
                context: { ...h.context, surface: 'agent',
                    externalActionTarget: { kind: 'machine', machineId: 'machine-a' } },
            })).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();
            expect(storage.getState().automationRunIdsByAutomationId['another-automation']).toBeUndefined();

            misboundReceipt = false;
            retireBeforeReceipt = true;
            expect(await h.execute('workflow.trigger.run_now', { automationId }, h.context)).toMatchObject({ ok: false });
            expect(storage.getState().workflowRunsById[ownRunKey]).toBeUndefined();
            expect(storage.getState().automationRunIdsByAutomationId[automationId]).toBeUndefined();
        } finally {
            h.account.dispose();
            await connection?.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it.each(['plain', 'e2ee'] as const)('saves an Account Habit to C after destination A is deleted through the real %s confirmation path', async mode => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const h = await createHarness(mode);
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation()!;
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            storage.setState({ sessions: {}, profileScope: { serverId: h.account.serverId, accountId } });
            let deletedA = false;
            const sessionBoundary = createSessionReadBatchHttpBoundary(request => {
                if (request.path !== '/v2/sessions/session-a') return undefined;
                return deletedA ? json({ error: 'Session not found' }, 404) : json({ session:
                    createPlainSessionCurrentProjectionRecordFixture({ id: 'session-a', active: false,
                        metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }) });
            });
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                const target = new URL(String(url));
                return await sessionBoundary.handle({ home: h.account.serverId, accountId, url: target,
                    path: target.pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers),
                    signal: init?.signal, body: init?.body ? JSON.parse(String(init.body)) : undefined }) ?? request(url, init);
            });
            const habitDefinition = (sessionId: string, machineId: string) => validateWorkflowDefinition({ ...definition,
                defaults: { ...definition.defaults, conversation: { kind: 'existing_session', sessionId, machineId } },
                blocks: definition.blocks.map(block => ({ ...block,
                    execution: { conversation: { kind: 'existing_session', sessionId, machineId } } })),
            }).normalizedDefinition!;
            const added = await h.execute('workflow.trigger.add', { project: { machineId: 'machine-a', directory: '/repo' },
                target: { kind: 'inline', definition: habitDefinition('session-a', 'machine-a') },
                trigger: { ...scheduleTrigger, enabled: false } }, h.context);
            expect(added).toMatchObject({ ok: true });
            if (!added.ok) throw new Error(added.errorCode);
            const original = WorkflowTriggerWriteResultV1Schema.parse(added.result);
            deletedA = true;
            const destination = { machineId: 'machine-c', directory: '/destination-c' };
            const update = { automationId: original.set.automationId,
                triggerId: original.triggerId, expectedRevision: original.set.revision,
                patch: { project: destination, target: { kind: 'inline' as const, definition: habitDefinition('session-c', 'machine-c') } },
            };
            // Whole-Habit deletion is irreversible; cancelling it must preserve the Habit for the direct edit.
            const { Modal } = await import('@/modal');
            vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
            expect(await h.execute('workflow.trigger.remove', { automationId: original.set.automationId }, h.context))
                .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(h.automationRows.get(original.set.automationId)?.templateVersion).toBe(1);
            const updated = await h.execute('workflow.trigger.update', update, h.context);
            expect(updated).toMatchObject({ ok: true });
            if (!updated.ok) throw new Error(updated.errorCode);
            const receipt = WorkflowTriggerWriteResultV1Schema.parse(updated.result);
            expect(receipt.set).toMatchObject({ revision: 2, scopeSessionId: null, project: destination,
                destinations: { targetSessionIds: ['session-c'] }, triggers: [{ enabled: false }],
                context: { inlineDefinition: { defaults: { conversation: { sessionId: 'session-c' } },
                    blocks: [{ execution: { conversation: { sessionId: 'session-c' } } }] } } });
            const read = await h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context);
            expect(read).toMatchObject({ ok: true, result: { sets: [receipt.set] } });
            expect(h.automationRows.get(original.set.automationId)).toMatchObject({ templateVersion: 2,
                scopeSessionId: null, assignments: [{ machineId: 'machine-c' }] });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable); }
    });
    it('mounts a digest suggestion without a write and creates it only through explicit Automation Action consent', async () => {
        const previous = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const h = await createHarness();
        let controller: ReturnType<typeof createUsageCoachController> | null = null;
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            controller = createUsageCoachController({ lifetime: h.account.accountLifetime, executor: { execute: h.execute } });
            runtimeFetch.mockImplementation(request);
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId } });
            const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, sources: ['runtime'] });
            const slice = resolveUsagePageAggregation({ queries: [query] }, bundledUsageModelPriceCatalog).results[0]!;
            const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false,
                error: null, freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
            screen = await renderScreen(React.createElement(UsageCoachWidget, {
                id: 'usage_coach', model, slice, query, serverId: h.account.serverId, testID: 'digest',
            }));
            expect(h.automationWrites).toEqual([]);
            expect(screen.findByTestId('digest.digest.configure')).toBeTruthy();
            expect(screen.findByTestId('digest.digest.editor')).toBeNull();
            await screen.pressByTestIdAsync('digest.digest.configure');
            expect(screen.findByTestId('digest.digest.editor')).toBeTruthy();
            expect(screen.findByTestId('digest.digest.editor-submit')?.props.disabled).toBe(true);
            expect(h.automationWrites).toEqual([]);
            const suggestion = slice.coach!.digestSuggestion!;
            const created = await controller.createDigest(suggestion, { machineId: 'machine-a', directory: '/repo' }, scheduleTrigger);
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
            const receipt = controller.getSnapshot().digest;
            expect(receipt).toMatchObject({ queryKey: slice.key });
            expect(h.automationRows.get(receipt!.result.set.automationId)).toMatchObject({
                enabled: true, assignments: [{ machineId: 'machine-a' }], triggers: [{ kind: 'schedule', enabled: true }],
            });
            expect(await h.execute('workflow.trigger.remove', { automationId: receipt!.result.set.automationId,
                triggerId: receipt!.result.triggerId }, h.context)).toMatchObject({ ok: true });
            expect(h.automationRows.get(receipt!.result.set.automationId)?.triggers).toEqual([]);
        } finally { await screen?.unmount(); controller?.dispose(); h.account.dispose(); await connection?.dispose();
            storage.setState(previous); publishAppliedActiveServerSnapshot(previousApplied, previousAvailable); }
    });
    it('returns saved workflows before awaiting the real plugin projection provider', async (testContext) => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const h = await createHarness();
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof import('@/components/workflows/library/workflowLibraryReads').useWorkflowDefinitionLibrary>>>> | null = null;
        let finishProjection!: (value: unknown) => void;
        const projectionResponse = new Promise<unknown>((resolve) => { finishProjection = resolve; });
        let listing: ReturnType<typeof h.execute> | null = null;
        try {
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId } });
            storage.getState().applyMachines([createMachineFixture({ id: 'workflow-pending-plugin-machine', activeAt: Date.now(),
                daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } })], true,
            { sourceServerId: h.account.serverId });
            machineRpc.mockImplementation(async () => projectionResponse);
            const definitionId = '00000000-0000-4000-8000-000000000014';
            await expect(h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Saved before plugins' } }, h.context))
                .resolves.toMatchObject({ ok: true });
            let settled: Awaited<ReturnType<typeof h.execute>> | null = null;
            const startedAt = performance.now();
            listing = h.execute('workflow.definition.list', {}, h.context).then((value) => { settled = value; return value; });
            // The RPC stays unresolved: Account content must already be usable, not gated on its timeout.
            await vi.waitFor(() => expect(settled).toMatchObject({ ok: true, result: {
                definitions: [expect.objectContaining({ definitionId })], nextCursor: expect.any(String),
            } }));
            const firstPage = await listing;
            const savedPageMs = performance.now() - startedAt;
            if (!firstPage.ok) throw new Error('Expected the saved Workflow page');
            const page = WorkflowDefinitionListResultV1Schema.parse(firstPage.result);
            const nextPage = h.execute('workflow.definition.list', { cursor: page.nextCursor }, h.context);
            await vi.waitFor(() => expect(machineRpc).toHaveBeenCalled());
            const { useWorkflowDefinitionLibrary } = await import('@/components/workflows/library/workflowLibraryReads');
            let renders = 0;
            const mountedAt = performance.now();
            hook = await renderHook(() => { renders += 1; return useWorkflowDefinitionLibrary(); });
            await vi.waitFor(() => expect(hook?.getCurrent()).toMatchObject({ status: 'loaded',
                definitions: [expect.objectContaining({ definitionId })], loadingMore: true }));
            const savedRows = hook.getCurrent().definitions;
            const pendingRenders = renders;
            const savedLibraryMs = performance.now() - mountedAt;
            await flushHookEffects();
            expect(renders).toBe(pendingRenders);
            await act(async () => { finishProjection({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3',
                    enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
                familiesById: { workflows: { family: 'workflows', entriesById: {
                    'example.recipe/review': { id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                        definition: { id: 'review', title: 'Plugin review', definition } },
                } } },
            }) }); await nextPage; });
            await expect(nextPage).resolves.toMatchObject({ ok: true, result: { definitions: [],
                pluginWorkflows: [expect.objectContaining({ workflow: 'plugin:example.recipe/review' })] } });
            await vi.waitFor(() => expect(hook?.getCurrent().pluginWorkflows).toHaveLength(1));
            expect(hook.getCurrent().definitions).toBe(savedRows);
            expect(hook.getCurrent().hasMore).toBe(false);
            const beforeRefreshRenders = renders;
            await act(async () => { hook?.getCurrent().retry(); });
            await flushHookEffects();
            expect(hook.getCurrent().definitions).toBe(savedRows);
            expect(renders).toBe(beforeRefreshRenders);
            Object.assign(testContext.task.meta, { ffLoading: { savedPageMs, savedLibraryMs, pendingRenders, settledRenders: renders,
                savedContentAvailableBeforeProjectionRelease: true } });
        } finally {
            finishProjection({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) });
            await listing;
            await hook?.unmount();
            h.account.dispose();
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });
    it.each(['plain', 'e2ee'] as const)('projects a %s Workflow result into the existing Automation recovery detail through its canonical Run reader', async (mode) => {
        const h = await createHarness(mode, { workflowResult: true });
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const detail: AutomationV3RunDetail = {
                id: runId, automationId: 'automation-reply', revision: 1, state: 'succeeded', triggerId: null, triggerRetired: false,
                cause: { kind: 'manual', invokedAt: 1 },
                dueAt: 1, claimedAt: 1, startedAt: 1, finishedAt: 2, claimedByMachineId: 'machine-a', leaseExpiresAt: null,
                attempt: 1, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
                replyHandoffState: 'blocked', replyHandoffAttempt: 1, replyHandoffDueAt: null, createdAt: 1, updatedAt: 2,
                executionInputEnvelope: null, triggerEvidenceEnvelope: null, resultEnvelope: h.resultEnvelope,
                legacySummaryCiphertext: null, executionNativeRunId: null, executionNativeCallId: null, executionNativeSidechainId: null, events: [],
                workflowRun: { recipeKind: 'workflow-v2', workflowRunId: runId },
            };
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            const recoveryRequest = async (url: unknown, init?: RequestInit) => {
                if (new URL(String(url)).pathname === `/v3/automations/automation-reply/runs/${runId}`) return json(detail);
                return request(url, init);
            };
            await loadSyncSingletonForTests();
            const { sync } = await import('@/sync/sync');
            connection = await h.restoreAccount(recoveryRequest);
            const inspection = await sync.getAutomationRunDetailInspection('automation-reply', runId);
            expect(inspection.privateContent.result).toMatchObject({ kind: 'available', result: { text: 'Reply opened with the Run key' } });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { await connection?.dispose(); h.account.dispose(); }
    });
    it.each(['held', 'forgotten', 'wrong-envelope'] as const)('lists retained E2EE Session templates with %s custody and allows locked deletion', async (custody) => {
        const previousState = storage.getState();
        const h = await createHarness('plain', custody === 'forgotten' ? {} : { historicalSecret: new Uint8Array(32).fill(7) });
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            h.automationRows.set('automation-retained', {
                ...triggerSetRow('automation-retained', ''), workflowDefinitionId: null,
                name: 'Old encrypted trigger', targetType: 'existingSession', existingSessionId: 'session-old',
                templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
                triggers: [storedTrigger('scheduled', scheduleTrigger)],
            });
            const encryption = await createEncryptionFromAuthCredentials({ token: h.account.credentials.token,
                secret: encodeBase64(new Uint8Array(32).fill(custody === 'wrong-envelope' ? 8 : 7), 'base64url') });
            const encryptedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(9),
                recipientPublicKey: encryption.contentDataKey, randomBytes: (length) => new Uint8Array(length).fill(3) }), 'base64');
            const request = runtimeFetch.getMockImplementation()!;
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            let retainedSessionReads = 0;
            const sessionBoundary = createSessionReadBatchHttpBoundary(request => {
                if (request.path === '/v2/sessions/session-old') {
                    retainedSessionReads += 1;
                    return json({ session: {
                    id: 'session-old', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                    encryptionMode: 'e2ee', metadata: 'encrypted-metadata', metadataVersion: 1,
                    agentState: null, agentStateVersion: 1, dataEncryptionKey: encryptedKey, share: null,
                    } });
                }
                return undefined;
            });
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                const target = new URL(String(url));
                if (target.pathname !== '/v2/sessions/read-batch' && target.pathname !== '/v2/sessions/session-old') return request(url, init);
                return await sessionBoundary.handle({ home: h.account.serverId, accountId, url: target,
                    path: target.pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers),
                    signal: init?.signal, body: init?.body ? JSON.parse(String(init.body)) : undefined }) ?? request(url, init);
            });
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                'session-old': createSessionFixture({ id: 'session-old', encryptionMode: 'e2ee', active: false, metadata: {
                    path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a', agent: 'codex', permissionMode: 'read-only' } }),
            } });
            const listed = await h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context);
            expect(listed).toMatchObject({ ok: true, result: { sets: [{ automationId: 'automation-retained',
                enabled: true, health: 'source_unavailable', legacy: { lockedReason: 'review_required' },
            }] } });
            expect(retainedSessionReads).toBe(0);
            expect(h.automationRows.get('automation-retained')).toMatchObject({ enabled: true,
                templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED });
            expect(h.automationRows.get('automation-retained')?.executionRecipe).toBeUndefined();
            const reviewed = await h.execute('workflow.trigger.list', { review: true, automationId: 'automation-retained' }, h.context);
            if (custody === 'held') {
                expect(reviewed).toMatchObject({ ok: true, result: { sets: [{ automationId: 'automation-retained', enabled: true,
                    health: 'available', target: { kind: 'inline' }, legacy: { lockedReason: 'review_required' },
                }] } });
            } else {
                expect(reviewed).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            }
            expect(h.automationRows.get('automation-retained')?.executionRecipe).toBeUndefined();
            // Lists and explicit review project retained content; only an explicit write converts it.
            expect(h.automationWrites).toEqual([]);
            if (custody !== 'held') {
                const removed = await h.execute('workflow.trigger.remove', { automationId: 'automation-retained', triggerId: 'scheduled' }, h.context);
                expect(removed).toMatchObject({ ok: true });
                expect(h.automationRows.get('automation-retained')?.triggers).toEqual([]);
            }
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });
    it.each([false, true])('cancels a retained Session read with its invocation while preserving a sibling=%s', async (withSibling) => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailability = isAppliedActiveServerRuntimeAvailable();
        const h = await createHarness('plain', { historicalSecret: new Uint8Array(32).fill(7) });
        const responseGate = createDeferred<void>();
        const started = createDeferred<AbortSignal>();
        const invocation = new AbortController();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        let review: ReturnType<typeof h.execute> | undefined;
        let sibling: Promise<unknown> | undefined;
        try {
            h.automationRows.set('automation-retained', {
                ...triggerSetRow('automation-retained', ''), workflowDefinitionId: null,
                name: 'Old encrypted trigger', targetType: 'existingSession', existingSessionId: 'session-old',
                templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
                triggers: [storedTrigger('scheduled', scheduleTrigger)],
            });
            const encryption = await createEncryptionFromAuthCredentials(h.account.credentials);
            const encryptedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(9),
                recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
            const request = runtimeFetch.getMockImplementation()!;
            const sessionBoundary = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/session-old'
                ? json({ session: { id: 'session-old', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                    encryptionMode: 'e2ee', metadata: 'encrypted-metadata', metadataVersion: 1,
                    agentState: null, agentStateVersion: 1, dataEncryptionKey: encryptedKey, share: null } }) : undefined);
            let sessionReads = 0;
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                const target = new URL(String(url));
                if (target.pathname !== '/v2/sessions/read-batch') return request(url, init);
                sessionReads += 1;
                if (!init?.signal) throw new Error('Expected the real Session read cancellation signal');
                started.resolve(init.signal);
                await responseGate.promise;
                return await sessionBoundary.handle({ home: h.account.serverId, accountId, url: target,
                    path: target.pathname, method: init.method ?? 'GET', headers: new Headers(init.headers),
                    signal: init.signal, body: JSON.parse(String(init.body)) }) ?? request(url, init);
            });
            publishAppliedActiveServerSnapshot({ serverId: h.account.serverId, serverUrl: h.home.serverUrl,
                generation: previousApplied.generation + 1 });
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId } });
            account = await captureLazyActionAccountContext(h.account.serverId, invocation.signal);
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            const execute = createFrontDoorActionExecute(createDefaultActionExecutor({
                workflowAction: h.createUiWorkflowAction({ account, transport: h.transport }),
            }));
            review = execute('workflow.trigger.list', { review: true, automationId: 'automation-retained' }, h.context);
            const physicalSignal = await started.promise;
            const writesBeforeRetirement = [...h.automationWrites];
            if (withSibling) {
                const { readSessionByIdHttp } = await import('@/sync/engine/sessions/sessionByIdHttp');
                sibling = readSessionByIdHttp({ sessionId: 'session-old', token: h.account.credentials.token,
                    accessProjectionVersion: 1, readTransport: h.account.readTransport,
                    request: (path, init) => h.account.request(path, init, { includeAuth: false }) });
            }
            publishAppliedActiveServerRuntimeAvailability(false);
            // Losing focused Sync transport does not revoke the captured Account.
            expect(account.accountLifetime.isCurrent()).toBe(true);
            expect(physicalSignal.aborted).toBe(false);
            invocation.abort();
            expect(account.accountLifetime.isCurrent()).toBe(false);
            expect(account.accountOnlyLifetime.isCurrent()).toBe(true);
            expect(physicalSignal.aborted).toBe(!withSibling);
            responseGate.resolve();
            expect(await review).toMatchObject({ ok: false });
            if (sibling) expect(await sibling).toMatchObject({ ok: true, status: 200 });
            expect(sessionReads).toBe(1);
            expect(h.automationWrites).toEqual(writesBeforeRetirement);
        } finally {
            responseGate.resolve();
            await Promise.allSettled([review, sibling]);
            account?.dispose();
            h.account.dispose();
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailability);
            storage.setState(previousState);
        }
    });
    it('projects predecessor rows without rewriting them or asking Channels to change their binding identity', async () => {
        const h = await createHarness();
        try {
            h.automationRows.set('automation-old', { id: 'automation-old', name: 'Old', description: null, enabled: true,
                targetType: 'newSession', existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
                assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] });
            const result = await h.execute('workflow.trigger.list', { scope: 'account_all' }, h.context);
            expect(result).toMatchObject({ ok: true, result: { sets: [{ automationId: 'automation-old', revision: 1, health: 'available' }] } });
            expect(h.automationRows.get('automation-old')).toMatchObject({ templateVersion: 1, templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN });
            expect(h.automationRows.get('automation-old')?.executionRecipe).toBeUndefined();
            expect(h.automationWrites).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('reads the %s Account census in one private detail page with shared currentness', async (mode) => {
        const duplicates: AutomationDefinitionListItem[] = [];
        const h = await createHarness(mode, { automations: duplicates });
        try {
            for (let index = 0; index < 6; index += 1) {
                expect(await h.execute('workflow.trigger.add', {
                    target: { kind: 'inline', definition }, project: { machineId: 'machine-a', directory: '/repo' },
                    trigger: scheduleTrigger,
                }, h.context)).toMatchObject({ ok: true });
            }
            if (mode === 'plain') {
                const legacy: AutomationDefinitionDetail = { ...triggerSetRow('census-legacy', ''), workflowDefinitionId: null, triggers: [],
                    targetType: 'newSession' as const, templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN };
                h.automationRows.set(legacy.id, legacy);
                // A repeated summary (for example across changing pages) must not race the same legacy write.
                duplicates.push(listedAutomation(legacy));
                h.automationRows.set('census-review', { ...triggerSetRow('census-review', ''), workflowDefinitionId: null, triggers: [],
                    targetType: 'existingSession', existingSessionId: 'session-old', templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED });
                h.automationRows.set('census-unavailable', { ...triggerSetRow('census-unavailable', ''), workflowDefinitionId: null, triggers: [],
                    executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null,
                        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } } });
            }
            const expectedIds = [...duplicates.map(row => row.id), ...h.automationRows.keys()]
                .filter((id, index, ids) => ids.indexOf(id) === index);
            const request = runtimeFetch.getMockImplementation()!;
            let currentnessReads = 0;
            const details: string[] = [];
            let detailPages = 0;
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption/currentness') {
                    currentnessReads += 1;
                }
                if (path === '/v3/automations/query' && JSON.parse(String(init?.body)).details === true) detailPages++;
                const id = path.startsWith('/v3/automations/') ? decodeURIComponent(path.slice('/v3/automations/'.length)) : null;
                if (!id || id === 'query' || init?.method === 'PUT') return request(url, init);
                details.push(id);
                return request(url, init);
            });
            const result = await h.execute('workflow.trigger.list', { scope: 'account_all' }, h.context);
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) throw new Error(JSON.stringify(result));
            const { WorkflowTriggerListResultV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
            const { sets } = WorkflowTriggerListResultV1Schema.parse(result.result);
            expect.soft(sets.map(set => set.automationId)).toEqual(expectedIds);
            expect.soft(details).toHaveLength(0);
            expect.soft(detailPages).toBe(1);
            // One fresh witness shared for opening, plus the fresh final disclosure check.
            expect.soft(currentnessReads).toBeLessThanOrEqual(2);
            if (mode === 'plain') {
                expect(sets.find(set => set.automationId === 'census-legacy')).toMatchObject({ revision: 1, health: 'available' });
                expect(sets.find(set => set.automationId === 'census-review')).toMatchObject({ enabled: true,
                    health: 'source_unavailable', legacy: { lockedReason: 'review_required' } });
                expect(sets.find(set => set.automationId === 'census-unavailable')).toMatchObject({ health: 'source_unavailable' });
                expect(h.automationWrites.filter(write => write.startsWith('reconcile:'))).toEqual([]);
            }
            // A later invocation must obtain its own authority rather than retain this census's snapshot.
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => new URL(String(url)).pathname === '/v1/account/encryption/currentness'
                ? json({ error: 'currentness_unavailable' }, 403) : request(url, init));
            expect(await h.execute('workflow.trigger.list', { scope: 'account_all' }, h.context)).toMatchObject({ ok: false });
        } finally { h.account.dispose(); }
    });
    it('converts an existing-Session predecessor using its current Agent and placement, not stale template defaults', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                'session-old': createSessionFixture({ id: 'session-old', active: false, metadata: {
                    path: '/current-session-path', host: 'host', homeDir: '/home', machineId: 'machine-a', agent: 'codex', permissionMode: 'read-only' } }),
            } });
            h.automationRows.set('automation-old', { id: 'automation-old', name: 'Old', description: null, enabled: true,
                targetType: 'existingSession', existingSessionId: 'session-old', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN,
                assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] });
            const result = await h.execute('workflow.trigger.list', { scope: 'account_all' }, h.context);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { sets: [{ context: { workspace: { directory: '/current-session-path' },
                inlineDefinition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    permissionMode: 'default', conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-a' } } } } }] } });
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });
    it('settles mounted active Session Habits through installed Account Channels while its Machine never acknowledges', async () => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'session-away-triggers';
        const daemonReply = createDeferred<unknown>();
        goalRpcBoundary = { issued: false, reply: daemonReply.promise };
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            const machine = createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 });
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: true,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: machine.id } }),
            }, machines: { [machine.id]: machine }, machineListByServerId: { [h.account.serverId]: [machine] } });
            expect(isMachineReachable(h.account.accountLifetime.scope, machine)).toBe(false);
            // The Home is reachable; only the away daemon cannot acknowledge its RPC.
            machineRpc.mockImplementation(() => daemonReply.promise);
            const projection = await installPullRequestProjection(h, sessionId);
            projection.setSessionProjection({ available: true, directory: '/repo', active: true });
            const triggerActions = await import('@/sync/domains/workflows/workflowTriggerActions');
            const sessionLists = vi.spyOn(triggerActions, 'listWorkflowTriggerPage');
            const accountLists = vi.spyOn(triggerActions, 'listWorkflowTriggerSets');
            const pullRequestLinks = [{ provider: 'github' as const, repository: 'happier-dev/happier', number: 42,
                url: 'https://github.com/happier-dev/happier/pull/42' }];
            projection.setLinks(pullRequestLinks);
            await expect(h.execute('workflow.trigger.add', { lifetimeSession: { sessionId }, target: { kind: 'inline', definition },
                trigger: scheduleTrigger }, h.context)).resolves.toMatchObject({ ok: true });
            hook = await renderHook(() => useSessionTriggers(sessionId));
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })], pullRequestLinks }));
            expect(sessionLists).toHaveBeenCalledTimes(1);
            expect(accountLists).toHaveBeenCalledTimes(1);
            projection.fail();
            await act(async () => hook!.getCurrent().retry());
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })],
                pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } }));
            projection.fail(false);
            projection.setLinks([]);
            await act(async () => hook!.getCurrent().retry());
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })], pullRequestLinks: [] }));
            expect(machineRpc).not.toHaveBeenCalled();
            expect(goalRpcBoundary.issued).toBe(false);
        } finally {
            await hook?.unmount();
            goalRpcBoundary = null;
            daemonReply.resolve({ ok: false, error: 'Machine away', errorCode: 'target_unavailable' });
            h.account.dispose();
            await connection?.dispose();
            storage.setState(previousState);
        }
    });

    it('refreshes a mounted session\'s PR links when its Channel binding changes without a trigger write', async () => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'session-pr-links';
        const pullRequest = { provider: 'github' as const, repository: 'happier-dev/happier', number: 42, url: 'https://github.com/happier-dev/happier/pull/42' };
        let pullRequestLinks: typeof pullRequest[] = [];
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            // Only Machine daemons are absent; this fixture's Home HTTP is reachable.
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: false,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }),
            }, machines: {}, machineListByServerId: {} });
            const projection = await installPullRequestProjection(h, sessionId);
            projection.setLinks(pullRequestLinks);
            const triggerActions = await import('@/sync/domains/workflows/workflowTriggerActions');
            // Publish the cursor of the same boundary snapshot that changed,
            // rather than replaying a cursor its initial read already covered.
            const changed = () => publishActivePluginCollectionChanges([{
                cursor: projection.changeCursor, kind: 'pluginDomain', entityId: 'pluginDomain/happier.channels/data-collection/channel-state', changedAt: projection.changeCursor,
                hint: { pluginDomain: 'dataCollection', pluginId: 'happier.channels', collectionId: 'channel-state',
                    contractDigest: 'a'.repeat(43), revision: projection.changeCursor, full: true },
            }]);
            const sessionLists = vi.spyOn(triggerActions, 'listWorkflowTriggerPage');
            hook = await renderHook(() => useSessionTriggers(sessionId));
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready', sets: [], pullRequestLinks: [] }));
            expect(sessionLists).toHaveBeenCalledTimes(1);
            pullRequestLinks = [pullRequest];
            projection.setLinks(pullRequestLinks);
            await act(async () => changed());
            await waitForHomeGovernance(() => expect(hook!.getCurrent().pullRequestLinks).toEqual([pullRequest]));
            expect(sessionLists).toHaveBeenCalledTimes(2);
            projection.setLinks([]);
            await act(async () => changed());
            await waitForHomeGovernance(() => expect(hook!.getCurrent().pullRequestLinks).toEqual([]));
            expect(sessionLists).toHaveBeenCalledTimes(3);
            expect(h.automationWrites).toEqual([]);
            await hook.unmount();
            hook = null;
            const readsBeforeUnmountedChange = runtimeFetch.mock.calls.length;
            await act(async () => changed());
            await flushHookEffects();
            expect(runtimeFetch.mock.calls.length).toBe(readsBeforeUnmountedChange);
        } finally {
            await hook?.unmount();
            await act(async () => { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it('surfaces a refused PR read observation without discarding readable session triggers or retrying it', async () => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'session-observer-refused';
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        // Mis-wire the real committed projection, leaving the installed registration intact.
        const unpublish = publishCommittedAppShellPluginUiProjection(() => null);
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: false,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }),
            }, machines: {}, machineListByServerId: {} });
            await installPullRequestProjection(h, sessionId, false);
            hook = await renderHook(() => useSessionTriggers(sessionId));
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                observationFailure: { code: 'contributed_action_unavailable', phase: 'observe', retryable: false },
                sets: [], pullRequestLinks: [] }));
            const queryCount = () => runtimeFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/plugins/data/query').length;
            const settledReads = queryCount();
            await act(async () => publishActivePluginCollectionChanges([{
                cursor: 1, kind: 'pluginDomain', entityId: 'pluginDomain/happier.channels/data-collection/channel-state', changedAt: 1,
                hint: { pluginDomain: 'dataCollection', pluginId: 'happier.channels', collectionId: 'channel-state',
                    contractDigest: 'a'.repeat(43), revision: 1, full: true },
            }]));
            await flushHookEffects();
            expect(queryCount()).toBe(settledReads);
        } finally {
            await hook?.unmount(); unpublish();
            await act(async () => { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it.each(['installed', 'replaced', 'absent', 'disabled'])('keeps Account triggers readable while cold contributed observation settles as %s', async (availability) => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'cold-contribution-session';
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId },
                sessions: {}, machines: {}, machineListByServerId: {} });
            const contributed = await installPullRequestProjection(h, sessionId, false);
            let settledProjection = availability === 'disabled' ? contributed.disable()
                : availability === 'installed' || availability === 'replaced' ? contributed.projection : null;
            const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
            const { CurrentUiContextBridge } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
            const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
            const reader = { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} };
            let published = false;
            function AppShell({ children }: React.PropsWithChildren) {
                const defaults = useAppShellPluginUiProjection();
                return React.createElement(AppShellPluginUiProjectionValueProvider, {
                    declarationReady: published, value: { ...defaults,
                        pluginUiProjection: published ? settledProjection : null,
                        phase: published ? 'current' : 'establishing', hasEstablishingMembers: !published,
                        interactionEnabled: published, serverId: h.account.serverId, accountLifetime: h.account.accountLifetime,
                        clientExecutableActivation: { status: published ? 'ready' : 'establishing' },
                    }, children: React.createElement(CurrentUiContextBridge, { publisher: null, reader,
                        children: React.createElement(React.Fragment, null, React.createElement(CurrentUiContextActionHost), children) }),
                });
            }
            // Observe public entry points without replacing their real behavior;
            // initial Sync's independent HTTP list is not this consumer's demand.
            const triggerActions = await import('@/sync/domains/workflows/workflowTriggerActions');
            const sessionLists = vi.spyOn(triggerActions, 'listWorkflowTriggerPage');
            const sessionListCount = () => sessionLists.mock.calls.filter(([request]) => 'lifetimeSession' in request).length;
            const accountListCount = () => sessionLists.mock.calls.filter(([request]) => 'scope' in request && request.scope === 'account_all').length;
            hook = await renderHook(() => useSessionTriggers(sessionId), { wrapper: AppShell });
            // Neither Account read waits for Session metadata or the contributed observer.
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status).toBe('ready'));
            expect(sessionListCount()).toBe(1);
            expect(accountListCount()).toBe(1);
            await act(async () => storage.getState().applySessions([createSessionFixture({ id: sessionId, active: false,
                metadataLayoutVersion: 1, ownerMetadataView: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' },
            })]));
            await flushHookEffects();
            // Account triggers are independently readable while contribution
            // discovery is still pending; only the observer waits for publication.
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().observationFailure).toBeNull();
            expect(sessionListCount()).toBe(1);
            expect(accountListCount()).toBe(1);
            // Sync hydration does not restart either settled trigger read.
            const { fetchAndApplyAutomations } = await import('@/sync/engine/automations/syncAutomations');
            await act(async () => { await fetchAndApplyAutomations({ credentials: h.account.credentials,
                applyAutomations: storage.getState().applyAutomations }); });
            if (availability === 'replaced') {
                const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
                await getInstalledPluginUiClientExecutableComposition().invalidatePlugin('happier.channels');
                // Publish a real successor through release admission, while the
                // cold consumer still awaits its declaration/registration pair.
                const successor = await installPullRequestProjection(h, sessionId, false, '99.0.1');
                settledProjection = successor.projection;
            }
            published = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                observationFailure: availability === 'installed' || availability === 'replaced' ? null
                    : { code: 'contributed_action_unavailable', phase: 'observe', retryable: false } }));
            expect(sessionListCount()).toBe(1);
            expect(accountListCount()).toBe(1);
            await hook.rerender();
            await act(async () => storage.setState({ endpointStatus: 'online' }));
            expect(sessionListCount()).toBe(1);
            expect(accountListCount()).toBe(1);
            if (availability === 'absent') {
                // A later declaration does not silently retry a settled
                // refusal. The existing Retry must attach and clear its band.
                settledProjection = contributed.projection;
                await hook.rerender();
                expect(hook.getCurrent().observationFailure?.code).toBe('contributed_action_unavailable');
                await act(async () => hook!.getCurrent().retry());
                await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({
                    status: 'ready', observationFailure: null,
                }));
            }
        } finally {
            await hook?.unmount();
            await act(async () => { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it.each(['session', 'directory', 'machine', 'foreign-machine'] as const)('settles cold Session Info without execution placement (%s)', async (missing) => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        const sessionId = 'session-trigger-hydration';
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionTriggers>>>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId },
                sessions: missing === 'session' ? {} : {
                    [sessionId]: createSessionFixture({ id: sessionId, active: false,
                        metadataLayoutVersion: 1,
                        ownerMetadataView: { path: missing === 'directory' ? '' : '/repo', host: 'host', homeDir: '/home',
                            ...(missing === 'machine' ? {} : { machineId: missing === 'foreign-machine' ? 'foreign-machine' : 'machine-a' }) },
                    }),
                }, machines: {}, machineListByServerId: {} });
            const projection = await installPullRequestProjection(h, sessionId);
            projection.setLinks([]);
            // Seed through the real trigger writer; only its HTTP persistence is synthetic.
            await expect(h.execute('workflow.trigger.add', { lifetimeSession: { sessionId }, target: { kind: 'inline', definition },
                trigger: scheduleTrigger }, h.context)).resolves.toMatchObject({ ok: true });
            projection.setSessionProjection({ available: missing !== 'session', directory: '',
                ...(missing === 'foreign-machine' ? { machineId: 'foreign-machine' } : {}) });
            // Finish the independently started Sync baseline before measuring
            // this mount. The controlled post-read hydration check below still
            // verifies that the same baseline does not restart settled reads.
            const { sync } = await import('@/sync/sync');
            await sync.refreshAutomations();
            const queryCount = () => runtimeFetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v3/automations/query'
                && init?.method === 'POST' && JSON.parse(String(init.body)).details === true).length;
            const beforeMount = queryCount();
            const requestsBeforeMount = runtimeFetch.mock.calls.length;
            hook = await renderHook(() => useSessionTriggers(sessionId));
            // The Account-owned lifetime selection needs no Session row, execution placement or daemon.
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status).not.toBe('loading'));
            expect(hook.getCurrent()).toMatchObject({ status: 'ready',
                sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })] });
            expect(queryCount() - beforeMount, JSON.stringify(runtimeFetch.mock.calls.slice(requestsBeforeMount)
                .filter(([url]) => new URL(String(url)).pathname === '/v3/automations/query')
                .map(([url, init]) => ({ home: new URL(String(url)).origin, query: JSON.parse(String(init?.body)) })))).toBe(2);
            projection.setSessionProjection({ available: true, directory: '/repo' });
            await act(async () => storage.getState().applySessions([createSessionFixture({ id: sessionId, active: false,
                metadataLayoutVersion: 1,
                ownerMetadataView: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' },
            })]));
            await flushHookEffects();
            // Trigger readiness and contributed links settle independently.
            await waitForHomeGovernance(() => expect(hook!.getCurrent()).toMatchObject({ status: 'ready',
                sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })], pullRequestLinks: [] }));
            // One Account list and one Session list, with no read on unrelated publication.
            expect(queryCount() - beforeMount).toBe(2);
            // Initial Sync can publish the same definitions after the opened
            // trigger lists have already answered. That is hydration, not a change.
            const { fetchAndApplyAutomations } = await import('@/sync/engine/automations/syncAutomations');
            const beforeSync = queryCount();
            await act(async () => { await fetchAndApplyAutomations({ credentials: h.account.credentials,
                applyAutomations: storage.getState().applyAutomations }); });
            await flushHookEffects();
            expect(queryCount() - beforeSync).toBe(0); // Sync's summary list needs no private trigger page.
            await act(async () => storage.setState({ endpointStatus: 'online' }));
            await hook.rerender();
            expect(queryCount() - beforeMount).toBe(2);
            await hook.unmount();
            hook = await renderHook(() => useSessionTriggers(sessionId));
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status).not.toBe('loading'));
            expect(hook.getCurrent().status).toBe('ready');
            expect(queryCount() - beforeMount).toBe(4);

            const triggerActions = await import('@/sync/domains/workflows/workflowTriggerActions');
            const sessionLists = vi.spyOn(triggerActions, 'listWorkflowTriggerPage');
            const accountLists = vi.spyOn(triggerActions, 'listWorkflowTriggerSets');
            const triggerId = hook.getCurrent().sets[0]!.triggers[0]!.id;
            // A real writer changes the stored trigger; Sync publishes its next
            // public revision through the same owner used on cold hydration.
            const changedTrigger = await h.execute('workflow.trigger.update', WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: hook.getCurrent().sets[0]!.automationId, triggerId,
                expectedRevision: hook.getCurrent().sets[0]!.revision, patch: { enabled: false } }), h.context);
            expect(changedTrigger.ok, JSON.stringify(Object.fromEntries(Object.entries(changedTrigger)
                .filter(([key]) => /code|phase|retry|kind/i.test(key))))).toBe(true);
            await act(async () => { await fetchAndApplyAutomations({ credentials: h.account.credentials,
                applyAutomations: storage.getState().applyAutomations }); });
            await waitForHomeGovernance(() => {
                expect(sessionLists).toHaveBeenCalledTimes(1);
                expect(accountLists).toHaveBeenCalledTimes(1);
                expect(hook!.getCurrent().sets[0]!.triggers[0]!.enabled).toBe(false);
            });

            const healthyRequest = runtimeFetch.getMockImplementation();
            if (!healthyRequest) throw new Error('HTTP boundary unavailable');
            runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => new URL(String(url)).pathname === '/v3/automations/query'
                ? json({ error: 'storage_unavailable' }, 503) : healthyRequest(url, init));
            await act(async () => hook!.getCurrent().retry());
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status).toBe('failed'));
            expect(hook.getCurrent().status).toBe('failed');
            const failedReads = queryCount();
            await hook.rerender();
            expect(queryCount()).toBe(failedReads);
            runtimeFetch.mockImplementation(healthyRequest);
            await act(async () => hook!.getCurrent().retry());
            await waitForHomeGovernance(() => expect(hook!.getCurrent().status, JSON.stringify({ status: hook!.getCurrent().status,
                observationFailure: hook!.getCurrent().observationFailure, reads: queryCount() - failedReads })).toBe('ready'));
            expect(hook.getCurrent().status).toBe('ready');
        } finally {
            await hook?.unmount();
            await act(async () => { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it.each(['prComment', 'ciFailed'] as const)('creates a scoped %s trigger from the pull request chosen in the trigger editor', async (kind) => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true, credentialKind: 'account' });
        const sessionId = 'session-pr-form';
        const pullRequest = { repository: 'happier-dev/happier', number: 42 };
        const pullRequestLinks = kind === 'ciFailed' ? [{ provider: 'github' as const, ...pullRequest, url: 'https://github.com/happier-dev/happier/pull/42' }] : [];
        const attachments: ReturnType<typeof SessionPullRequestBindingInputV1Schema.parse>[] = [];
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const workflowRequest = runtimeFetch.getMockImplementation();
            if (!workflowRequest || !h.account.serverIdentityId) throw new Error('Expected the current Workflow Home boundary');
            const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
            const externalAction = await createExternalActionAccountHttpBoundary({
                serverUrl: h.home.serverUrl, serverIdentityId: h.account.serverIdentityId, accountId,
                machineId: 'machine-a', actionId: 'action.invoke', tokenEpoch: 0,
                execute: (raw) => {
                    const invoked = getActionSpec('action.invoke').inputSchema.parse(raw);
                    if (invoked.action.pluginId !== PLUGIN_MANIFEST.id) throw new Error('Expected an invoked Channels Action');
                    const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === invoked.action.localId);
                    if (!declaration?.inputSchema || !declaration.resultSchema) throw new Error('Expected a declared Channels Action contract');
                    const input = invoked.input;
                    if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(declaration.inputSchema), input)
                        || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Channels Action fixture input');
                    let output: unknown;
                    if (input.kind === 'attach') {
                        attachments.push(SessionPullRequestBindingInputV1Schema.parse(input));
                        output = { kind: 'attached', bindingId: 'binding-pr-form' };
                    } else if (input.kind === 'removeTrigger') output = { kind: 'removed' };
                    else if (input.kind === 'get') output = { kind: 'ready', sessionId: input.sessionId, bindings: pullRequestLinks.map((link, index) => ({
                        bindingId: `binding-${index}`, revision: 1, link,
                        watch: { policy: { mode: 'off', archiveAfterMerge: false }, reason: null,
                            fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
                    })) };
                    else throw new Error('Unexpected Channels Action fixture operation');
                    if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(declaration.resultSchema), output)) throw new Error('Invalid Channels Action fixture output');
                    return output;
                },
            });
            const request = async (url: unknown, init?: RequestInit) => await externalAction.handle(new URL(String(url)), init)
                ?? workflowRequest(url, init);
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId }, sessions: {
                [sessionId]: createSessionFixture({ id: sessionId, active: false,
                    metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } }),
            }, machines: {}, machineListByServerId: {} });
            (await installPullRequestProjection(h, sessionId)).setLinks(pullRequestLinks);
            machineRpc.mockImplementation(async (request: Parameters<AccountActionTransport>[0]) => {
                if (request.method === 'scm.pullRequest.list') return ScmPullRequestListResponseSchema.parse({ success: true,
                    pullRequests: [{ provider: { kind: 'github', id: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
                        nameWithOwner: pullRequest.repository }, number: pullRequest.number, title: 'Fix CI',
                        url: 'https://github.com/happier-dev/happier/pull/42', baseBranch: 'main', headBranch: 'fix', state: 'open' }] });
                throw new Error(`Unexpected Machine RPC: ${request.method}`);
            });
            const listed = await listWorkflowTriggerPage({ lifetimeSession: { sessionId } }, { context: { externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } });
            expect(listed.pullRequestLinks).toEqual(pullRequestLinks);
            // The trigger editor's PR/CI row lists this Session's open pull requests through SCM while its menu is open.
            const initial = createDefaultWhen(kind, Array.isArray(listed.pullRequestLinks) ? listed.pullRequestLinks : []);
            let chosen = initial;
            function PullRequestBlock() {
                const [when, setWhen] = React.useState(initial);
                chosen = when;
                return React.createElement(WorkflowTriggerBlock, { testID: 'pr-block', title: kind, when, enabled: true,
                    incomplete: false, startOptions: [], onSelectStart: () => {}, onChangeWhen: setWhen, onRemove: () => {},
                    machineId: 'machine-a', serverId: h.account.serverId, sessionId });
            }
            screen = await renderScreen(React.createElement(PullRequestBlock));
            const picker = () => screen?.findAll((node) => node.props.testID === 'pr-block-pull-request'
                && typeof node.props.onOpenChange === 'function')[0];
            await waitForHomeGovernance(() => expect(picker()).toBeDefined());
            if (pullRequestLinks.length === 0) {
                expect(buildTriggerDefinition({ when: chosen, enabled: true, sessionId })).toBeNull();
                await act(async () => picker()?.props.onOpenChange(true));
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(picker()?.props.items.map((item: { id: string }) => item.id)).toContain('happier-dev/happier#42');
                });
                await act(async () => picker()?.props.onSelect('happier-dev/happier#42'));
            }
            expect(screen.getTextContent()).toContain('#42');
            const trigger = buildTriggerDefinition({ when: chosen, enabled: true, sessionId });
            const target = buildTriggerTarget({ kind: 'sendPrompt', prompt: 'Review this pull request' });
            if (!trigger || !target) throw new Error('Expected a complete PR trigger');
            await act(async () => { await addWorkflowTrigger({ target, trigger, inputs: {}, lifetimeSession: { sessionId } },
                { context: { externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } }); });
            expect([...h.automationRows.values()]).toEqual([expect.objectContaining({
                scopeSessionId: sessionId, triggers: [expect.objectContaining({ kind, sourceSessionId: sessionId, enabled: true })],
            })]);
            expect(attachments).toEqual([expect.objectContaining({ kind: 'attach', sessionId, pullRequest,
                target: expect.objectContaining({ triggerKind: kind }) })]);
        } finally {
            await act(async () => { screen?.unmount(); h.account.dispose(); await connection?.dispose(); storage.setState(previousState); });
        }
    });
    it('reads an execution notification source from its exact captured-Home machine, not the focused Home relay', async () => {
        const h = await createHarness();
        try {
            const source = { kind: 'execution_run' as const, machineId: 'machine-a', runId: 'execution-source' };
            h.transport.mockResolvedValue({ run: { runId: source.runId, callId: 'call-source', sidechainId: 'sidechain-source', intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'test' },
                permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                startedAtMs: 1, status: 'running' } });
            const added = await h.execute('workflow.trigger.add', {
                project: { machineId: 'machine-a', directory: '/repo' },
                target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'notify',
                    actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Finished' } } }] } },
                trigger: { kind: 'runLifecycle', source, condition: 'terminal', enabled: true },
            }, h.context);
            expect(h.transport, JSON.stringify(added)).toHaveBeenCalledWith(expect.objectContaining({
                serverId: h.account.serverId, accountId, machineId: source.machineId, method: 'execution.run.get',
            }));
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true, result: { set: { triggers: [{ source }] } } });
            expect(h.automationRows.size).toBe(1);
        } finally { h.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('authorizes the exact %s workflow Run before registering its notification source', async (mode) => {
        const h = await createHarness(mode);
        try {
            const added = await h.execute('workflow.trigger.add', {
                project: { machineId: 'machine-a', directory: '/repo' },
                target: { kind: 'inline', definition: { version: 1, blocks: [{
                    kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Finished' } },
                }] } },
                trigger: { kind: 'runLifecycle', source: { kind: 'workflow_run', runId }, condition: 'terminal', enabled: true },
            }, h.context);
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true, result: { set: { health: 'available', triggers: [{
                kind: 'runLifecycle', source: { kind: 'workflow_run', runId }, condition: 'terminal', remainingOccurrences: 1,
            }] } } });
            expect(h.operations).toContainEqual(expect.objectContaining({ operation: 'get', runId }));
            expect(h.automationRows.size).toBe(1);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it('lists the serving machine plugin projection alongside Account workflows and keeps saved reads available without it', async () => {
        const previousState = storage.getState();
        const h = await createHarness();
        try {
            // Native tests have no browser tab storage; select the serving Home
            // through its real device-scoped owner instead of a discarded tab id.
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            const machine = createMachineFixture({ id: 'workflow-plugin-machine', activeAt: Date.now(),
                daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
            storage.setState({ profileScope: { serverId: h.account.serverId, accountId } });
            storage.getState().applyMachines([machine], true, { sourceServerId: h.account.serverId });
            machineRpc.mockResolvedValue({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'example.recipe': { id: 'example.recipe', displayName: 'Example recipe', version: '1.2.3',
                    enabled: true, source: { kind: 'path', locator: '/plugins/example.recipe' } } },
                familiesById: { workflows: { family: 'workflows', entriesById: {
                    'example.recipe/review': { id: 'example.recipe/review', pluginId: 'example.recipe', pluginVersion: '1.2.3',
                        definition: { id: 'review', title: 'Plugin review', definition } },
                } } },
            }) });
            const definitionId = '00000000-0000-4000-8000-000000000013';
            await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Saved review' } }, h.context);
            const listed = await h.execute('workflow.definition.list', {}, h.context);
            expect(listed).toMatchObject({ ok: true, result: {
                definitions: [expect.objectContaining({ definitionId })], nextCursor: expect.any(String),
            } });
            if (!listed.ok) throw new Error('Expected the saved Workflow page');
            const cursor = WorkflowDefinitionListResultV1Schema.parse(listed.result).nextCursor;
            expect(await h.execute('workflow.definition.list', { cursor }, h.context)).toMatchObject({ ok: true, result: {
                definitions: [], pluginWorkflows: [{
                    workflow: 'plugin:example.recipe/review', pluginId: 'example.recipe', version: '1.2.3', title: 'Plugin review', definition,
                }],
            } });
            expect(h.artifacts.size).toBe(1);
            expect(h.transport).not.toHaveBeenCalled();
            // A replaced daemon invalidates the ready projection. Its failed
            // refresh must not promote retained inputs to a current source.
            const replacedMachine = { ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
                daemonState: { ...machine.daemonState, pid: 18 } };
            storage.getState().applyMachines([replacedMachine], false, { sourceServerId: h.account.serverId });
            machineRpc.mockRejectedValueOnce(new Error('machine_unreachable'));
            const unavailable = await h.execute('workflow.definition.list', {}, h.context);
            expect(unavailable).toMatchObject({ ok: true, result: { definitions: [expect.objectContaining({ definitionId })] } });
            expect(unavailable).not.toHaveProperty('result.pluginWorkflows');
            if (!unavailable.ok) throw new Error('Expected the saved Workflow page');
            const unavailableCursor = WorkflowDefinitionListResultV1Schema.parse(unavailable.result).nextCursor;
            expect(await h.execute('workflow.definition.list', { cursor: unavailableCursor }, h.context))
                .toMatchObject({ ok: true, result: { definitions: [] } });
            storage.getState().applyMachines([], true, { sourceServerId: h.account.serverId });
            await expect(h.execute('workflow.definition.list', {}, h.context)).resolves.toMatchObject({ ok: true,
                result: { definitions: [expect.objectContaining({ definitionId })] } });
        } finally { h.account.dispose(); storage.setState(previousState); }
    });
    it.each(['plain', 'e2ee'] as const)('saves a reviewed Run copy as one portable %s Artifact only on explicit create', async (mode) => {
        const h = await createHarness(mode);
        try {
            const acceptedDefinition = validateWorkflowDefinition({ ...definition,
                inputs: [{ name: 'topic', valueType: 'string', required: true }],
            }).normalizedDefinition!;
            const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: acceptedDefinition,
                admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
                context: {
                    source: { kind: 'inline' }, metadata: { title: 'Accepted title', description: 'Accepted description' },
                    inputs: { topic: 'private accepted input' }, machineId: 'machine-a', executionTarget: { kind: 'detached_run' },
                    workspaceTarget: { project: { machineId: 'machine-a', directory: '/private/repo', checkoutRootPath: '/private/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
                },
            });
            if (!accepted.ok) throw new Error(`reviewed_run_fixture_not_materialized:${accepted.error.code}`);
            const seed = buildWorkflowReviewedRunSeed({
                run: createWorkflowRunSummaryFixture({ id: runId, origin: { kind: 'direct' }, machineId: 'machine-a' }),
                definition: accepted.snapshot.definition,
                acceptedContext: { ...accepted.snapshot, metadata: accepted.snapshot.metadata ?? undefined },
            });
            const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'reviewed-copy', name: seed.name, definition: seed.definition });
            expect(h.artifacts.size).toBe(0);
            const reviewed = validateWorkflowEditorDraft({ ...draft, name: 'Edited title' });
            expect(reviewed.valid).toBe(true);
            const definitionId = '00000000-0000-4000-8000-000000000003';
            await expect(h.executeDefault('workflow.definition.create', {
                definitionId, definition: reviewed.normalizedDefinition!, metadata: { title: 'Edited title', description: 'Edited description' },
            }, h.context)).resolves.toMatchObject({ ok: true, result: { definitionId, metadata: { title: 'Edited title', description: 'Edited description' } } });
            expect(h.artifacts.size).toBe(1);
            const artifact = await h.account.workflowArtifacts.read(definitionId);
            expect(artifact?.header).toMatchObject({ metadata: { title: 'Edited title', description: 'Edited description' } });
            if (typeof artifact?.body !== 'string') throw new Error('expected a text Workflow definition');
            expect(JSON.parse(artifact.body)).toEqual({ kind: 'workflow-definition.v1', definition: reviewed.normalizedDefinition });
            expect(h.operations).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it.each([false, true])('settles workflow trigger cleanup before deleting the Artifact (cleanup failure: %s)', async (cleanupFailure) => {
        const definitionId = '00000000-0000-4000-8000-000000000002';
        const h = await createHarness('plain', { cleanupFailure, automations: [triggerSetRow('own-trigger-set', definitionId),
            triggerSetRow('session-trigger-set', definitionId, 'session-id'), triggerSetRow('other-workflow-set', runId)] });
        try {
            await expect(h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { definitionId } });
            const deletion = await h.execute('workflow.definition.delete', { definitionId }, h.context);
            if (cleanupFailure) {
                expect(deletion).toMatchObject({ ok: false });
                expect(h.artifacts.has(definitionId)).toBe(true);
                expect(h.deletedResources).toEqual([]);
            } else {
                expect(deletion).toEqual({ ok: true, result: { deleted: true, definitionId } });
                expect(h.deletedResources).toEqual(['own-trigger-set', 'session-trigger-set', definitionId]);
            }
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });
    it('refuses the Artifact delete if credentials retire while trigger cleanup settles', async () => {
        const definitionId = '00000000-0000-4000-8000-000000000004';
        const h = await createHarness('plain', { automations: [triggerSetRow('own-trigger-set', definitionId)],
            beforeAutomationDeleteResponse: async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, { token: 'replacement-account' })).toBe(true);
            },
        });
        try {
            await expect(h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { definitionId } });
            await expect(h.execute('workflow.definition.delete', { definitionId }, h.context)).resolves.toMatchObject({ ok: false });
            expect(h.deletedResources).toEqual(['own-trigger-set']);
            expect(h.artifacts.has(definitionId)).toBe(true);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });
    it.each(['local preference', 'workflow build policy', 'dependency build policy'] as const)(
        'refuses Workflow Actions when disabled by %s despite enabled Home bits', async (policy) => {
            const h = await createHarness('plain', { automationsEnabled: policy !== 'local preference' });
            try {
                const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
                expect(await getServerFeaturesSnapshot({ serverId: h.account.serverId }))
                    .toMatchObject({ status: 'ready' });
                if (policy !== 'local preference') {
                    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', policy === 'workflow build policy' ? 'workflows' : 'automations');
                }
                const outcomes = await Promise.all([
                    h.execute('workflow.definition.list', { workflow: 'plugin:external.recipe/missing' }, h.context),
                    h.execute('workflow.run.start', { runId, source: { kind: 'inline', definition } }, {
                        ...h.context, externalActionTarget: { kind: 'machine', machineId: 'machine-a',
                            project: { machineId: 'machine-a', directory: '/repo' } },
                    }),
                ]);
                expect(outcomes).toMatchObject([
                    { ok: false, errorCode: 'content_unavailable' },
                    { ok: false, errorCode: 'content_unavailable' },
                ]);
                expect(h.transport).not.toHaveBeenCalled();
                expect(h.operations).toEqual([]);
            } finally { vi.unstubAllEnvs(); h.account.dispose(); }
        },
    );

    it('uses the captured Home Account preference to admit enabled Workflow Actions', async () => {
        const h = await createHarness('plain', { automationsEnabled: true });
        try {
            const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
            expect(await getServerFeaturesSnapshot({ serverId: h.account.serverId }))
                .toMatchObject({ status: 'ready' });
            await expect(h.execute('workflow.definition.list', { workflow: 'plugin:external.recipe/missing' }, h.context))
                .resolves.toMatchObject({ ok: true, result: { definitions: [] } });
        } finally { h.account.dispose(); }
    });

    it('accepts the captured Home through its equivalent local profile id', async () => {
        const h = await createHarness('plain', { identity: true });
        try {
            expect(h.account.serverId).not.toBe(h.home.id);
            await expect(h.execute('workflow.definition.list', {}, { ...h.context, serverId: h.home.id }))
                .resolves.toMatchObject({ ok: true, result: { definitions: [] } });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it('retains host authorization for a non-present-user definition delete', async () => {
        const h = await createHarness();
        try {
            const context = { ...h.context, authority: 'account_automation' as const };
            await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.definition.delete', input: { definitionId: runId },
                context: { ...context, surface: 'agent', externalActionTarget: { kind: 'machine', machineId: 'relay-a' } },
            });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'relay-a', method: 'workflow.definition.delete' }));
            expect(h.deletedResources).toEqual([]);
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['account_directory', 'ephemeral_session_runner'] as const)('keeps %s credentials on their authorized host relay', async (credentialKind) => {
        const h = await createHarness('plain', { credentialKind });
        try {
            await h.createUiWorkflowAction({ account: h.account, transport: h.transport })({ actionId: 'workflow.definition.list', input: {},
                context: { ...h.context, externalActionTarget: { kind: 'machine', machineId: 'relay-a' } } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'relay-a', method: 'workflow.definition.list' }));
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('opens %s retained content and records controls on the captured Home with all daemons offline', async (mode) => {
        const h = await createHarness(mode);
        try {
            await expect(h.execute('workflow.definition.list', {}, h.context)).resolves.toMatchObject({ ok: true, result: { definitions: [] } });
            await expect(h.execute('workflow.run.get', { runId }, h.context)).resolves.toMatchObject({ ok: true, result: { definition } });
            await expect(h.execute('workflow.run.pause', { runId, expectedRevision: 1 }, h.context)).resolves.toMatchObject({ ok: true, result: { intent: 'pause_requested' } });
            await expect(h.execute('workflow.run.cancel', { runId, expectedRevision: 1 }, h.context)).resolves.toMatchObject({ ok: true, result: { intent: 'cancel_requested' } });
            expect(h.transport).not.toHaveBeenCalled();
            expect(h.operations.map((operation) => operation.operation)).toContain('get');
        } finally { h.account.dispose(); }
    });

    it('keeps starts on the exact Machine relay', async () => {
        const h = await createHarness();
        try {
            const target = { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } };
            await expect(h.execute('workflow.run.start', { runId, source: { kind: 'inline', definition } }, { ...h.context, externalActionTarget: target }))
                .resolves.toMatchObject({ ok: true, result: { admission: 'created' } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ serverId: h.account.serverId, accountId, machineId: 'machine-a',
                actionId: 'workflow.run.start', target, payload: { runId, source: { kind: 'inline', definition } } }));
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['retry', 'recover'] as const)('places retained Run %s on its recorded Machine instead of another reachable Account relay', async (operation) => {
        const h = await createHarness();
        const previousState = storage.getState();
        try {
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            const machines = ['relay-a', 'machine-a'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now(),
                createdAt: id === 'relay-a' ? 2 : 1,
                access: createPlainMachineRowFixture({ id, accountId }).access }));
            await publishMachineInventoryForTest(h.account, machines);
            const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
            expect(resolveUiAccountActionFallbackMachineId(h.account)).toBe('relay-a');
            const invocationId = '9e2f9bf7-58db-4fab-8f32-1b11b7bb6be5';
            const run = createWorkflowRunSummaryFixture({ id: runId, machineId: 'machine-a', state: 'running', revision: 6 });
            h.transport.mockImplementation(async request => request.machineId !== run.machineId
                ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
                : operation === 'retry'
                    ? { run, invocation: createWorkflowInvocationIndexFixture({ id: invocationId, runId, lifecycle: 'pending', attempt: '1' }), disposition: 'accepted' }
                    : { run, intent: 'resumed' });
            const execute = (machineId?: string) => {
                const context = machineId ? { ...h.context, externalActionTarget: { kind: 'machine' as const, machineId } } : h.context;
                return operation === 'retry'
                ? h.execute('workflow.run.invocations.retry', { runId, expectedRevision: 5,
                    invocation: { recordId: invocationId }, causalInvocationIds: [invocationId],
                    conversation: 'fresh_agent', input: { kind: 'original' } }, context)
                : h.execute('workflow.run.resume', { mode: 'recover', runId, expectedRevision: 5,
                    invocations: [{ kind: 'reattach', invocation: { recordId: invocationId } }] }, context);
            };
            await expect(execute('machine-a')).resolves.toMatchObject({ ok: true });
            await expect(execute('relay-a')).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            h.transport.mockClear();
            const result = await execute();
            expect(result).toMatchObject({ ok: true, result: { run: { id: runId, machineId: 'machine-a', state: 'running' } } });
            expect(h.transport.mock.calls[0]?.[0]).toMatchObject({ machineId: 'machine-a', target: { kind: 'machine', machineId: 'machine-a' } });
            expect(h.operations.filter(entry => entry.operation === 'get')).toHaveLength(1);
        } finally {
            storage.setState(previousState, true);
            h.account.dispose();
        }
    });

    it('uses an online relay when the first visible Machine is inactive', async () => {
        const h = await createHarness();
        const previousState = storage.getState();
        try {
            await upsertAndActivateServer({ serverUrl: h.home.serverUrl, scope: 'device' });
            const machines = [
                createMachineFixture({ id: 'stale', active: false, activeAt: 1, createdAt: 2,
                    access: createPlainMachineRowFixture({ id: 'stale', accountId }).access }),
                createMachineFixture({ id: 'online', active: true, activeAt: Date.now(), createdAt: 1,
                    access: createPlainMachineRowFixture({ id: 'online', accountId }).access }),
            ];
            await publishMachineInventoryForTest(h.account, machines);
            await expect(h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition } }), context: h.context,
            })).resolves.toMatchObject({ admission: 'created' });
            expect(h.transport.mock.calls[0]?.[0].machineId).toBe('online');
        } finally {
            storage.setState(previousState, true);
            h.account.dispose();
        }
    });

    it.each(['plain', 'e2ee'] as const)('preserves the %s Event declaration refusal through HTTP and the UI Workflow Action consumer', async mode => {
        const h = await createHarness(mode, { automationCreateRefusal: 'event_contribution_not_current' });
        try {
            const request = { target: { kind: 'inline' as const, definition: createWorkflowDefinitionFixture({
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            }) }, project: { machineId: 'machine-a', directory: '/repo' },
                trigger: { kind: 'pluginEvent', enabled: true,
                    eventRef: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
                    sourceInstanceId: 'environment:qa', sourceContractVersion: 1,
                    displayLabel: 'QA deployment',
                    sourceConfig: { environmentId: 'qa', serverId: h.home.id, periodMs: 1000, v: 1 },
                    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                        machineId: 'machine-a', materializationId: 'machine-services-a', pluginId: 'happier.machine.services',
                    } }, filter: null, maximumObservationAgeMs: null }, executionTarget: { kind: 'session' as const }, inputs: {}, approvalProfileId: null };
            expect(request).not.toBeNull();
            await expect(callWorkflowAction({ actionId: 'workflow.trigger.add', input: request,
                context: h.context, execute: h.execute, parseResult: WorkflowTriggerWriteResultV1Schema.parse,
            })).rejects.toMatchObject({ failure: { ok: false,
                errorCode: 'currentness_conflict', details: { reason: 'event_contribution_not_current' } } });
            expect(h.automationRows.size).toBe(0);
        } finally { h.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('manages a %s observation-only Event through the public Action front door without execution context', async (mode) => {
        const h = await createHarness(mode);
        try {
            const trigger = { kind: 'pluginEvent' as const, enabled: true,
                eventRef: { pluginId: 'example.events', localId: 'deployment-review' },
                sourceInstanceId: 'repository:42', sourceContractVersion: 1,
                sourceConfig: { repository: 'private/repository' }, displayLabel: 'Private repository',
                observationTransport: { kind: 'checkpointedPull' as const,
                    watcherMaterializationRef: { machineId: 'machine-a', materializationId: 'events-a', pluginId: 'example.events' } },
                filter: null, maximumObservationAgeMs: null };
            const added = WorkflowTriggerWriteResultV1Schema.parse((await h.execute('workflow.trigger.add', {
                observationOnly: { kind: 'observationOnly' }, trigger }, h.context) as { result: unknown }).result);
            const automationId = added.set.automationId;
            const triggerId = added.triggerId!;
            expect(added.set).toMatchObject({ observationOnly: { kind: 'observationOnly' }, health: 'available' });
            expect(added.set).not.toHaveProperty('target');
            expect(added.set).not.toHaveProperty('project');
            const stored = h.automationRows.get(automationId)!;
            expect(stored.assignments).toEqual([]);
            expect(stored).not.toHaveProperty('executionRecipe');
            const event = stored.triggers[0]!;
            if (event.kind !== 'pluginEvent') throw new Error('Expected Event projection');
            expect(JSON.parse(event.triggerDefinitionEnvelope)).toMatchObject({ t: mode === 'plain' ? 'plain' : 'encrypted' });
            await expect(h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context)).resolves.toMatchObject({ ok: true,
                result: { sets: [{ automationId, health: 'available', observationOnly: { kind: 'observationOnly' } }] } });
            for (const [index, enabled] of [false, true].entries()) {
                await expect(h.execute('workflow.trigger.update', { automationId, triggerId, expectedRevision: index + 1,
                    patch: { enabled } }, h.context)).resolves.toMatchObject({ ok: true,
                    result: { set: { triggers: [{ id: triggerId, enabled }], observationOnly: { kind: 'observationOnly' } } } });
            }
            const { enabled: _enabled, ...moved } = trigger;
            await expect(h.execute('workflow.trigger.update', { automationId, triggerId, expectedRevision: 3,
                patch: { trigger: { ...moved, observationTransport: { ...trigger.observationTransport,
                    watcherMaterializationRef: { ...trigger.observationTransport.watcherMaterializationRef, machineId: 'machine-b' } } } } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { set: { triggers: [{ observation: { watcher: { machineId: 'machine-b' } } }] } } });
            expect(h.automationRows.get(automationId)?.assignments).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
            expect(h.operations).toEqual([]);
        } finally { h.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('privately retains and retires a %s shared Machine schedule without relaying Account authoring', async (mode) => {
        const h = await createHarness(mode, { sharedMachine: true });
        machineRpc.mockResolvedValue({ ok: true });
        try {
            const definitionId = '00000000-0000-4000-8000-000000000005';
            await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context);
            const added = await h.execute('workflow.trigger.add', { workflow: definitionId,
                project: { machineId: 'machine-a', directory: '/repo' }, trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true });
            const { set: { automationId }, triggerId } = WorkflowTriggerWriteResultV1Schema.parse(
                (added as { result: unknown }).result);
            const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
            const retained = machineRpc.mock.calls[0]?.[0];
            expect(retained).toMatchObject({ machineId: 'machine-a', requireEncryptedPayload: true });
            expect(JSON.stringify(retained)).not.toContain(h.account.credentials.token);
            const opened = openSessionRequesterBootstrapRpcRequestV1({ request: retained.payload,
                machineId: 'machine-a', installationId: 'test-installation', installationPrivateKey: receiver.secretKey });
            expect(opened).toMatchObject({ scope: 'workflow_trigger', input: { scopeId: triggerId, automationId, operation: 'retain' },
                requesterBootstrap: { credentials: { token: h.account.credentials.token } } });
            expect(h.automationRows.has(automationId)).toBe(true);
            await expect(h.execute('workflow.trigger.update', { automationId, triggerId, expectedRevision: 1,
                patch: { enabled: false } }, h.context)).resolves.toMatchObject({ ok: true });
            const retired = machineRpc.mock.calls.at(-1)?.[0];
            expect(openSessionRequesterBootstrapRpcRequestV1({ request: retired.payload, machineId: 'machine-a',
                installationId: 'test-installation', installationPrivateKey: receiver.secretKey })).toMatchObject({
                scope: 'workflow_trigger', input: { scopeId: triggerId, operation: 'retire' } });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it('retires shared Machine trigger custody when deleting its saved Workflow', async () => {
        const h = await createHarness('plain', { sharedMachine: true });
        machineRpc.mockResolvedValue({ ok: true });
        try {
            const definitionId = '00000000-0000-4000-8000-000000000005';
            await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context);
            const added = await h.execute('workflow.trigger.add', { workflow: definitionId,
                project: { machineId: 'machine-a', directory: '/repo' }, trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true });
            const { set: { automationId }, triggerId } = WorkflowTriggerWriteResultV1Schema.parse(
                (added as { result: unknown }).result);
            await expect(h.execute('workflow.definition.delete', { definitionId }, h.context))
                .resolves.toMatchObject({ ok: true, result: { deleted: true } });
            expect(h.automationRows.has(automationId)).toBe(false);
            expect(h.artifacts.has(definitionId)).toBe(false);
            const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
            const retired = machineRpc.mock.calls.at(-1)?.[0];
            expect(openSessionRequesterBootstrapRpcRequestV1({ request: retired.payload, machineId: 'machine-a',
                installationId: 'test-installation', installationPrivateKey: receiver.secretKey })).toMatchObject({
                scope: 'workflow_trigger', input: { scopeId: triggerId, operation: 'retire' } });
            expect(h.transport).not.toHaveBeenCalled();
        } finally { h.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('lists, adds, updates and removes %s Account triggers with no Machine', async (mode) => {
        const h = await createHarness(mode);
        try {
            // Child edits are direct; deleting the whole Habit retains native confirmation.
            const { Modal } = await import('@/modal');
            const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
            const definitionId = '00000000-0000-4000-8000-000000000005';
            const project = { machineId: 'machine-a', directory: '/repo' };
            const created = await h.execute('workflow.definition.create', { definitionId, definition, metadata: { title: 'Workflow' } }, h.context);
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
            const added = await h.execute('workflow.trigger.add', { workflow: definitionId, project, trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true, result: { set: { health: 'available', project, target: { kind: 'workflow', ref: definitionId } } } });
            const automationId = (added as { result: { set: { automationId: string } } }).result.set.automationId;
            const triggerId = (added as { result: { triggerId: string } }).result.triggerId;
            const stored = h.automationRows.get(automationId)!;
            // The set context is sealed with the caller Account's current material.
            expect(stored.executionRecipe).toMatchObject({ v: 2, workflow: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
            await expect(h.execute('workflow.trigger.list', { workflow: definitionId }, h.context)).resolves.toMatchObject({ ok: true,
                result: { sets: [{ automationId, health: 'available', triggers: [{ id: triggerId, enabled: true }] }] } });
            await expect(h.execute('workflow.trigger.update', { automationId, triggerId, expectedRevision: 1, patch: { enabled: false } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { set: { automationId, triggers: [{ id: triggerId, enabled: false }] } } });
            await expect(h.execute('workflow.trigger.remove', { automationId, triggerId }, h.context))
                .resolves.toMatchObject({ ok: true, result: { set: { automationId, triggers: [] } } });
            expect(confirmation).not.toHaveBeenCalled();
            expect(h.automationWrites).toEqual([`create:${automationId}`, `reconcile:${automationId}`, `reconcile:${automationId}`]);
            expect(h.transport).not.toHaveBeenCalled();
            await expect(h.execute('workflow.trigger.remove', { automationId }, h.context))
                .resolves.toMatchObject({ ok: true, result: { automationId, deleted: true } });
            expect(confirmation).toHaveBeenCalled();
            expect(h.deletedResources).toEqual([automationId]);
        } finally { h.account.dispose(); }
    });

    it('refuses trigger reads and writes when the captured Account retires mid-operation', async () => {
        const definitionId = '00000000-0000-4000-8000-000000000006';
        const h = await createHarness('plain', { beforeAutomationListResponse: async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, { token: 'replacement-account' })).toBe(true);
        } });
        try {
            await expect(h.execute('workflow.trigger.list', { scope: 'account_inline' }, h.context)).resolves.toMatchObject({ ok: false });
            await expect(h.execute('workflow.trigger.add', { workflow: definitionId, project: { machineId: 'machine-a', directory: '/repo' },
                trigger: scheduleTrigger }, h.context)).resolves.toMatchObject({ ok: false });
            expect(h.automationWrites).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });

    it('lists session triggers through Account Channels with every daemon offline and preserves a failed link read', async () => {
        const previousState = storage.getState();
        const h = await createHarness('plain', { identity: true });
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            const request = runtimeFetch.getMockImplementation();
            if (!request) throw new Error('Expected the Workflow HTTP boundary');
            await loadSyncSingletonForTests();
            connection = await h.restoreAccount(request);
            runtimeFetch.mockImplementation(request);
            storage.setState({ endpointStatus: 'online', profileScope: { serverId: h.account.serverId, accountId } });
            storage.getState().applySessions([createSessionFixture({ id: 'session-closed', active: false,
                metadataLayoutVersion: 1,
                metadata: { name: 'Session' } as ReturnType<typeof createSessionFixture>['metadata'],
                ownerMetadataView: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine-a' } as ReturnType<typeof createSessionFixture>['metadata'] })]);
            storage.setState({ machines: {}, machineListByServerId: {} });
            h.transport.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
            machineRpc.mockRejectedValue(new Error('Daemon offline'));
            const projection = await installPullRequestProjection(h, 'session-closed');
            const target = { kind: 'inline' as const, definition };
            const added = await h.execute('workflow.trigger.add', { lifetimeSession: { sessionId: 'session-closed' }, target,
                trigger: scheduleTrigger }, h.context);
            expect(added).toMatchObject({ ok: true });
            const pullRequestLinks = [{ provider: 'github' as const, repository: 'happier-dev/happier', number: 42, url: 'https://github.com/happier-dev/happier/pull/42' }];
            projection.setLinks(pullRequestLinks);
            h.account.assertCurrent();
            const listed = await h.execute('workflow.trigger.list', { lifetimeSession: { sessionId: 'session-closed' } }, h.context);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { lifetimeSession: { sessionId: 'session-closed' }, sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })], pullRequestLinks } });
            projection.setLinks([...pullRequestLinks, ...pullRequestLinks]);
            await expect(h.execute('workflow.trigger.list', { lifetimeSession: { sessionId: 'session-closed' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { pullRequestLinks } });
            projection.setLinks([]);
            await expect(h.execute('workflow.trigger.list', { lifetimeSession: { sessionId: 'session-closed' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { pullRequestLinks: [] } });
            projection.fail();
            await expect(h.execute('workflow.trigger.list', { lifetimeSession: { sessionId: 'session-closed' } }, h.context))
                .resolves.toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ triggers: [expect.objectContaining({ kind: 'schedule' })] })],
                    pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } } });
            expect(h.transport).not.toHaveBeenCalled();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { h.account.dispose(); await connection?.dispose(); storage.setState(previousState); }
    });

    it('routes agent trigger writes to the host that owns agent policy, and refuses typed with no Machine', async () => {
        const h = await createHarness();
        try {
            const context = { ...h.context, authority: 'account_automation' as const };
            const executeCaptured = h.createUiWorkflowAction({ account: h.account, transport: h.transport });
            await executeCaptured({ actionId: 'workflow.trigger.update', input: WorkflowTriggerUpdateRequestV1Schema.parse({
                automationId: 'automation-a', triggerId: 'trigger-a', expectedRevision: 3, patch: { enabled: false },
            }), context: { ...context, surface: 'agent', externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } });
            expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a', method: 'workflow.trigger.update' }));
            await expect(executeCaptured({ actionId: 'workflow.trigger.add', input: {
                workflow: '00000000-0000-4000-8000-000000000007', project: { machineId: 'machine-a', directory: '/repo' }, trigger: scheduleTrigger,
            }, context: { ...context, surface: 'agent' } })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(h.automationWrites).toEqual([]);
            expect(h.transport).toHaveBeenCalledTimes(1);
        } finally { h.account.dispose(); }
    });

    it('refuses malformed content and mismatched Account scope before disclosure', async () => {
        const h = await createHarness('e2ee', { malformed: true });
        try {
            await expect(h.execute('workflow.run.get', { runId }, h.context)).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            // The mounted family owns this captured lifetime. The default factory
            // intentionally captures the caller's explicit Home afresh instead.
            const executeCaptured = h.createUiWorkflowAction({ account: h.account, transport: h.transport });
            await expect(executeCaptured({ actionId: 'workflow.definition.list', input: {}, context: { ...h.context, serverId: 'other-home' } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            await expect(executeCaptured({ actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 1 }, context: { ...h.context, runtimeAccountId: 'other-account' } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(h.operations).toEqual([
                { operation: 'get', runId },
            ]);
        } finally { h.account.dispose(); }
    });

    it('fails locked E2EE material closed after an opaque Run read without private disclosure or mutation', async () => {
        const h = await createHarness('e2ee', { locked: true });
        const { settings, settingsScope } = storage.getState();
        try {
            // This mounted reader has already hydrated feature preferences.
            // Cold settings bootstrap is a distinct prerequisite, exercised below.
            storage.setState({ settingsScope: h.account.accountLifetime.scope, settings: settingsParse({}) });
            await expect(h.createUiWorkflowAction({ account: h.account, transport: h.transport })({
                actionId: 'workflow.run.get', input: { runId }, context: h.context,
            })).resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
            // The authorized read supplies the Run owner's mode and opaque
            // envelopes. Locked material must prevent opening or returning them,
            // and must stop before recipient census/preparation or mutation.
            expect(h.operations).toEqual([{ operation: 'get', runId }]);
            storage.setState({ settings, settingsScope });
            // Default settings bootstrap precedes Workflow dispatch. Its missing
            // material rejection is fail-closed, not a Workflow typed result.
            await expect(h.executeDefault('workflow.run.get', { runId }, h.context)).rejects.toBeInstanceOf(Error);
            expect(h.operations).toEqual([{ operation: 'get', runId }]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally { storage.setState({ settings, settingsScope }); h.account.dispose(); }
    });

    it('retires captured credentials before later mutation', async () => {
        const h = await createHarness();
        try {
            expect(await TokenStorage.setCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId }, {
                token: createAccountTokenForTests('replacement-account'),
            })).toBe(true);
            await expect(h.execute('workflow.run.cancel', { runId, expectedRevision: 1 }, h.context))
                .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(h.operations).toEqual([]);
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            h.account.dispose();
            await TokenStorage.removeCredentialsForServerUrl(h.home.serverUrl, { serverId: h.account.serverId });
        }
    });
});
