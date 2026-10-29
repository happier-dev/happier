import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildConnectedServiceCredentialRecord,
    QualifiedConnectedAccountCredentialSnapshotV4Schema,
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountGroupActiveAccountV4Schema,
    QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
    sealQualifiedConnectedAccountContentEnvelope,
    openQualifiedConnectedAccountContentEnvelope,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceBindingsV2Schema,
    type QualifiedConnectedAccountCredentialMetadataV4,
    QualifiedConnectedAccountRefSchema,
    sameQualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type { AgentExecutionRunOpenRequest, AgentRuntime, AgentSessionOpenRequest, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginJsonRpcClient, PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';

import type { ApiClient } from '@/api/api';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { parseQualifiedConnectedAccountCredentialPlaintextV1, projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountRefreshLeaseV4Schema } from '@happier-dev/protocol';
import { ConnectedServiceRefreshCoordinator } from '../refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import { createNativeAgentExecutionRunContextLeaseFactory, createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { resolveBackendEngineAdapterResolution, resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { resolveEngineAdapterResolutionFromRegistry } from '@/agent/runtime/registry/engineRegistry/resolution';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import type { NativeAgentSessionInteractionHostBinding } from '@/agent/runtime/registry/engineRegistryTypes';
import { createExecutionRunRuntime } from '@/agent/runtime/bridges/executionRun/runtime/create';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ExecutionRunRejectedStartError } from '@/agent/runtime/bridges/executionRun/errors';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createUnavailablePluginServices, PLUGIN_SERVICE_UNAVAILABLE_CODE } from '@/plugins/runtime/invocation/services/unavailable';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, serializeConnectedServiceChildSelectionValues } from '../connectedServiceChildEnvironment';
import { getConnectedServiceRuntimeAuthAdapter, classifyConnectedServiceRuntimeFailureForTarget } from '../catalogHooks';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { createExecutionRunConnectedServicesBridge } from './executionRunMaterialization';
import type { ConnectedServiceRunMaterializationHandlerResult } from './materializeContract';
import type { ConnectedServiceDaemonAuthBridgeRegistration } from '../daemonAuthBridgeTypes';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from '../sessionRuntimeAuthRefresh';
import { ConnectedServiceRuntimeAuthRefreshSelectionSchema } from '../runtimeAuthRefreshAuthorization';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { requestExecutionRunConnectedServicesMaterialization, requestExecutionRunConnectedServiceRuntimeAuthRefresh } from '@/daemon/controlClient';
import { deriveConnectedServiceRunMaterializeToken } from './capabilityToken';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import * as runtimeRecovery from '../runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from '../runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '../runtimeAuth/temporaryThrottleRetryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { connectedServiceRecoveryScopeKey } from '../runtimeRegistry/target';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const serviceId = 'happier.agent.codex/openai-codex';
const modelId = 'gpt-6.1-sol';
const memberIds = ['first', 'second', 'third'];
const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
const runId = 'composed-model-run';
const runnerPid = 4242;
type Materialization = Extract<ConnectedServiceRunMaterializationHandlerResult, { ok: true }>;

function createCodexProcessBoundary(rejectStart: boolean) {
    const rpcRequests: Array<{ method: string; params: unknown }> = [];
    const listeners = new Set<Parameters<PluginJsonRpcClient['onNotification']>[0]>();
    let activeAccountId: string | null = null;
    const result: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode('realtime_conversation under development false\n'), stderr: new Uint8Array(),
        stdoutTruncated: false, stderrTruncated: false };
    let settleExit!: (result: PluginProcessResult) => void;
    const exit = new Promise<PluginProcessResult>((resolve) => { settleExit = resolve; });
    const client: PluginJsonRpcClient = {
        async request(method, params): Promise<JsonValue> {
            rpcRequests.push({ method, params });
            if (method === 'thread/start') {
                if (rejectStart) throw Object.assign(new Error(`model '${modelId}' is not enabled in rustponsesapi`), {
                    name: 'JsonRpcApplicationError', method, code: -32000,
                });
                return { threadId: 'provider-thread' };
            }
            if (method === 'turn/start') return { turnId: 'provider-turn' };
            if (method === 'model/list' || method === 'collaborationMode/list' || method === 'experimentalFeature/list') return { data: [] };
            if (method === 'account/login/start') {
                if (!params || typeof params !== 'object' || Array.isArray(params)
                    || !('type' in params) || params.type !== 'chatgptAuthTokens'
                    || !('accessToken' in params) || typeof params.accessToken !== 'string'
                    || !('chatgptAccountId' in params) || typeof params.chatgptAccountId !== 'string') throw new Error('Unexpected fixture login request');
                activeAccountId = params.chatgptAccountId;
                return { type: 'chatgptAuthTokens' };
            }
            if (method === 'account/read') return { account: activeAccountId ? { id: activeAccountId } : null };
            if (method === 'account/rateLimits/read') return { rateLimits: {} };
            return {};
        },
        notify: async () => undefined,
        onRequest: () => ({ dispose() {} }),
        onNotificationReceived(listener) {
            const observe: Parameters<PluginJsonRpcClient['onNotification']>[0] = message => {
                listener({ ...message, receivedAtMs: Date.now() });
            };
            listeners.add(observe);
            return { dispose() { listeners.delete(observe); } };
        },
        onNotification(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        dispose: async () => undefined,
    };
    const handle: PluginProtocolClientHandle<'jsonRpc'> = { client,
        process: { write: async () => undefined, closeStdin: async () => undefined,
            wait: () => exit, onOutput: () => ({ dispose() {} }), dispose: async () => { settleExit(result); } },
        wait: () => exit, dispose: async () => { settleExit(result); } };
    return {
        rpcRequests,
        // Only the external process/JSON-RPC transport is substituted; the admitted
        // Codex producer, startup acceptance and failure classifier remain real.
        exec: { run: async () => result,
            systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: '/fixture/codex' }) },
            clients: { spawn: async () => handle } } as unknown as ExecService,
        async finish(acceptedFailure: boolean) {
            if (acceptedFailure) for (const listener of listeners) await listener({ method: 'item/agentMessage/delta',
                params: { threadId: 'provider-thread', turnId: 'provider-turn', itemId: 'answer', delta: 'accepted work' } });
            for (const listener of listeners) await listener({ method: 'turn/completed', params: { threadId: 'provider-thread',
                turn: { id: 'provider-turn', status: acceptedFailure ? 'failed' : 'completed',
                    ...(acceptedFailure ? { error: { message: `model '${modelId}' is not enabled in rustponsesapi` } } : {}) } } });
        },
    };
}

async function createScenario() {
    const root = await mkdtemp(join(tmpdir(), 'happier-run-model-proof-'));
    const baseDir = join(root, 'materialized');
    const credentials = { token: 'test-server-token', encryption: null };
    let nowMs = 1_000;
    let recoveryResumePromptMode: 'off' | 'standard' | 'custom' = 'standard';
    let recoveryCustomResumePrompt: string | null = null;
    let reportArmed: (() => void) | null = null;
    const switchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({ nowMs: () => nowMs, windowMs: 3_600_000 });
    const recoveryScheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({ nowMs: () => nowMs, random: () => 0.5,
        store: createRecoveryIntentFileStore(join(root, 'recovery.json')),
        onStateChange: (_key, intent) => { if (intent?.scope?.kind === 'run' && intent.status === 'waiting') reportArmed?.(); },
        resume: async () => { throw new Error('Run recovery must not resume a Session'); } });
    let currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: { service, groupId: 'pool' }, incarnation: 'pool-row', displayName: 'Pool',
        policy: { autoSwitch: true, maxSwitchesPerTurn: 1, maxSwitchesPerSessionHour: 1 },
        activeConnectedAccountId: memberIds[0], generation: 7, runtimeStateRevision: 0, state: {},
        createdAt: 1, updatedAt: 1,
        members: memberIds.map((connectedAccountId, priority) => ({
            v: 1, connectedAccountId, priority, enabled: true, state: {}, createdAt: 1, updatedAt: 1,
        })),
    });
    const initialGroup = currentGroup;
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service,
        accounts: memberIds.map((accountId) => ({
            ref: { service, accountId }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationReady: true, configurationRevision: null, scopes: [],
        })),
    });
    const records = new Map(memberIds.map((profileId) => [profileId, buildConnectedServiceCredentialRecord({
        now: 1, serviceId: 'openai-codex', profileId, kind: 'oauth', expiresAt: null,
        oauth: { accessToken: `test-access-${profileId}`, refreshToken: `test-refresh-${profileId}`, idToken: null,
            scope: null, tokenType: null, providerAccountId: `test-account-${profileId}`, providerEmail: null },
    })]));
    const initialRecords = new Map(records);
    const credentialReads: QualifiedConnectedAccountRef[] = [];
    let credentialGate: Readonly<{ entered(signal?: AbortSignal): Promise<void> }> | null = null;
    const credentialRevisions = new Map(memberIds.map((profileId) => [profileId, revision]));
    const credentialMetadata = new Map<string, QualifiedConnectedAccountCredentialMetadataV4>(
        memberIds.map((profileId) => [profileId, { scopes: [] }]));
    const runtimeTargetRegistry = new ConnectedServiceRuntimeRegistry();
    // The API responses are the external Home/credential transport boundary. Selection,
    // envelope opening, purpose admission, plugin materialization and pool state stay real.
    const api = {
        getAccountEncryptionMode: async () => 'plain',
        getConnectedServiceCredentialPlain: async (input: { profileId: string }) => {
            return { revisionSemantics: 'revisioned', credentialRevision: credentialRevisions.get(input.profileId),
                content: { t: 'plain', v: records.get(input.profileId) } };
        },
    } as unknown as ApiClient;
    const readCredential = async ({ ref, signal }: { ref: QualifiedConnectedAccountRef; signal?: AbortSignal }) => {
        credentialReads.push(QualifiedConnectedAccountRefSchema.parse(ref));
        await credentialGate?.entered(signal);
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: credentialRevisions.get(ref.accountId), configurationRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: records.get(ref.accountId), randomBytes: (length) => new Uint8Array(length) }),
            metadata: credentialMetadata.get(ref.accountId),
        });
    };
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController, credentials,
        getAccountEncryptionMode: async () => 'plain',
        readCredential,
        configuration: { read: async () => null, secrets: {
            admit: async () => undefined, has: async () => false, read: async () => null,
        } },
    });
    const purposeOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }),
            update: async (mutate) => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('No interactive selection in a finite Run'); },
        resolveTarget: async (target) => ({ displayName: 'Fixture account',
            account: target.kind === 'account' ? target.account
                : { service, accountId: currentGroup.activeConnectedAccountId! },
            ...(target.kind === 'group' ? { group: { groupId: 'pool', generation: currentGroup.generation } } : {}),
        }),
        materializeAccount: async ({ account, request, credentialRevisionBasis, signal }) => {
            const receipt = await established.invokeWithReceipt({ account, operation: { kind: 'materialize', request }, signal });
            credentialRevisionBasis?.captureCredentialRevision(receipt.basis.credentialRevision);
            return receipt.result;
        },
        resolveCredentialRevision: async (account, signal) => established.readCredentialRevision({ account, signal }),
        projectTargetAccounts: async () => { throw new Error('No account listing in this recipe'); },
        assertTargetAccountMaterializable: async () => { throw new Error('No listed account materialization in this recipe'); },
    });
    let providerExchanges = 0;
    let providerGate: Promise<void> | null = null;
    let providerEntered: (() => void) | null = null;
    const runtimeLease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: root, pluginIds: ['happier.agent.codex'], connectedAccounts: purposeOwner,
            scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
            qualifiedConnectedAccountEstablishedRuntimeOwner: established,
            networkDependencies: {
                resolveNetworkAddresses: async () => ['8.8.8.8'],
                openPinnedStream: async (request) => {
                    if (request.url !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected provider transport');
                    providerExchanges += 1;
                    providerEntered?.();
                    await providerGate;
                    const body = new TextEncoder().encode(JSON.stringify({ access_token: `refreshed-access-${providerExchanges}`,
                        refresh_token: `refreshed-refresh-${providerExchanges}`, id_token: 'fixture-id-token', expires_in: 3600 }));
                    let delivered = false;
                    return { status: 200, headers: {}, contentLength: body.length,
                        read: async () => { if (delivered) return null; delivered = true; return body; }, cancel() {} };
                },
            },
            resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
                registeredRootId: `composed-run-fixture:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
        }),
    });
    const commits: string[] = [];
    // Resolve the runtime before another Connected Account consumer warms its
    // catalog, as detached admission does on a cold daemon.
    const engine = await resolveBackendEngineAdapterResolution('codex');
    if (!engine) throw new Error('Admitted Codex engine unavailable');
    const authAdapter = await getConnectedServiceRuntimeAuthAdapter('codex');
    if (!authAdapter) throw new Error('Admitted Codex classifier unavailable');
    const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
        token: credentials.token, quotaFreshnessMs: 60_000, nowMs: () => nowMs,
        api: {
            readGroup: async () => currentGroup, listAccounts: async () => accounts,
            setActiveAccount: async (input) => {
                const mutation = QualifiedConnectedAccountGroupActiveAccountV4Schema.parse(input.mutation);
                commits.push(mutation.connectedAccountId);
                currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup,
                    activeConnectedAccountId: mutation.connectedAccountId, generation: currentGroup.generation + 1 });
                return currentGroup;
            },
            updateRuntimeState: async (input) => {
                const patch = QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse(input.patch);
                currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup,
                    runtimeStateRevision: currentGroup.runtimeStateRevision + 1,
                    members: currentGroup.members.map((member) => ({ ...member,
                        state: patch.runtimeState.memberStates.find((state) => state.connectedAccountId === member.connectedAccountId)?.state ?? member.state,
                    })) });
                return currentGroup;
            },
        },
        applyGeneration: async () => ({ ok: true, mode: 'spawn_next_turn' }),
    });
    const runnerIdentity = {};
    let runnerCurrent = true;
    let nativeRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
    const resolveDaemonAuthBridge = async (): Promise<ConnectedServiceDaemonAuthBridgeRegistration> => ({
        serviceId,
        refresh: async (request, context) => {
            if (!nativeRefreshCoordinator || !context || !request.expectedCredentialRevision || !request.refreshAttemptId) {
                return { status: 'unavailable', reason: 'fixture_refresh_unavailable' };
            }
            const selection = context.target.connectedServiceSelections.find((candidate) => candidate.serviceId === serviceId);
            if (!selection) return { status: 'unavailable', reason: 'fixture_selection_unavailable' };
            return nativeRefreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthBridge({
                target: context.target, isCurrent: context.isCurrent, serviceId,
                acceptSettledCredentialRevision: context.acceptSettledCredentialRevision,
                profileId: selection.kind === 'profile' ? selection.profileId : selection.activeProfileId,
                expectedCredentialRevision: request.expectedCredentialRevision, refreshAttemptId: request.refreshAttemptId,
                authority: request.runId ? context.authority : runnerIdentity,
            });
        },
    });
    const bridge = createExecutionRunConnectedServicesBridge({
        recordRuntimeTurnCompleted: async ({ runId }) => {
            const lifecycle = { sessionId: connectedServiceRecoveryScopeKey({ kind: 'run', runId }),
                event: 'assistant_message_end' as const, terminalStatus: 'completed' as const };
            switchAttempts.recordTurnLifecycle(lifecycle);
            await recoveryScheduler.recordTurnLifecycle({ ...lifecycle, observedAtMs: nowMs });
        },
        classifyRuntimeFailure: classifyConnectedServiceRuntimeFailureForTarget,
        recoverRuntimeFailure: (input) => {
            const key = { sessionId: connectedServiceRecoveryScopeKey({ kind: 'run', runId: input.runId }),
                serviceId: input.selection.serviceId, groupId: input.selection.kind === 'group' ? input.selection.groupId : '',
                profileId: input.classification.profileId, credentialRevision: input.classification.expectedCredentialRevision };
            return runtimeRecovery.recoverConnectedServiceRuntimeFailure({
            scope: { kind: 'run', runId: input.runId }, selection: input.selection, classification: input.classification,
            refreshCredential: input.refreshCredential,
            switchesThisTurn: switchAttempts.resolveSwitchesThisTurn({ ...key, reportedSwitchesThisTurn: 0 }),
            sessionSwitchesThisHour: switchAttempts.countRecordedSwitchesInWindow({ ...key, windowMs: 3_600_000 }),
            isCurrent: input.isCurrent, signal: input.signal, temporaryThrottleScheduler: recoveryScheduler, nowMs: () => nowMs,
            continuation: { interruptedOriginId: input.interruptedOriginId, resumePromptMode: recoveryResumePromptMode,
                customResumePrompt: recoveryCustomResumePrompt, recoveryKind: input.classification.kind },
            switchCoordinator: { switchAfterClassifiedFailure: async (failure) => {
                const result = await coordinator.switchAfterClassifiedFailure({ ...failure, serviceId: service });
                switchAttempts.recordSwitchResult({ ...key, resultStatus: result.status });
                return result;
            } },
        }); },
        resolveAuthForSpawn: (input) => resolveConnectedServiceAuthForSpawn({ ...input,
            activeServerDir: join(root, 'server'), baseDir, credentials, api, nowMs: () => nowMs,
            processEnv: { NODE_ENV: 'test', HOME: root, CODEX_HOME: join(root, 'native-source') },
            qualifiedConnectedAccountApi: { readGroup: async () => currentGroup, listAccounts: async () => accounts },
        }),
        recoverRejectedStart: ({ selection, modelId: requestedModel, isCurrent }) => coordinator.switchAfterClassifiedFailure({
            serviceId: service, groupId: selection.groupId, observedProfileId: selection.activeProfileId,
            reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: requestedModel,
            // Existing charged-work budgets are already full. Only a proved
            // unaccepted model refusal may still search the remaining pool.
            switchesThisTurn: 1, sessionSwitchesThisHour: 1,
            rejectedStart: true, expectedFailureSource: { profileId: selection.activeProfileId,
                groupGeneration: selection.generation, credentialRevision: selection.credentialRevision!, isCurrent },
        }),
        registerRunTargets: (input) => { runtimeTargetRegistry.registerRunTarget({ ...input, pid: input.runnerPid }); },
        unregisterRunTargets: (runKey) => { runtimeTargetRegistry.unregisterRunKey(runKey); },
        finishRunRecovery: async (runKey) => {
            switchAttempts.clearSession(connectedServiceRecoveryScopeKey({ kind: 'run', runId: runKey }));
            await recoveryScheduler.finishRun(runKey); },
        getRunRuntimeTarget: (runKey) => runtimeTargetRegistry.getRunTargetByRunKey(runKey),
        adoptRunCredentialRevision: (input) => runtimeTargetRegistry.adoptExactCredentialRevisionForRun(input),
        resolveRunCredentialRevisionTarget: (input) => runtimeTargetRegistry.resolveExactRunCredentialRevisionTarget(input),
        resolveDaemonAuthBridge,
        resolveRunMaterializedRoot: ({ runKey, agentId }) => resolveConnectedServiceMaterializedRootDir({ baseDir, agentId, materializationKey: runKey }),
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: ({ runId: requestedRunId }) => requestedRunId
            ? { identity: runnerIdentity, parentSessionId: null, isCurrent: () => runnerCurrent }
            : null,
        acquireAgentPurposeContributions: async ({ agentId }) => {
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            return { contributions: lease.registry.contributes, isCurrent: () => pluginReloadController.isRuntimeRegistryCurrent(lease.registry),
                release: lease.release, resolveAgentContributionIdentity: async () => {
                    const identity = lease.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
                    const sourceCustody = identity && lease.registry.readPluginSourceCustody?.(identity.pluginId);
                    return identity && sourceCustody ? { ...identity, sourceCustody } : null;
                } };
        },
        purposeBindingOwner: { activatePurposeBindings: async input => ({ lease: await purposeOwner.activatePurposeBindings(input) }) },
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427, createRedactionLease: () => ({ add() {}, close() {} }),
        clearTerminalCleanupReceipt: async () => undefined,
    });
    const materialize = async (requestedRunId = runId): Promise<Materialization> => {
        const result = await bridge.materialize({ activationId: randomUUID(), runId: requestedRunId, runnerPid, agentId: 'codex', cwd: root, modelId,
            connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } } });
        if (!result.ok) throw Object.assign(new Error(result.errorMessage), { executionRunErrorCode: result.errorCode });
        return result;
    };
    const classification = (materialization: Materialization) => {
        const selection = readConnectedServiceChildSelectionsFromEnv(materialization.env)?.get(serviceId);
        if (selection?.kind !== 'group') throw new Error('Expected materialized pool selection');
        const failure = authAdapter.classifyRuntimeAuthFailure({ target: { agentId: 'codex' },
            error: { message: `model '${modelId}' is not enabled in rustponsesapi` },
            selection,
        });
        if (!failure) throw new Error('Expected admitted Codex model-entitlement classification');
        // The synthetic Agent process attests the identity it read from the real
        // materialized environment, as the Codex turn-failure producer does.
        return { ...failure, groupGeneration: selection.generation,
            expectedCredentialRevision: selection.credentialRevision };
    };
    return { bridge, coordinator, materialize, classification, commits, credentialReads, engine,
        root, baseDir, credentials, established, api, records, credentialRevisions, credentialMetadata, readCredential, runtimeTargetRegistry,
        purposeOwner, resolveDaemonAuthBridge,
        captureSessionAuthority: () => ({ identity: runnerIdentity, isCurrent: () => runnerCurrent }),
        qualifiedConnectedAccountApi: { readGroup: async () => currentGroup, listAccounts: async () => accounts },
        setRefreshCoordinator: (value: ConnectedServiceRefreshCoordinator) => { nativeRefreshCoordinator = value; },
        providerExchanges: () => providerExchanges,
        holdCredentialRead() {
            let reportEntered!: (signal?: AbortSignal) => void;
            let resume!: () => void;
            const entered = new Promise<AbortSignal | undefined>(resolve => { reportEntered = resolve; });
            const pending = new Promise<void>(resolve => { resume = resolve; });
            credentialGate = { async entered(signal) {
                reportEntered(signal);
                await new Promise<void>((resolve, reject) => {
                    const aborted = () => reject(signal?.reason);
                    signal?.addEventListener('abort', aborted, { once: true });
                    if (signal?.aborted) aborted();
                    pending.then(resolve).finally(() => signal?.removeEventListener('abort', aborted));
                });
            } };
            return { entered, resume() { credentialGate = null; resume(); } };
        },
        holdProviderExchange() {
            let resume!: () => void;
            const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
            providerGate = new Promise<void>((resolve) => { resume = resolve; });
            return { entered, resume: () => { resume(); providerGate = null; providerEntered = null; } };
        },
        runtimeRegistry: runtimeLease.registry,
        switchAttempts,
        recoveryScheduler,
        nextRecoveryArmed: () => new Promise<void>((resolve) => { reportArmed = resolve; }),
        setRecoveryClock: (value: number) => { nowMs = value; },
        setRecoveryContinuation: (mode: 'off' | 'standard' | 'custom', prompt: string | null = null) => { recoveryResumePromptMode = mode; recoveryCustomResumePrompt = prompt; },
        exhaustPoolUntil: (resetAtMs: number) => { currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup,
            members: currentGroup.members.map((member) => ({ ...member, state: { ...member.state, cooldownUntilMs: resetAtMs } })) }); },
        group: () => currentGroup, revokeRunner: () => { runnerCurrent = false; },
        advanceGroupGeneration() { currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup, generation: currentGroup.generation + 1 }); },
        reset() {
            credentialGate = null;
            nowMs = 1_000; reportArmed = null;
            recoveryResumePromptMode = 'standard'; recoveryCustomResumePrompt = null;
            currentGroup = initialGroup; runnerCurrent = true; commits.length = 0; credentialReads.length = 0;
            for (const [profileId, record] of initialRecords) {
                records.set(profileId, record); credentialRevisions.set(profileId, revision); credentialMetadata.set(profileId, { scopes: [] });
            }
            providerExchanges = 0; nativeRefreshCoordinator = null; providerGate = null; providerEntered = null;
        },
        release: () => bridge.releaseForRunnerExit({ runnerPid, runnerIdentity }),
        async close() {
            await bridge.releaseForRunnerExit({ runnerPid, runnerIdentity });
            await runtimeLease.release();
            recoveryScheduler.dispose();
            await pluginReloadController.shutdown({ timeoutMs: 5_000 });
            await rm(root, { recursive: true, force: true });
        },
    };
}

describe('composed finite Run model recovery', () => {
    let scenario: Awaited<ReturnType<typeof createScenario>>;
    beforeAll(async () => { scenario = await createScenario(); });
    beforeEach(() => { scenario.reset(); });
    afterEach(async () => { await scenario?.release(); });
    afterAll(async () => { await scenario?.close(); });
    it.each(['captured', 'evidence-only'] as const)('recovers %s capacity through real Run materialization, HTTP, shared policy and scheduler without changing pool or parent authority', async (source) => {
        const materialized = await scenario.materialize();
        const parentId = 'actual-parent-session';
        scenario.runtimeTargetRegistry.registerTarget({ pid: 9898, sessionId: parentId, agentId: 'codex',
            connectedServicesBindingsRaw: materialized.connectedServicesBindings,
            connectedServiceSelectionsEnv: materialized.env });
        const parent = scenario.runtimeTargetRegistry.getBySessionId(parentId);
        const classification = { ...scenario.classification(materialized), kind: 'capacity' as const, limitCategory: 'capacity' as const,
            quotaScope: 'provider' as const, providerLimitId: null, retryAfterMs: 10_000,
            ...(source === 'evidence-only' ? { profileId: null, groupId: null, groupGeneration: null, expectedCredentialRevision: null } : {}) };
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'master',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {}, verifyRunMaterializeToken: (token) => token === 'run-token',
            recoverConnectedServiceRuntimeFailureForExecutionRun: scenario.bridge.recoverRuntimeFailure });
        try {
            const armed = scenario.nextRecoveryArmed();
            const response = app.inject({ method: 'POST', url: '/connected-service-run/recover-runtime-failure',
                headers: { 'x-happier-daemon-token': 'run-token' }, payload: { runId, runnerPid, activationId: materialized.activationId,
                    nativeResumeId: 'provider-thread', interruptedOriginId: 'failed-turn', classification } });
            const first = await Promise.race([armed.then(() => 'waiting'), response.then(() => 'terminal')]);
            expect(first).toBe('waiting');
            const key = connectedServiceRecoveryScopeKey({ kind: 'run', runId });
            expect(scenario.recoveryScheduler.read(key)).toMatchObject({ nextRetryAtMs: 11_000, scope: { kind: 'run', runId } });
            scenario.setRecoveryClock(11_000);
            await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
            expect((await response).json()).toEqual({ status: 'continue', input: 'Continue where you left off', rematerialize: false });
            expect(scenario.commits).toEqual([]);
            expect(scenario.runtimeTargetRegistry.getBySessionId(parentId)).toBe(parent);
        } finally { scenario.runtimeTargetRegistry.unregisterPid(9898); await app.close(); }
    });
    it('rotates account quota while retaining native partial state and the Run lifetime switch budget during recovery materialization', async () => {
        const first = await scenario.materialize();
        const nativeResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
        const relativeRollout = join('sessions', '2026', '09', '07', `rollout-2026-09-07T12-00-00-${nativeResumeId}.jsonl`);
        const partialState = JSON.stringify({ type: 'session_meta', payload: { id: nativeResumeId, cwd: scenario.root } }) + '\n';
        await mkdir(dirname(join(first.env.CODEX_HOME!, relativeRollout)), { recursive: true });
        await writeFile(join(first.env.CODEX_HOME!, relativeRollout), partialState, 'utf8');
        const result = await scenario.bridge.recoverRuntimeFailure({ runId, runnerPid, activationId: first.activationId,
            nativeResumeId, interruptedOriginId: 'partially-completed-turn', classification: {
                ...scenario.classification(first), kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account', providerLimitId: null,
                resetsAtMs: 60_000,
            } }, new AbortController().signal);
        expect(result).toEqual({ status: 'continue', input: 'Usage limits are lifted. Continue where you left off.', rematerialize: true });
        expect(scenario.commits).toEqual(['second']);
        const replaced = await scenario.bridge.materialize({ activationId: randomUUID(), runId, runnerPid, agentId: 'codex', cwd: scenario.root, modelId,
            connectedServices: ConnectedServiceBindingsV2Schema.parse(first.connectedServicesBindings),
            recovery: { activationId: first.activationId, nativeResumeId } });
        expect(replaced.ok).toBe(true);
        if (!replaced.ok) throw new Error(replaced.errorMessage);
        expect(await readFile(join(replaced.env.CODEX_HOME!, relativeRollout), 'utf8')).toBe(partialState);
        expect(JSON.parse(await readFile(join(replaced.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.account_id).toBe('test-account-second');
        const armed = scenario.nextRecoveryArmed();
        const controller = new AbortController();
        const next = scenario.bridge.recoverRuntimeFailure({ runId, runnerPid, activationId: replaced.activationId,
            nativeResumeId, interruptedOriginId: 'continuation-failed-turn', classification: {
                ...scenario.classification(replaced), kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account', providerLimitId: null,
            } }, controller.signal);
        expect(await Promise.race([armed.then(() => 'waiting'), next.then(() => 'terminal')])).toBe('waiting');
        expect(scenario.commits).toEqual(['second']);
        controller.abort();
        expect(await next).toMatchObject({ status: 'failed' });
        const attempted = { sessionId: connectedServiceRecoveryScopeKey({ kind: 'run', runId }), serviceId, groupId: 'pool',
            profileId: 'first', credentialRevision: revision };
        expect(scenario.switchAttempts.resolveSwitchesThisTurn({ ...attempted, reportedSwitchesThisTurn: 0 })).toBe(1);
        expect(await scenario.bridge.completeRuntimeTurn({ runId, runnerPid, activationId: replaced.activationId })).toEqual({ ok: true, accepted: true });
        expect(scenario.switchAttempts.resolveSwitchesThisTurn({ ...attempted, reportedSwitchesThisTurn: 0 })).toBe(0);
        expect(scenario.switchAttempts.countRecordedSwitchesInWindow({ ...attempted, windowMs: 3_600_000 })).toBe(1);
    });

    it('resets the retained Run capacity streak only after an exact successful native turn', async () => {
        const materialized = await scenario.materialize();
        const request = { runId, runnerPid, activationId: materialized.activationId };
        const key = connectedServiceRecoveryScopeKey({ kind: 'run', runId });
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'master',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {}, verifyRunMaterializeToken: token => token === 'scoped',
            completeConnectedServiceRuntimeTurnForExecutionRun: scenario.bridge.completeRuntimeTurn,
        });
        const complete = (payload = request, token = 'scoped') => app.inject({ method: 'POST',
            url: '/connected-service-run/runtime-turn-completed', headers: { 'x-happier-daemon-token': token }, payload });
        try {
            expect((await complete()).statusCode).toBe(200);
            const armed = scenario.nextRecoveryArmed();
            const recovery = scenario.bridge.recoverRuntimeFailure({ ...request, nativeResumeId: 'native-partial',
                interruptedOriginId: 'failed-turn', classification: { ...scenario.classification(materialized),
                    kind: 'capacity', limitCategory: 'capacity', quotaScope: 'provider', providerLimitId: null, retryAfterMs: 10_000,
                } }, new AbortController().signal);
            expect(await Promise.race([armed.then(() => 'waiting'), recovery.then(() => 'terminal')])).toBe('waiting');
            scenario.setRecoveryClock(11_000);
            await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
            expect(await recovery).toMatchObject({ status: 'continue' });
            expect(scenario.recoveryScheduler.read(key)).toMatchObject({ capacityFailureCount: 1 });
            expect((await complete(request, 'master')).statusCode).toBe(401);
            expect((await complete({ ...request, activationId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ ok: true, accepted: false });
            expect(scenario.recoveryScheduler.read(key)).not.toBeNull();
            expect((await complete()).json()).toEqual({ ok: true, accepted: true });
            expect(scenario.recoveryScheduler.read(key)).toBeNull();
        } finally { await app.close(); }
    });

    it('waits at exhausted pool reset and cancels only the exact Run recovery', async () => {
        const materialized = await scenario.materialize();
        scenario.exhaustPoolUntil(20_000);
        const classification = { ...scenario.classification(materialized), kind: 'usage_limit' as const,
            limitCategory: 'usage_limit' as const, quotaScope: 'account' as const, providerLimitId: null, resetsAtMs: 20_000 };
        const request = { runId, runnerPid, activationId: materialized.activationId, nativeResumeId: 'provider-thread', interruptedOriginId: 'turn', classification };
        const controller = new AbortController();
        const armed = scenario.nextRecoveryArmed();
        const recovery = scenario.bridge.recoverRuntimeFailure(request, controller.signal);
        const stage = await Promise.race([armed.then(() => 'waiting'), recovery.then(() => 'terminal')]);
        expect(stage).toBe('waiting');
        const key = connectedServiceRecoveryScopeKey({ kind: 'run', runId });
        expect(scenario.recoveryScheduler.read(key)).toMatchObject({ nextRetryAtMs: 20_000 });
        scenario.setRecoveryClock(19_999);
        await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
        expect(scenario.recoveryScheduler.read(key)?.status).toBe('waiting');
        scenario.setRecoveryClock(20_000);
        await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
        expect(await recovery).toMatchObject({ status: 'continue', rematerialize: true });
        expect(scenario.commits).toEqual([]);
        const cancellationArmed = scenario.nextRecoveryArmed();
        const cancellation = scenario.bridge.recoverRuntimeFailure({ ...request, interruptedOriginId: 'cancelled-turn', classification: {
            ...classification, kind: 'capacity', limitCategory: 'capacity', quotaScope: 'provider', resetsAtMs: null,
        } }, controller.signal);
        await cancellationArmed;
        controller.abort();
        expect(await cancellation).toMatchObject({ status: 'failed' });
        expect(scenario.group().generation).toBe(7);
    });

    it('preserves the typed materialization refusal through real daemon HTTP and the control client', async () => {
        scenario.revokeRunner();
        const responses: Array<{ path: string; status: number }> = [];
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'refusal-control',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {},
            verifyRunMaterializeToken: token => token === deriveConnectedServiceRunMaterializeToken('refusal-control'),
            materializeConnectedServicesForExecutionRun: scenario.bridge.materialize,
            releaseConnectedServicesForExecutionRun: scenario.bridge.release,
        });
        app.addHook('onResponse', async (request, reply) => {
            responses.push({ path: request.routeOptions.url ?? request.url, status: reply.statusCode });
        });
        vi.stubEnv('HAPPIER_HOME_DIR', scenario.root);
        reloadConfiguration();
        try {
            const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
            writeDaemonState({ pid: process.pid, httpPort: Number(address.port), controlToken: 'refusal-control',
                startedAt: 1, startedWithCliVersion: '0.3.0' });
            const result = await requestExecutionRunConnectedServicesMaterialization({
                runId, runnerPid, agentId: 'codex', cwd: scenario.root,
                connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } },
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'connected_service_run_materialization_blocked',
                errorMessage: 'Execution-run connected services runner identity is not current' });
            expect(responses).toEqual([
                { path: '/connected-service-run/materialize', status: 403 },
                { path: '/connected-service-run/release', status: 200 },
            ]);
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).toBeNull();
        } finally {
            await app.close();
            vi.unstubAllEnvs();
            reloadConfiguration();
        }
    });

    it('cancels credential materialization through the real Run runtime and daemon HTTP lifetime', async () => {
        const cancelledRunId = 'cancel-materializing-run';
        let materializationSettled!: () => void;
        const settled = new Promise<void>(resolve => { materializationSettled = resolve; });
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'cancel-control',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {},
            verifyRunMaterializeToken: token => token === deriveConnectedServiceRunMaterializeToken('cancel-control'),
            materializeConnectedServicesForExecutionRun: async (...args) => {
                try { return await scenario.bridge.materialize(...args); }
                finally { materializationSettled(); }
            },
            releaseConnectedServicesForExecutionRun: scenario.bridge.release,
        });
        const held = scenario.holdCredentialRead();
        let host: ReturnType<typeof createExecutionRunRuntime> | undefined;
        let resolving: Promise<unknown> | undefined;
        vi.stubEnv('HAPPIER_HOME_DIR', scenario.root);
        reloadConfiguration();
        try {
            const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
            writeDaemonState({ pid: process.pid, httpPort: Number(address.port), controlToken: 'cancel-control',
                startedAt: 1, startedWithCliVersion: '0.3.0' });
            host = createExecutionRunRuntime({ cwd: scenario.root, runId: cancelledRunId, scope: 'session_owned',
                backendId: 'codex', engineRegistry: await resolveCliEngineRegistry({ backendId: 'codex', happyHomeDir: scenario.root }),
                happyHomeDir: scenario.root, permissionMode: 'read_only', modelId,
                connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } },
                start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
            });
            resolving = host.readResumeSupport().catch(error => error);
            const credentialSignal = await held.entered;
            await host.dispose();
            // Crossing the event loop lets the real HTTP disconnect reach Fastify.
            await vi.waitFor(() => expect(credentialSignal?.aborted).toBe(true));
            held.resume();
            await resolving;
            await settled;
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(cancelledRunId)).toBeNull();
            const root = resolveConnectedServiceMaterializedRootDir({ baseDir: scenario.baseDir, agentId: 'codex', materializationKey: cancelledRunId });
            await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            held.resume();
            await resolving;
            await host?.dispose();
            await app.close();
            vi.unstubAllEnvs();
            reloadConfiguration();
        }
    });

    it('releases a returned activation when its materialization signal is cancelled', async () => {
        const controller = new AbortController();
        const result = await scenario.bridge.materialize({ activationId: randomUUID(), runId, runnerPid, agentId: 'codex', cwd: scenario.root, modelId,
            connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } },
        }, controller.signal);
        expect(result.ok).toBe(true);
        expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).not.toBeNull();
        controller.abort();
        await vi.waitFor(() => expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).toBeNull());
        const root = resolveConnectedServiceMaterializedRootDir({ baseDir: scenario.baseDir, agentId: 'codex', materializationKey: runId });
        await vi.waitFor(async () => { await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' }); });
    });

    it('does not let queued cancellation retire a replacement activation', async () => {
        const controller = new AbortController();
        const request = { runId, runnerPid, agentId: 'codex', cwd: scenario.root, modelId,
            connectedServices: ConnectedServiceBindingsV2Schema.parse({ v: 2,
                bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } }),
        };
        const first = await scenario.bridge.materialize({ ...request, activationId: randomUUID() }, controller.signal);
        expect(first.ok).toBe(true);
        // The replacement holds the incumbent mutation owner ahead of the old
        // request's cancellation. That cancellation must not unregister its successor.
        const replacing = scenario.bridge.materialize({ ...request, activationId: randomUUID() });
        controller.abort();
        const replacement = await replacing;
        expect(replacement.ok).toBe(true);
        if (!replacement.ok) throw new Error(replacement.errorMessage);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).not.toBeNull();
        expect(await scenario.bridge.release({ runId, runnerPid, activationId: replacement.activationId })).toEqual({ ok: true, released: true });
    });

    it.each(['bridge return', 'response delivery', 'server finish'] as const)('releases exact materialization cancelled during %s', async (phase) => {
        const cancelledRunId = `late-cancel-${phase.replace(' ', '-')}`;
        let notifyBoundary!: () => void;
        const boundary = new Promise<void>(resolve => { notifyBoundary = resolve; });
        let resumeResponse!: () => void;
        const responseGate = new Promise<void>(resolve => { resumeResponse = resolve; });
        let admitted: Materialization | undefined;
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'cancel-control',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {},
            verifyRunMaterializeToken: token => token === deriveConnectedServiceRunMaterializeToken('cancel-control'),
            materializeConnectedServicesForExecutionRun: async (...args) => {
                const result = await scenario.bridge.materialize(...args);
                if (result.ok) {
                    admitted = result;
                    if (phase === 'bridge return') { notifyBoundary(); await responseGate; }
                }
                return result;
            },
            releaseConnectedServicesForExecutionRun: scenario.bridge.release,
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (phase === 'server finish' && request.url.includes('materialize') && reply.statusCode === 200) {
                reply.raw.once('finish', () => { cancellation = host?.dispose(); notifyBoundary(); });
            }
            if (phase === 'response delivery' && request.url.includes('materialize') && reply.statusCode === 200) {
                notifyBoundary();
                await responseGate;
            }
            return payload;
        });
        let host: ReturnType<typeof createExecutionRunRuntime> | undefined;
        let cancellation: Promise<void> | undefined;
        let resolving: Promise<unknown> | undefined;
        vi.stubEnv('HAPPIER_HOME_DIR', scenario.root);
        reloadConfiguration();
        try {
            const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
            writeDaemonState({ pid: process.pid, httpPort: Number(address.port), controlToken: 'cancel-control',
                startedAt: 1, startedWithCliVersion: '0.3.0' });
            host = createExecutionRunRuntime({ cwd: scenario.root, runId: cancelledRunId, scope: 'session_owned',
                backendId: 'codex', engineRegistry: await resolveCliEngineRegistry({ backendId: 'codex', happyHomeDir: scenario.root }),
                happyHomeDir: scenario.root, permissionMode: 'read_only', modelId,
                connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } },
                start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
            });
            resolving = host.readResumeSupport().catch(error => error);
            await boundary;
            expect(admitted?.ok).toBe(true);
            if (phase !== 'server finish') expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(cancelledRunId)).not.toBeNull();
            await cancellation;
            await host.dispose();
            await resolving;
            resumeResponse();
            await vi.waitFor(() => expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(cancelledRunId)).toBeNull());
            const root = resolveConnectedServiceMaterializedRootDir({ baseDir: scenario.baseDir, agentId: 'codex', materializationKey: cancelledRunId });
            await vi.waitFor(async () => { await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' }); });
        } finally {
            resumeResponse();
            await resolving;
            await host?.dispose();
            if (admitted) await scenario.bridge.release({ runId: cancelledRunId, runnerPid: process.pid, activationId: admitted.activationId });
            await app.close();
            vi.unstubAllEnvs();
            reloadConfiguration();
        }
    });

    it('retains delivered materialization until exact caller release', async () => {
        let admitted: Materialization | undefined;
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'master',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {}, verifyRunMaterializeToken: token => token === 'run-token',
            materializeConnectedServicesForExecutionRun: async (...args) => {
                const result = await scenario.bridge.materialize(...args);
                if (result.ok) admitted = result;
                return result;
            }, releaseConnectedServicesForExecutionRun: scenario.bridge.release,
        });
        const controller = new AbortController();
        try {
            const address = await app.listen({ host: '127.0.0.1', port: 0 });
            const response = await fetch(`${address}/connected-service-run/materialize`, { method: 'POST',
                headers: { 'content-type': 'application/json', 'x-happier-daemon-token': 'run-token' }, signal: controller.signal,
                body: JSON.stringify({ activationId: randomUUID(), runId, runnerPid, agentId: 'codex', cwd: scenario.root, modelId,
                    connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ ok: true, result: { activationId: admitted?.activationId } });
            const target = scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId);
            expect(target).not.toBeNull();
            controller.abort();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).toBe(target);
            expect(await scenario.bridge.release({ runId, runnerPid, activationId: '00000000-0000-4000-8000-000000000000' }))
                .toEqual({ ok: true, released: false });
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).toBe(target);
            expect(await scenario.bridge.release({ runId, runnerPid, activationId: admitted!.activationId })).toEqual({ ok: true, released: true });
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['activated', 'declaration'] as const)('opens connected detached Codex from %s engine composition with materialized native auth', async (catalogBasis) => {
        const materialization = await scenario.materialize();
        const processBoundary = createCodexProcessBoundary(false);
        const unsupportedAuthDiagnostics: unknown[] = [];
        const captureDiagnostic = (...args: readonly unknown[]) => {
            for (const value of args) {
                if (value && typeof value === 'object'
                    && Reflect.get(value, 'errorCode') === 'codex_refresh_free_auth_unsupported') {
                    unsupportedAuthDiagnostics.push(value);
                }
            }
        };
        const createServices = scenario.runtimeRegistry.createAgentInvocationServices;
        if (!createServices) throw new Error('Admitted Codex invocation services unavailable');
        const runtimeRegistry = {
            ...scenario.runtimeRegistry,
            // Keep the actual host services and native composition; replace only the
            // external Agent process/JSON-RPC transport with synthetic credentials.
            createAgentInvocationServices: async (input: Parameters<typeof createServices>[0]) => {
                const services = await createServices.call(scenario.runtimeRegistry, input);
                return { ...services, exec: processBoundary.exec,
                    logger: { ...services.logger, debug: captureDiagnostic, warn: captureDiagnostic } };
            },
        };
        const contribution = scenario.engine.agent;
        if (!contribution.richDefinition || !contribution.identity) throw new Error('Codex declaration unavailable');
        const declarations = createResolvedContributionRegistry({ agents: [projectManifestAgentContribution({
            definition: contribution.richDefinition.definition, pluginId: contribution.identity.pluginId,
            provenance: contribution.provenance, source: contribution.source,
            ...(contribution.hostAccess ? { hostAccess: contribution.hostAccess } : {}),
        })] });
        const engine = catalogBasis === 'activated'
            ? await resolveBackendEngineAdapterResolution('codex', { runtimeRegistry })
            : await resolveEngineAdapterResolutionFromRegistry({ backendId: 'codex',
                contributions: declarations, runtimeRegistry });
        if (!engine) throw new Error('Admitted Codex engine unavailable');
        const host = engine.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: scenario.root, scope: 'detached', backendId: 'codex', runId,
            controllerOccurrenceId: 'connected-controller', callId: 'connected-call', sidechainId: 'connected-sidechain',
            machineId: 'fixture-machine', permissionMode: 'read_only', modelId,
            isolation: { env: materialization.env },
            connectedServiceRuntimeAuthRefresh: request => scenario.bridge.refreshRuntimeAuth({
                ...request, runId, runnerPid, activationId: materialization.activationId,
                selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema.parse(request.selection),
            }),
            configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: modelId, updatedAtMs: 0 },
                permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
            start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'streaming' },
        });
        try {
            await host.provisionRuntime({ initialPrompt: 'synthetic connected input' });
            expect(unsupportedAuthDiagnostics).toEqual([]);
            const login = processBoundary.rpcRequests.find(request => request.method === 'account/login/start');
            expect(login?.params).toMatchObject({ type: 'chatgptAuthTokens', accessToken: 'test-access-first', chatgptAccountId: 'test-account-first' });
            expect(processBoundary.rpcRequests.some(request => request.method === 'thread/start')).toBe(true);
            await processBoundary.finish(false);
            await host.waitForTurnCompletion?.();
        } finally { await host.dispose(); }
    });

    it('binds retained Run creation to daemon capacity recovery and continues partial work without replay', async () => {
        const composedRunId = 'composed-create-recovery';
        const opened: AgentSessionOpenRequest[] = [];
        const prompts: string[] = [];
        let failProviderTurn: (() => void) | undefined;
        type NativeEvent = AgentSessionRuntimeEvent extends infer Event
            ? Event extends AgentSessionRuntimeEvent ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'> : never : never;
        // Only the external native Agent is replaced. Registry selection, Run creation,
        // native host lifecycle, HTTP auth, classification and recovery all remain real.
        const nativeRuntime: AgentRuntime = { sessions: { async open(request, context) {
            expect(context.services.sessions.current).toBeNull();
            expect(context.services.availability('sessions').status).toBe('unavailable');
            await expect(async () => context.services.sessions.get('unrelated-session')).rejects.toMatchObject({ code: PLUGIN_SERVICE_UNAVAILABLE_CODE });
            expect(context.session.services.auth).toBeDefined();
            await expect(context.session.services.auth!.services.refreshRuntimeAuth({ serviceId: 'openai-codex' }))
                .resolves.toMatchObject({ status: 'unavailable', reason: 'runtime_auth_selection_unavailable' });
            opened.push(request);
            let sequence = 0;
            let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
            const publish = (event: NativeEvent) => listener?.({ ...event, sequence: ++sequence,
                sessionId: request.sessionId, emittedAtMs: 1000 } as AgentSessionRuntimeEvent);
            return {
                watch(handler) {
                    listener = handler;
                    publish({ kind: 'provider-session-id', providerSessionId: 'native-partial-thread' });
                    return { dispose() { listener = undefined; } };
                },
                async send(input) {
                    prompts.push(input.input.text);
                    const turnId = input.delivery.turnId;
                    publish({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
                    publish({ kind: 'turn-start', turnId, startedBy: 'host' });
                    if (input.input.text !== 'Continue where you left off') {
                        publish({ kind: 'message-delta', turnId, channel: 'assistant', text: 'partial work already committed' });
                        failProviderTurn = () => publish({ kind: 'turn-failed', turnId,
                            diagnostic: { code: 'server_overloaded', message: 'Service temporarily overloaded', severity: 'error' } });
                    } else {
                        publish({ kind: 'message-delta', turnId, channel: 'assistant', text: 'continued partial work' });
                        publish({ kind: 'turn-complete', turnId });
                    }
                    return { status: 'admitted' as const };
                },
                async cancel({ turnId }) { publish({ kind: 'turn-cancelled', turnId, cause: 'user' }); return { status: 'requested' as const, turnId }; },
                async updateConfiguration() { return { status: 'applied' as const, changed: [] }; },
                async compact() { return { status: 'admitted' as const }; },
                async dispose() {},
            };
        } } };
        const sourceCustody = scenario.runtimeRegistry.readPluginSourceCustody?.('happier.agent.codex');
        if (!sourceCustody) throw new Error('Admitted Codex source custody unavailable');
        const sourceLease = scenario.runtimeRegistry.agentRuntimesByAgentId.get('codex');
        if (!sourceLease || !scenario.runtimeRegistry.createAgentInvocationServices) throw new Error('Admitted Codex service factory unavailable');
        let preparedSessionId: string | null = null;
        const registry = await resolveCliEngineRegistry({ backendId: 'codex', happyHomeDir: scenario.root,
            requireRunnerAgentSessionRuntimeSource: true,
            runnerAgentSessionRuntimeSource: {
                agentContribution: scenario.engine.agent,
                identity: { pluginId: 'happier.agent.codex', pluginVersion: '1.0.0', agentId: 'codex', backendId: 'codex',
                    occurrenceId: sourceLease.occurrenceId, sourceCustody, isCurrent: sourceLease.isCurrent },
                prepareForSession: async ({ sessionId }) => { preparedSessionId = sessionId; },
                createRuntime: async () => {
                    if (preparedSessionId !== 'actual-parent-session') throw new Error('Native source has not claimed its parent Session');
                    return nativeRuntime;
                },
                createInvocationServices: scenario.runtimeRegistry.createAgentInvocationServices.bind(scenario.runtimeRegistry),
                authorizeNewTurn: async () => ({ status: 'admitted' as const }),
            },
        });
        const parentSession: NativeAgentSessionInteractionHostBinding['session'] = {
            sessionId: 'actual-parent-session', getMetadataSnapshot: () => createTestMetadata({ path: scenario.root, machineId: 'fixture-machine' }),
            updateMetadata: vi.fn<NativeAgentSessionInteractionHostBinding['session']['updateMetadata']>(),
            updateAgentState: vi.fn<NativeAgentSessionInteractionHostBinding['session']['updateAgentState']>(),
            enqueueAgentMessageCommitted: vi.fn<NativeAgentSessionInteractionHostBinding['session']['enqueueAgentMessageCommitted']>(),
        };
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'composed-control',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {},
            verifyRunMaterializeToken: token => token === deriveConnectedServiceRunMaterializeToken('composed-control'),
            materializeConnectedServicesForExecutionRun: scenario.bridge.materialize,
            recoverConnectedServiceRuntimeFailureForExecutionRun: scenario.bridge.recoverRuntimeFailure,
            completeConnectedServiceRuntimeTurnForExecutionRun: scenario.bridge.completeRuntimeTurn,
            releaseConnectedServicesForExecutionRun: scenario.bridge.release,
        });
        let host: ReturnType<typeof createExecutionRunRuntime> | undefined;
        vi.stubEnv('HAPPIER_HOME_DIR', scenario.root);
        reloadConfiguration();
        try {
            const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
            writeDaemonState({ pid: process.pid, httpPort: Number(address.port), controlToken: 'composed-control',
                startedAt: 1, startedWithCliVersion: '0.3.0' });
            host = createExecutionRunRuntime({ cwd: scenario.root, runId: composedRunId, scope: 'session_owned',
                backendId: 'codex', engineRegistry: registry, happyHomeDir: scenario.root,
                controllerOccurrenceId: 'composed-controller', callId: 'composed-call', sidechainId: 'composed-sidechain',
                permissionMode: 'read_only', modelId,
                connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } },
                start: { intent: 'delegate', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' },
                sessionInteractionHost: { session: parentSession, machineId: 'fixture-machine',
                    permissionHandler: createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: 'codex' }) },
            });
            const messages: string[] = [];
            host.subscribeMessages(message => { if (message.type === 'model-output' && message.textDelta) messages.push(message.textDelta); });
            const { runtimeId } = await host.provisionRuntime();
            await host.deliverInput(runtimeId, { text: 'original charged work' });
            const waiting = scenario.nextRecoveryArmed();
            const completion = host.waitForTurnCompletion!();
            failProviderTurn!();
            expect(await Promise.race([waiting.then(() => 'waiting'), completion.then(() => 'completed', () => 'failed')])).toBe('waiting');
            expect(opened.map(request => request.kind)).toEqual(['create']);
            expect(prompts).toEqual(['original charged work']);
            const key = connectedServiceRecoveryScopeKey({ kind: 'run', runId: composedRunId });
            const scheduled = scenario.recoveryScheduler.read(key);
            expect(scheduled).toMatchObject({ scope: { kind: 'run', runId: composedRunId }, status: 'waiting' });
            expect(scheduled?.nextRetryAtMs).toBeGreaterThan(1000);
            if (scheduled?.nextRetryAtMs == null) throw new Error('Run recovery did not schedule a retry');
            scenario.setRecoveryClock(scheduled.nextRetryAtMs);
            await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
            await completion;
            expect(opened).toHaveLength(2);
            expect(opened[1]).toMatchObject({ kind: 'resume', providerSessionId: 'native-partial-thread' });
            expect(prompts).toEqual(['original charged work', 'Continue where you left off']);
            expect(messages.join('')).toContain('partial work already committed');
            expect(messages.join('')).toContain('continued partial work');
            expect(scenario.group().activeConnectedAccountId).toBe('first');
            expect(scenario.commits).toEqual([]);
            expect(scenario.recoveryScheduler.read(key)).toBeNull();

            await host.deliverInput(runtimeId, { text: 'unrelated charged work' });
            const waitingAgain = scenario.nextRecoveryArmed();
            const completionAgain = host.waitForTurnCompletion!();
            failProviderTurn!();
            expect(await Promise.race([waitingAgain.then(() => 'waiting'), completionAgain.then(() => 'completed', () => 'failed')])).toBe('waiting');
            const scheduledAgain = scenario.recoveryScheduler.read(key);
            expect(scheduledAgain).toMatchObject({ capacityFailureCount: 1, status: 'waiting' });
            if (scheduledAgain?.nextRetryAtMs == null) throw new Error('Second Run recovery did not schedule a retry');
            expect(scheduledAgain.nextRetryAtMs - scheduled.nextRetryAtMs).toBe(scheduled.nextRetryAtMs - 1000);
            scenario.setRecoveryClock(scheduledAgain.nextRetryAtMs);
            await scenario.recoveryScheduler.wake({ sessionId: key, reason: 'timer' });
            await completionAgain;
            expect(prompts).toEqual(['original charged work', 'Continue where you left off',
                'unrelated charged work', 'Continue where you left off']);
            expect(scenario.recoveryScheduler.read(key)).toBeNull();
        } finally {
            await host?.dispose();
            await app.close();
            vi.unstubAllEnvs();
            reloadConfiguration();
        }
    });
    it('applies ordinary account recovery when automatic continuation is off', async () => {
        const materialized = await scenario.materialize();
        scenario.setRecoveryContinuation('off');
        const result = await scenario.bridge.recoverRuntimeFailure({ runId, runnerPid, activationId: materialized.activationId,
            nativeResumeId: 'provider-thread', interruptedOriginId: 'failed-turn', classification: {
                ...scenario.classification(materialized), kind: 'usage_limit', limitCategory: 'usage_limit', quotaScope: 'account', providerLimitId: null,
            } }, new AbortController().signal);
        expect(result).toEqual({ status: 'failed', reason: 'continuation_disabled' });
        expect(scenario.commits).toEqual(['second']);
    });

    it.each(['capacity', 'exhausted'] as const)('arms ordinary %s policy without parking an off-mode failed Run until reset', async (failureKind) => {
        const materialized = await scenario.materialize();
        scenario.setRecoveryContinuation('off');
        if (failureKind === 'exhausted') scenario.exhaustPoolUntil(20_000);
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'master',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {}, verifyRunMaterializeToken: token => token === 'scoped',
            recoverConnectedServiceRuntimeFailureForExecutionRun: scenario.bridge.recoverRuntimeFailure });
        try {
            // The external clock deliberately never reaches the scheduler's next retry.
            const response = await app.inject({ method: 'POST', url: '/connected-service-run/recover-runtime-failure',
                headers: { 'x-happier-daemon-token': 'scoped' }, payload: { runId, runnerPid, activationId: materialized.activationId,
                    nativeResumeId: 'native-partial-checkpoint', interruptedOriginId: 'off-failed-turn', classification: {
                        ...scenario.classification(materialized), kind: failureKind === 'capacity' ? 'capacity' : 'usage_limit',
                        limitCategory: failureKind === 'capacity' ? 'capacity' : 'usage_limit',
                        quotaScope: failureKind === 'capacity' ? 'provider' : 'account', providerLimitId: null,
                        resetsAtMs: failureKind === 'capacity' ? null : 20_000,
                    } } });
            expect(response.json()).toEqual({ status: 'failed', reason: 'continuation_disabled' });
            expect(scenario.recoveryScheduler.read(connectedServiceRecoveryScopeKey({ kind: 'run', runId }))).toMatchObject({ status: 'waiting' });
            expect(scenario.commits).toEqual([]);
        } finally { await app.close(); }
    });

    it.each([0, 2, 3])('preserves accepted work or recovers %i explicit rejected members through the composed corridor', async (rejectCount) => {
        let active: Materialization | null = null;
        const requests: AgentExecutionRunOpenRequest[] = [];
        const openedMembers: string[] = [];
        const processBoundaries: ReturnType<typeof createCodexProcessBoundary>[] = [];
        let processBoundary: ReturnType<typeof createCodexProcessBoundary> | null = null;
        const host = createLazyExecutionRunHostRuntime({
            resolveRuntime: async () => {
                active = await scenario.materialize();
                const materialization = active;
                const failure = scenario.classification(materialization);
                // Prove the admitted Codex materializer produced the native auth read by
                // the Agent process. These are synthetic fixture credentials only.
                const nativeAuth = JSON.parse(await readFile(join(materialization.env.CODEX_HOME!, 'auth.json'), 'utf8'));
                expect(nativeAuth.tokens.account_id).toBe(`test-account-${failure.profileId}`);
                openedMembers.push(failure.profileId!);
                const lease = scenario.runtimeRegistry.agentRuntimesByAgentId.get('codex');
                if (!lease?.hasPrimaryRuntime) throw new Error('Admitted Codex native runtime unavailable');
                const runtime = await lease.createRuntime({ signal: lease.retirementSignal });
                if (!runtime.sessions?.executionRunContextV1) throw new Error('Admitted Codex Run facet unavailable');
                processBoundary = createCodexProcessBoundary(rejectCount > 0 && openedMembers.length <= rejectCount);
                processBoundaries.push(processBoundary);
                const boundaryServices = { ...createUnavailablePluginServices(), exec: processBoundary.exec,
                    logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {} } };
                const contextFactory = createNativeAgentExecutionRunContextLeaseFactory({
                    lease, runId, controllerOccurrenceId: 'controller-1', callId: 'call-1', sidechainId: 'sidechain-1',
                    runtimeRegistry: scenario.runtimeRegistry, directory: '/fixture', machineId: 'fixture-machine',
                    accountSettings: null, permissionMode: 'read_only', start: { intent: 'delegate' },
                    agent: scenario.engine.agent, sourceEnvironment: materialization.env,
                    refreshRuntimeAuthViaDaemon: (request) => scenario.bridge.refreshRuntimeAuth({
                        ...request, runId, runnerPid, activationId: materialization.activationId,
                        selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema.parse(request.selection),
                    }),
                });
                return createNativeAgentExecutionRunHostRuntime({
                    runtime, executionRunContextV1: {
                        open: async (request, context) => {
                            const files = await context.executionRun.services.nativeHome!.readFiles(['auth.json']);
                            expect(JSON.parse(new TextDecoder().decode(files['auth.json'])).tokens.account_id).toBe(`test-account-${failure.profileId}`);
                            expect(context.executionRun.services.auth?.services.refreshRuntimeAuth).toBeTypeOf('function');
                            expect(context).not.toHaveProperty('session');
                            requests.push(request);
                            return runtime.sessions!.executionRunContextV1!.open(request, context);
                        },
                    },
                    services: Promise.resolve(boundaryServices),
                    lease, createExecutionRunContext: contextFactory,
                    options: { cwd: '/fixture', runId, scope: 'detached', backendId: 'codex', permissionMode: 'read_only',
                        isolation: { env: materialization.env },
                        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: modelId, updatedAtMs: 0 },
                            permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
                        start: { intent: 'delegate', localInputId: 'same-unaccepted-input' } }, supportsResume: false,
                });
            },
            recoverRejectedStart: async (error) => {
                if (!(error instanceof ExecutionRunRejectedStartError) || !active) return false;
                const result = await scenario.bridge.recoverRejectedStart({ runId, runnerPid, activationId: active.activationId,
                    modelId, classification: error.classification });
                if (!result.ok) throw Object.assign(new Error(result.errorMessage), { executionRunErrorCode: result.errorCode });
                return true;
            },
        });
        try {
            if (rejectCount === 3) await expect(host.provisionRuntime({ initialPrompt: 'unchanged input' })).rejects.toMatchObject({
                executionRunErrorCode: 'connected_service_run_model_unavailable', message: expect.stringContaining(modelId),
            });
            else {
                await host.provisionRuntime({ initialPrompt: 'unchanged input' });
                await processBoundary!.finish(rejectCount === 0);
                if (rejectCount === 0) await expect(host.waitForTurnCompletion?.()).rejects.toThrow();
                else await host.waitForTurnCompletion?.();
            }
            const expectedMembers = rejectCount === 0 ? ['first'] : memberIds;
            expect(openedMembers).toEqual(expectedMembers);
            // Currentness checks may repeat an exact member read. Preserve the
            // transition order and service identity, including a wrong revisit.
            const credentialReadTargets = scenario.credentialReads.filter((ref, index, refs) => {
                const previousRef = refs[index - 1];
                return !previousRef || !sameQualifiedConnectedAccountRef(previousRef, ref);
            });
            expect(credentialReadTargets).toEqual(expectedMembers.map((accountId) => ({ service, accountId })));
            expect(scenario.commits).toEqual(rejectCount === 0 ? [] : ['second', 'third']);
            expect(processBoundaries.map((boundary) => boundary.rpcRequests.filter((request) => request.method === 'thread/start').length))
                .toEqual(expectedMembers.map(() => 1));
            expect(processBoundaries.map((boundary) => boundary.rpcRequests.filter((request) => request.method === 'turn/start').length))
                .toEqual(expectedMembers.map((_, index) => rejectCount === 0 || index >= rejectCount ? 1 : 0));
            expect(requests.map((request) => request.kind === 'create' && { input: request.input, localInputId: request.localInputId }))
                .toEqual(expectedMembers.map(() => ({ input: { text: 'unchanged input' }, localInputId: 'same-unaccepted-input' })));
            expect(scenario.group().members.slice(0, rejectCount).every((member) => member.state.modelUnavailableUntilMsByModelId?.[modelId] === 86_401_000)).toBe(true);
            if (rejectCount === 0) {
                expect(scenario.group().runtimeStateRevision).toBe(0);
                await expect(scenario.coordinator.switchAfterClassifiedFailure({
                    serviceId: service, groupId: 'pool', observedProfileId: 'first', reason: 'plan',
                    limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: modelId,
                    switchesThisTurn: 1, sessionSwitchesThisHour: 1,
                })).resolves.toMatchObject({ status: 'switch_limit_reached' });
                expect(requests).toHaveLength(1);
                expect(scenario.commits).toEqual([]);
            }
        } finally { await host.dispose(); }
    });

    it('refuses stale activation and mismatched retained member evidence before any pool write', async () => {
        try {
            const active = await scenario.materialize();
            const failure = scenario.classification(active);
            const request = { runId, runnerPid, activationId: active.activationId, modelId, classification: failure };
            await expect(scenario.bridge.recoverRejectedStart({ ...request,
                activationId: '00000000-0000-4000-8000-000000000000' })).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_activation_stale',
            });
            for (const mismatch of [
                { profileId: 'second' }, { groupId: 'another-pool' },
                { groupGeneration: 8 }, { expectedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
                { providerLimitId: 'another-model' },
            ]) await expect(scenario.bridge.recoverRejectedStart({ ...request,
                classification: { ...failure, ...mismatch } })).resolves.toMatchObject({
                    ok: false, errorCode: 'connected_service_run_materialization_blocked',
                });
            await expect(scenario.bridge.recoverRejectedStart({ ...request, modelId: 'another-model',
                classification: { ...failure, providerLimitId: 'another-model' } })).resolves.toMatchObject({
                    ok: false, errorCode: 'connected_service_run_materialization_blocked',
                });
            const replacement = await scenario.materialize();
            expect(replacement.activationId).not.toBe(active.activationId);
            await expect(scenario.bridge.recoverRejectedStart(request)).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_activation_stale',
            });
            scenario.revokeRunner();
            await expect(scenario.bridge.recoverRejectedStart({ ...request, activationId: replacement.activationId })).resolves.toMatchObject({
                ok: false, errorCode: 'connected_service_run_activation_stale',
            });
            expect(scenario.commits).toEqual([]);
            expect(scenario.group().runtimeStateRevision).toBe(0);
        } finally { await scenario.release(); }
    });

    function createRefreshCoordinator(onAuthUpdated?: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']) {
        let mutations = 0;
        const coordinator = new ConnectedServiceRefreshCoordinator({
            api: scenario.api, credentials: scenario.credentials, runtimeRegistry: scenario.runtimeTargetRegistry,
            machineIdProvider: () => 'fixture-machine', activeServerDir: join(scenario.root, 'server'), baseDir: scenario.baseDir,
            refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => 1_000,
            ...(onAuthUpdated ? { onAuthUpdated } : {}),
            processEnv: { NODE_ENV: 'test', HOME: scenario.root, CODEX_HOME: join(scenario.root, 'native-source') },
            resolveQualifiedPurposeBindingSnapshot: async (input) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: input.agentId, bindings: ConnectedServiceBindingsV2Schema.parse(input.connectedServicesBindingsRaw),
                contributions: scenario.runtimeRegistry.contributes,
            }),
            qualifiedConnectedAccountRuntime: {
                resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: scenario.established,
                readCredential: scenario.readCredential,
                readGroup: async () => scenario.group(),
                acquireRefreshLease: async ({ lease: raw }) => {
                    const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(raw);
                    expect(lease.ref.accountId).toBe('first');
                    expect(lease.expectedCredentialRevision).toBe(scenario.credentialRevisions.get('first'));
                    return { acquired: true, leaseUntil: 31_000, ownerId: lease.ownerId,
                        credentialRevision: lease.expectedCredentialRevision };
                },
                mutateCredential: async ({ mutation: raw }) => {
                    const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(raw);
                    expect(mutation.ref.accountId).toBe('first');
                    expect(mutation.expectedCredentialRevision).toBe(scenario.credentialRevisions.get('first'));
                    const plaintext = openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                        envelope: mutation.content });
                    const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: mutation.ref,
                        authenticationModeId: mutation.authenticationModeId,
                        plaintext, metadata: mutation.metadata });
                    scenario.records.set('first', ConnectedServiceCredentialRecordV1Schema.parse(
                        projectQualifiedConnectedAccountCredentialPlaintextV1({ ref: mutation.ref,
                            authenticationModeId: mutation.authenticationModeId, payload, metadata: mutation.metadata, now: 1_000 })));
                    scenario.credentialMetadata.set('first', mutation.metadata);
                    mutations += 1;
                    const updatedRevision = mutations === 1 ? 'csr_bbbbbbbbbbbbbbbbbbbbbb' : 'csr_cccccccccccccccccccccc';
                    scenario.credentialRevisions.set('first', updatedRevision);
                    return { success: true, credentialRevision: updatedRevision, configurationRevision: null };
                },
                mutateCredentialHealth: async () => ({ credentialRevision: scenario.credentialRevisions.get('first')!, configurationRevision: null }),
            },
        });
        scenario.setRefreshCoordinator(coordinator);
        return coordinator;
    }

    function refreshRequest(materialized: Materialization, requestedRunId = runId, attemptId = 'native-proof-1', expectedRevision = revision) {
        const selection = readConnectedServiceChildSelectionsFromEnv(materialized.env)?.get(serviceId);
        if (selection?.kind !== 'group') throw new Error('Expected actual pool selection');
        const { credentialRevision: _credentialRevision, policy: _policy, ...identity } = selection;
        return { runId: requestedRunId, runnerPid, activationId: materialized.activationId, serviceId,
            refreshAttemptId: attemptId, expectedCredentialRevision: expectedRevision, selection: identity };
    }

    it('refreshes an emitted auth-expired Run failure before pool recovery and continues the retained native checkpoint', async () => {
        const materialized = await scenario.materialize();
        createRefreshCoordinator();
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken: 'master',
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {}, verifyRunMaterializeToken: token => token === 'scoped',
            recoverConnectedServiceRuntimeFailureForExecutionRun: scenario.bridge.recoverRuntimeFailure });
        try {
            const response = await app.inject({ method: 'POST', url: '/connected-service-run/recover-runtime-failure',
                headers: { 'x-happier-daemon-token': 'scoped' }, payload: { runId, runnerPid, activationId: materialized.activationId,
                    nativeResumeId: 'native-partial-checkpoint', interruptedOriginId: 'auth-expired-native-turn', classification: {
                        ...scenario.classification(materialized), kind: 'auth_expired', limitCategory: 'auth_invalid', quotaScope: 'account', providerLimitId: null,
                    } } });
            expect(response.json()).toEqual({ status: 'continue', input: 'Continue where you left off', rematerialize: false });
            expect(scenario.providerExchanges()).toBe(1);
            expect(scenario.commits).toEqual([]);
            expect(JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token).toBe('refreshed-access-1');
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)?.activeBindings[0]?.credentialRevision).toBe('csr_bbbbbbbbbbbbbbbbbbbbbb');
        } finally { await app.close(); }
    });

    it('settles native refresh proof only after the exact retained Run home adopts the CAS revision', async () => {
        const materialized = await scenario.materialize();
        createRefreshCoordinator();
        const request = refreshRequest(materialized);
        const originalTarget = scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId);
        const gate = scenario.holdProviderExchange();
        let notifySettlement!: (proof: Awaited<ReturnType<typeof scenario.bridge.refreshRuntimeAuth>>) => void;
        const settlement = new Promise<Awaited<ReturnType<typeof scenario.bridge.refreshRuntimeAuth>>>((resolve) => { notifySettlement = resolve; });
        const controlToken = 'synthetic-master-control-token';
        const app = createDaemonControlApp({ getChildren: () => [], machineId: 'fixture-machine', controlToken,
            stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
            requestShutdown() {}, onHappySessionWebhook() {},
            verifyRunMaterializeToken: (token) => token === deriveConnectedServiceRunMaterializeToken(controlToken),
            refreshConnectedServiceRuntimeAuthForExecutionRun: async (input) => {
                const proof = await scenario.bridge.refreshRuntimeAuth(input); notifySettlement(proof); return proof;
            },
        });
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
        const target = { pid: process.pid, httpPort: address.port, controlToken };
        try {
        const acknowledgment = requestExecutionRunConnectedServiceRuntimeAuthRefresh(request, { target, timeoutMs: 100 });
        await gate.entered;
        expect(await acknowledgment).toEqual({ status: 'pending', refreshAttemptId: request.refreshAttemptId });
        gate.resume();
        const result = await settlement;
        const updatedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        expect(result).toEqual({ status: 'refreshed', result: {
            credentialRevision: updatedRevision,
            accessToken: 'refreshed-access-1', providerAccountId: 'test-account-first',
        } });
        expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).not.toBe(originalTarget);
        const auth = JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8'));
        expect(auth.tokens.access_token).toBe('refreshed-access-1');
        expect(auth.tokens.account_id).toBe('test-account-first');
        // The original response may be lost after the daemon settles. The same scoped
        // attempt with its original basis must recover the proof without rotating again.
        expect(await requestExecutionRunConnectedServiceRuntimeAuthRefresh(request, { target, timeoutMs: 120_000 })).toEqual(result);
        expect(scenario.providerExchanges()).toBe(1);
        expect(await scenario.bridge.refreshRuntimeAuth({ ...request, refreshAttemptId: 'unadmitted-old-basis' })).toMatchObject({ status: 'unavailable' });
        const { expectedCredentialRevision: _expectedRevision, ...missingRevision } = request;
        // @ts-expect-error The untrusted request deliberately omits its required credential fence.
        expect(await scenario.bridge.refreshRuntimeAuth(missingRevision)).toMatchObject({ status: 'unavailable' });
        expect(await scenario.bridge.refreshRuntimeAuth({ ...request, refreshAttemptId: 'native-proof-2', expectedCredentialRevision: updatedRevision }))
            .toEqual({ status: 'refreshed', result: {
                credentialRevision: 'csr_cccccccccccccccccccccc',
                accessToken: 'refreshed-access-2', providerAccountId: 'test-account-first',
            } });
        expect(JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token).toBe('refreshed-access-2');
        expect(scenario.providerExchanges()).toBe(2);
        await scenario.bridge.release(request);
        expect(await scenario.bridge.refreshRuntimeAuth(request)).toMatchObject({ status: 'unavailable' });
        expect(scenario.commits).toEqual([]);
        expect(scenario.group().generation).toBe(7);
        } finally { gate.resume(); await app.close(); }
    });

    it('retains both scoped continuation proofs when live Runs coalesce one credential exchange', async () => {
        const first = await scenario.materialize();
        const secondId = 'second-live-run';
        const second = await scenario.materialize(secondId);
        createRefreshCoordinator();
        const gate = scenario.holdProviderExchange();
        const firstRequest = refreshRequest(first);
        const secondRequest = refreshRequest(second, secondId, 'second-run-attempt');
        const firstRefresh = scenario.bridge.refreshRuntimeAuth(firstRequest);
        await gate.entered;
        const secondRefresh = scenario.bridge.refreshRuntimeAuth(secondRequest);
        gate.resume();
        const [firstProof, secondProof] = await Promise.all([firstRefresh, secondRefresh]);
        expect(firstProof).toMatchObject({ status: 'refreshed' });
        expect(secondProof).toEqual(firstProof);
        expect(await scenario.bridge.refreshRuntimeAuth(firstRequest)).toEqual(firstProof);
        expect(await scenario.bridge.refreshRuntimeAuth(secondRequest)).toEqual(secondProof);
        expect(scenario.providerExchanges()).toBe(1);
        for (const active of [first, second]) expect(JSON.parse(await readFile(join(active.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token)
            .toBe('refreshed-access-1');
    });

    it('settles both acknowledgments when an identical Run attempt is retried during its pending exchange', async () => {
        const materialized = await scenario.materialize();
        createRefreshCoordinator();
        const gate = scenario.holdProviderExchange();
        const request = refreshRequest(materialized);
        const first = scenario.bridge.refreshRuntimeAuth(request);
        await gate.entered;
        const duplicate = scenario.bridge.refreshRuntimeAuth(request);
        gate.resume();
        const firstProof = await first;
        expect(firstProof).toMatchObject({ status: 'refreshed' });
        expect(await duplicate).toEqual(firstProof);
        expect(scenario.providerExchanges()).toBe(1);
    });

    it('refuses a refreshed proof when writing the exact retained native home fails', async () => {
        const materialized = await scenario.materialize();
        createRefreshCoordinator();
        if (!materialized.env.CODEX_HOME) throw new Error('Expected retained native home');
        const targetParent = dirname(materialized.env.CODEX_HOME);
        await rename(targetParent, `${targetParent}.previous`);
        await writeFile(targetParent, 'synthetic non-directory target parent');
        try {
            const result = await scenario.bridge.refreshRuntimeAuth(refreshRequest(materialized));
            expect(result.status).not.toBe('refreshed');
            expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)?.connectedServiceSelections[0]?.credentialRevision).toBe(revision);
            expect(scenario.providerExchanges()).toBe(1);
        } finally {
            await rm(targetParent);
            await rename(`${targetParent}.previous`, targetParent);
        }
    });

    it('refuses a proof for a newer group generation even when the account remains the same', async () => {
        const materialized = await scenario.materialize();
        createRefreshCoordinator();
        const gate = scenario.holdProviderExchange();
        const pending = scenario.bridge.refreshRuntimeAuth(refreshRequest(materialized));
        await gate.entered;
        scenario.advanceGroupGeneration();
        gate.resume();
        expect((await pending).status).not.toBe('refreshed');
        expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)?.connectedServiceSelections[0]?.credentialRevision).toBe(revision);
    });

    it.each(['same_runner', 'runner_replaced', 'member_changed'] as const)('fences genuine Session %s adoption across a cached acknowledgment and a second exchange', async (transition) => {
        const sessionId = 'genuine-refresh-session';
        const sessionPid = 4343;
        const materializeProfile = async (profileId: string) => await resolveConnectedServiceAuthForSpawn({ agentId: 'codex', sessionId, materializationKey: sessionId,
            connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId } } },
            activeServerDir: join(scenario.root, 'server'), baseDir: scenario.baseDir, credentials: scenario.credentials,
            api: scenario.api, nowMs: () => 1_000,
            qualifiedConnectedAccountApi: scenario.qualifiedConnectedAccountApi,
            processEnv: { NODE_ENV: 'test', HOME: scenario.root, CODEX_HOME: join(scenario.root, 'native-source') },
            resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: 'codex', bindings, contributions: scenario.runtimeRegistry.contributes,
            }),
            activateQualifiedPurposeBindings: (snapshot) => scenario.purposeOwner.activateSessionPurposeBindings({
                sessionId, purposes: snapshot.purposes, bindings: snapshot.bindings,
            }),
        });
        const launchMaterialized = await materializeProfile('second');
        if (!launchMaterialized?.env.CODEX_HOME) throw new Error('Expected account A launch home');
        const launchAuthPath = join(launchMaterialized.env.CODEX_HOME, 'auth.json');
        const launchAuth = await readFile(launchAuthPath, 'utf8');
        expect(JSON.parse(launchAuth).tokens.account_id).toBe('test-account-second');
        await launchMaterialized.materializationPurposeLease?.dispose();
        const materialized = await materializeProfile('first');
        if (!materialized) throw new Error('Expected genuine Session materialization');
        expect(materialized.env.CODEX_HOME).not.toBe(launchMaterialized.env.CODEX_HOME);
        scenario.runtimeTargetRegistry.registerTarget({ pid: sessionPid, agentId: 'codex', sessionId, materializationKey: sessionId,
            connectedServicesBindingsRaw: materialized.connectedServicesBindings, connectedServiceSelectionsEnv: materialized.env });
        const coordinator = createRefreshCoordinator(async () => {
            const target = scenario.runtimeTargetRegistry.getBySessionId(sessionId);
            if (!target) throw new Error('Expected Session target during native auth application');
            const selectedEnv = serializeConnectedServiceChildSelectionValues(target.connectedServiceSelections.map((selection) => ({
                ...selection, credentialRevision: scenario.credentialRevisions.get('first')!,
                ...(transition === 'member_changed' && selection.kind === 'profile' ? { profileId: 'second' } : {}),
            })));
            if (!selectedEnv) throw new Error('Expected refreshed Session selection');
            // This is the same canonical registration performed by the real hot-apply
            // owner before its onAuthUpdated callback returns, not a mocked settlement.
            coordinator.registerSpawnTarget({ ...target, agentId: 'codex', materializationKey: sessionId,
                connectedServiceSelectionsEnv: { ...target.connectedServiceSelectionsEnv,
                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: selectedEnv } });
            if (transition === 'runner_replaced') scenario.revokeRunner();
        });
        const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry: scenario.runtimeTargetRegistry,
            resolveDaemonAuthBridge: scenario.resolveDaemonAuthBridge, captureSessionAuthority: scenario.captureSessionAuthority });
        const request = { sessionId, refreshAttemptId: 'session-refresh-1', expectedCredentialRevision: revision,
            selection: { kind: 'profile' as const, serviceId, profileId: 'first' } };
        const gate = scenario.holdProviderExchange();
        try {
            const firstRefresh = handler(request);
            await gate.entered;
            const duplicateRefresh = handler(request);
            gate.resume();
            const first = await firstRefresh;
            if (transition !== 'same_runner') {
                expect(first).toMatchObject({ ok: false, errorCode: 'connected_service_session_refresh_forbidden' });
                expect(await duplicateRefresh).toMatchObject({ ok: false, errorCode: 'connected_service_session_refresh_forbidden' });
                return;
            }
            expect(first).toEqual({ ok: true, result: { status: 'refreshed', result: {
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                accessToken: 'refreshed-access-1', providerAccountId: 'test-account-first',
            } } });
            expect(await duplicateRefresh).toEqual(first);
            expect(await handler(request)).toEqual(first);
            expect(scenario.providerExchanges()).toBe(1);
            expect(await handler({ ...request, refreshAttemptId: 'session-refresh-2', expectedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }))
                .toEqual({ ok: true, result: { status: 'refreshed', result: {
                    credentialRevision: 'csr_cccccccccccccccccccccc',
                    accessToken: 'refreshed-access-2', providerAccountId: 'test-account-first',
                } } });
            expect(scenario.providerExchanges()).toBe(2);
            expect(JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token).toBe('refreshed-access-2');
            expect(scenario.runtimeTargetRegistry.getBySessionId(sessionId)?.connectedServiceSelections[0]?.credentialRevision).toBe('csr_cccccccccccccccccccccc');
            expect(await readFile(launchAuthPath, 'utf8')).toBe(launchAuth);
        } finally {
            gate.resume();
            scenario.runtimeTargetRegistry.unregisterPid(sessionPid);
            await materialized.materializationPurposeLease?.dispose();
            await materialized.cleanupOnExit?.();
            await launchMaterialized.materializationPurposeLease?.dispose();
            await launchMaterialized.cleanupOnExit?.();
        }
    });
});
