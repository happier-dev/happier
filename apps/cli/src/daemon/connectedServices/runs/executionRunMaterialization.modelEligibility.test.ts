import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
} from '@happier-dev/protocol';
import type { AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
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
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { ExecutionRunRejectedStartError } from '@/agent/runtime/bridges/executionRun/errors';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, serializeConnectedServiceChildSelectionValues } from '../connectedServiceChildEnvironment';
import { getConnectedServiceRuntimeAuthAdapter } from '../catalogHooks';
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
import { requestExecutionRunConnectedServiceRuntimeAuthRefresh } from '@/daemon/controlClient';
import { deriveConnectedServiceRunMaterializeToken } from './capabilityToken';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

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
            if (method === 'account/read') return { account: null };
            if (method === 'account/rateLimits/read') return { rateLimits: {} };
            return {};
        },
        notify: async () => undefined,
        onRequest: () => ({ dispose() {} }),
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
    const credentialReads: string[] = [];
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
    const readCredential = async ({ ref }: { ref: QualifiedConnectedAccountRef }) => {
        credentialReads.push(ref.accountId);
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
    const authAdapter = await getConnectedServiceRuntimeAuthAdapter('codex');
    if (!authAdapter) throw new Error('Admitted Codex classifier unavailable');
    const engine = await resolveBackendEngineAdapterResolution('codex');
    if (!engine) throw new Error('Admitted Codex engine unavailable');
    const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
        token: credentials.token, quotaFreshnessMs: 60_000, nowMs: () => 1_000,
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
        resolveAuthForSpawn: (input) => resolveConnectedServiceAuthForSpawn({ ...input,
            activeServerDir: join(root, 'server'), baseDir, credentials, api, nowMs: () => 1_000,
            processEnv: { HOME: root, CODEX_HOME: join(root, 'native-source') },
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
        unregisterRunTargets: (runKey) => runtimeTargetRegistry.unregisterRunKey(runKey),
        getRunRuntimeTarget: (runKey) => runtimeTargetRegistry.getRunTargetByRunKey(runKey),
        adoptRunCredentialRevision: (input) => runtimeTargetRegistry.adoptExactCredentialRevisionForRun(input),
        resolveRunCredentialRevisionTarget: (input) => runtimeTargetRegistry.resolveExactRunCredentialRevisionTarget(input),
        resolveDaemonAuthBridge,
        resolveRunMaterializedRoot: ({ runKey, agentId }) => resolveConnectedServiceMaterializedRootDir({ baseDir, agentId, materializationKey: runKey }),
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: () => ({ identity: runnerIdentity, parentSessionId: 'actual-parent-session', isCurrent: () => runnerCurrent }),
        acquireAgentPurposeContributions: async ({ agentId }) => {
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            return { contributions: lease.registry.contributes, isCurrent: () => pluginReloadController.isRuntimeRegistryCurrent(lease.registry),
                release: lease.release, resolveAgentContributionIdentity: async () => {
                    const identity = lease.registry.contributes.agentDefinitionsById.get(agentId)?.identity;
                    const sourceCustody = identity && lease.registry.readPluginSourceCustody?.(identity.pluginId);
                    return identity && sourceCustody ? { ...identity, sourceCustody } : null;
                } };
        },
        purposeBindingOwner: purposeOwner, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427, createRedactionLease: () => ({ add() {}, close() {} }),
        clearTerminalCleanupReceipt: async () => undefined,
    });
    const materialize = async (requestedRunId = runId): Promise<Materialization> => {
        const result = await bridge.materialize({ runId: requestedRunId, runnerPid, agentId: 'codex', cwd: root, modelId,
            connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'pool' } } } });
        if (!result.ok) throw Object.assign(new Error(result.errorMessage), { executionRunErrorCode: result.errorCode });
        return result;
    };
    const classification = (materialization: Materialization) => {
        const selection = readConnectedServiceChildSelectionsFromEnv(materialization.env)?.get(serviceId);
        if (selection?.kind !== 'group') throw new Error('Expected materialized pool selection');
        const classified = authAdapter.classifyRuntimeAuthFailure({ target: { agentId: 'codex' },
            error: { message: `model '${modelId}' is not enabled in rustponsesapi` },
            selection,
        });
        if (!classified) throw new Error('Expected explicit model entitlement classification');
        // Provider source correlation is the exact identity supplied to this Agent
        // occurrence, as in the native diagnostic producer; the classifier owns prose.
        return { ...classified, groupGeneration: selection.generation, expectedCredentialRevision: selection.credentialRevision };
    };
    return { bridge, coordinator, materialize, classification, commits, credentialReads, engine,
        root, baseDir, credentials, established, api, records, credentialRevisions, credentialMetadata, readCredential, runtimeTargetRegistry,
        purposeOwner, resolveDaemonAuthBridge,
        captureSessionAuthority: () => ({ identity: runnerIdentity, isCurrent: () => runnerCurrent }),
        qualifiedConnectedAccountApi: { readGroup: async () => currentGroup, listAccounts: async () => accounts },
        setRefreshCoordinator: (value: ConnectedServiceRefreshCoordinator) => { nativeRefreshCoordinator = value; },
        providerExchanges: () => providerExchanges,
        holdProviderExchange() {
            let resume!: () => void;
            const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
            providerGate = new Promise<void>((resolve) => { resume = resolve; });
            return { entered, resume: () => { resume(); providerGate = null; providerEntered = null; } };
        },
        runtimeRegistry: runtimeLease.registry,
        group: () => currentGroup, revokeRunner: () => { runnerCurrent = false; },
        advanceGroupGeneration() { currentGroup = QualifiedConnectedAccountGroupV4Schema.parse({ ...currentGroup, generation: currentGroup.generation + 1 }); },
        reset() {
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
            expect(scenario.credentialReads).toEqual(expectedMembers);
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
            processEnv: { HOME: scenario.root, CODEX_HOME: join(scenario.root, 'native-source') },
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
        expect(result).toEqual({ status: 'refreshed', result: { credentialRevision: updatedRevision } });
        expect(scenario.runtimeTargetRegistry.getRunTargetByRunKey(runId)).not.toBe(originalTarget);
        const auth = JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8'));
        expect(auth.tokens.access_token).toBe('refreshed-access-1');
        expect(auth.tokens.account_id).toBe('test-account-first');
        // The original response may be lost after the daemon settles. The same scoped
        // attempt with its original basis must recover the proof without rotating again.
        expect(await requestExecutionRunConnectedServiceRuntimeAuthRefresh(request, { target, timeoutMs: 120_000 })).toEqual(result);
        expect(scenario.providerExchanges()).toBe(1);
        expect(await scenario.bridge.refreshRuntimeAuth({ ...request, refreshAttemptId: 'unadmitted-old-basis' })).toMatchObject({ status: 'unavailable' });
        expect(await scenario.bridge.refreshRuntimeAuth({ ...request, refreshAttemptId: 'native-proof-2', expectedCredentialRevision: updatedRevision }))
            .toEqual({ status: 'refreshed', result: { credentialRevision: 'csr_cccccccccccccccccccccc' } });
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
        const targetParent = dirname(resolveConnectedServiceMaterializedRootDir({ baseDir: scenario.baseDir, agentId: 'codex', materializationKey: runId }));
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
        const materialized = await resolveConnectedServiceAuthForSpawn({ agentId: 'codex', sessionId, materializationKey: sessionId,
            connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'profile', profileId: 'first' } } },
            activeServerDir: join(scenario.root, 'server'), baseDir: scenario.baseDir, credentials: scenario.credentials,
            api: scenario.api, nowMs: () => 1_000,
            qualifiedConnectedAccountApi: scenario.qualifiedConnectedAccountApi,
            processEnv: { HOME: scenario.root, CODEX_HOME: join(scenario.root, 'native-source') },
            resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                agentId: 'codex', bindings, contributions: scenario.runtimeRegistry.contributes,
            }),
            activateQualifiedPurposeBindings: (snapshot) => scenario.purposeOwner.activateSessionPurposeBindings({
                sessionId, purposes: snapshot.purposes, bindings: snapshot.bindings,
            }),
        });
        if (!materialized) throw new Error('Expected genuine Session materialization');
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
            expect(first).toEqual({ ok: true, result: { status: 'refreshed', result: { credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' } } });
            expect(await duplicateRefresh).toEqual(first);
            expect(await handler(request)).toEqual(first);
            expect(scenario.providerExchanges()).toBe(1);
            expect(await handler({ ...request, refreshAttemptId: 'session-refresh-2', expectedCredentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' }))
                .toEqual({ ok: true, result: { status: 'refreshed', result: { credentialRevision: 'csr_cccccccccccccccccccccc' } } });
            expect(scenario.providerExchanges()).toBe(2);
            expect(JSON.parse(await readFile(join(materialized.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token).toBe('refreshed-access-2');
            expect(scenario.runtimeTargetRegistry.getBySessionId(sessionId)?.connectedServiceSelections[0]?.credentialRevision).toBe('csr_cccccccccccccccccccccc');
        } finally {
            gate.resume();
            scenario.runtimeTargetRegistry.unregisterPid(sessionPid);
            await materialized.materializationPurposeLease?.dispose();
            await materialized.cleanupOnExit?.();
        }
    });
});
