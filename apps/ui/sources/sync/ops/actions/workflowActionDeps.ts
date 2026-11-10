import { createUiSessionRead } from './sessionReadAction';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowActionOutputSchemasV1, WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowActionExecute } from '@happier-dev/protocol/actions/executor/types';
import { isWorkflowTriggerAgentCallerV1, type WorkflowTriggerActionsDependencies } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import type { AutomationTemplateRetainedSessionV1 } from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { WorkflowStepExecutionSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import {
    createAccountWorkflowTriggerActions,
    createWorkflowActionExecutor,
    createWorkflowDefinitionActions,
    createWorkflowAccountRunActionOwner,
    type WorkflowTriggerAutomationOperations,
} from '@happier-dev/protocol/actions';
import {
    SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
    SessionPullRequestBindingInputV1Schema,
    SessionPullRequestBindingResultV1Schema,
    SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1,
    SessionPullRequestWatchReadResultV1Schema,
    resolveDistinctPullRequestLinksV1,
    type SessionPullRequestBindingInputV1,
} from '@happier-dev/channels-protocol/v1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isWorkflowHostAdmittedChildActionIdV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { ActionExecuteFailureSchema, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { isServerFeaturesProbeRetryable } from '@/sync/api/capabilities/serverFeaturesProbeRetryability';
import { isExplicitlyRetryableError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { createWorkflowRunAccountStorage } from '@/sync/api/automations/apiWorkflowRunStorage';
import { createUiDeploymentActionDeps } from '@/sync/api/deployments/deploymentActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import {
    AutomationApiError,
    createAutomationDefinition,
    deleteAutomationDefinition,
    getAutomationDefinition,
    listAutomationDefinitions,
    listAutomationDefinitionDetails,
    reconcileAutomationDefinition,
    runAutomationDefinitionNow,
} from '@/sync/api/automations/apiAutomations';
import { deriveAccountScopedCryptoMaterialSnapshot, resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { invalidateAutomationReadAcquisitions } from '@/sync/api/automations/apiAutomationHttp';
import { AutomationRunStateV3Schema } from '@happier-dev/protocol/automations/automationRunStateV3';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionByIdHttp } from '@/sync/engine/sessions/sessionByIdHttp';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { randomUUID } from '@/platform/randomUUID';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { parseCompatSessionByIdResponse } from '@/sync/engine/sessions/sessionHttpCompat';
import { createSessionDataKeyHydrationPlan, hydrateSessionDataKeys, readSessionDataKeyCredentialKind } from '@/sync/encryption/sessionDataKeyHydration';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import type { WorkflowActionTransport } from './workflowActionTransport';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { executeDefaultActionInCapturedAccount } from './defaultActionExecutor';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { prepareRequesterSessionForSpawn } from './requesterSessionSpawnPreparation';
import { sealSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

function targetUnavailable(): never {
    throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
}

/**
 * Resolves a Session for its trigger set under the captured Home. A missing owner projection
 * is hydrated through the canonical exact-Home reader without publishing into UI state. Only an opened
 * runtime's native-goal ownership is host-dependent, so only that check reaches the Session's
 * Machine (the same `session.goal.get` live path the CLI host reads); a closed Session needs none.
 */
export function createUiTriggerSessionResolver(account: LazyActionAccountContext): NonNullable<WorkflowTriggerActionsDependencies['resolveSession']> {
    return async (sessionId, caller, options) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, account.serverId)) targetUnavailable();
        const cachedSession = storage.getState().sessions[sessionId];
        const cachedOwner = cachedSession ? readSessionOwnerMetadataView(cachedSession) : null;
        const signal = caller?.signal ?? account.invocationSignal;
        const session = cachedOwner?.machineId?.trim() && cachedOwner.path?.trim() ? cachedSession
            : await runWithServerRequestAuthorityForServerAccountScope({
                scope: account.accountLifetime.scope, activeRequest: account.request,
            }, async (authority) => (await readSessionSnapshotForAuthority({
                authority: { ...authority, request: (path, init, options) => authority.request(path,
                    { ...init, ...(signal ? { signal } : {}) }, options) },
                sessionId, isCurrent: account.accountLifetime.isCurrent,
            })).session);
        account.assertCurrent();
        throwIfAborted(signal);
        const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
        const machineId = ownerMetadata?.machineId?.trim();
        const directory = ownerMetadata?.path?.trim();
        if (!session || !machineId || !directory) targetUnavailable();
        const agentTarget = resolveSessionActionDefaultBackend({ session })?.agentTarget;
        const selection = agentTarget ? WorkflowStepExecutionSelectionSchema.safeParse({
            agentTarget, ...(ownerMetadata?.permissionMode ? { permissionMode: ownerMetadata.permissionMode } : {}),
        }) : null;
        const facts = { project: { machineId, directory }, ...(selection?.success ? { executionSelection: selection.data } : {}) };
        if (session.active !== true) return { ...facts, nativeGoalOwner: false };
        if (options?.checkNativeGoalOwner !== true) return { ...facts, nativeGoalOwner: null };
        const observed = await withActionAccountRequestSignal(account, caller?.signal, signal => sessionRpcWithServerScope<unknown, { capabilitiesOnly: true }>({
            sessionId, serverId: account.serverId, method: SESSION_RPC_METHODS.SESSION_GOAL_GET, payload: { capabilitiesOnly: true },
            timeoutMs: null, signal,
        })).catch(() => null);
        account.assertCurrent();
        const nativeGoalOwner = observed !== null && typeof observed === 'object' && 'nativeGoalOwner' in observed
            && typeof observed.nativeGoalOwner === 'boolean' ? observed.nativeGoalOwner : null;
        return { ...facts, nativeGoalOwner };
    };
}

/** Compose Account content owners and the existing exact-Machine effect relay. */
export function createUiWorkflowAction(params: Readonly<{
    account: LazyActionAccountContext;
    transport?: WorkflowActionTransport;
}>): WorkflowActionExecute {
    const account = params.account;
    const executeRelay = createUiAccountAction(params);
    // Account authoring stays local. Only shared targets need the existing
    // private installation channel to retain the requester's own sign-in.
    const deliverRequesterCustody = async (operation: 'retain' | 'retire',
        input: Parameters<NonNullable<WorkflowAccountRunActionDeps['workflowRequesterCustody']>['retain']>[0]) => {
        account.assertCurrent();
        const readTransport = account.readTransport;
        if (!readTransport) targetUnavailable();
        const machine = (await readMachineRows({ readTransport,
            machineIds: [input.machineId], signal: account.invocationSignal })).get(input.machineId);
        account.assertCurrent();
        if (!machine?.access) targetUnavailable();
        if (machine.access.custodian.accountId === account.accountId) return;
        const installationId = machine.installationId;
        const installationPublicKey = readMachineInstallationPublicKey(machine.installationPublicKey);
        if (!installationId || !installationPublicKey) targetUnavailable();
        const requesterBootstrap = await prepareRequesterSessionForSpawn({ accountContext: account });
        const payload = sealSessionRequesterBootstrapRpcRequestV1({ request: {
            kind: 'requester_session_bootstrap_v1', scope: 'workflow_trigger',
            input: { executionTarget: { serverId: account.serverId, machineId: input.machineId },
                scopeId: input.scopeId, ...(input.automationId ? { automationId: input.automationId } : {}), operation }, requesterBootstrap,
        }, installationId, installationPublicKey, randomBytes: getRandomBytes });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId, serverId: account.serverId, accountId: account.accountId,
            method: RPC_METHODS.SESSION_SPAWN_NEW, payload, requireEncryptedPayload: true,
            signal: account.invocationSignal, operationTimeoutMs: null,
        });
        account.assertCurrent();
        if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) targetUnavailable();
    };
    const workflowRequesterCustody: NonNullable<WorkflowAccountRunActionDeps['workflowRequesterCustody']> = {
        retain: input => deliverRequesterCustody('retain', input),
        retire: input => deliverRequesterCustody('retire', input),
    };
    const resolveSession = createUiTriggerSessionResolver(account);
    const invokePullRequestBinding = async (
        input: Extract<SessionPullRequestBindingInputV1, { kind: 'attach' | 'removeTrigger' }> & Readonly<{ sessionId: string }>,
        caller: Parameters<typeof resolveSession>[1],
    ) => {
        if (!caller) targetUnavailable();
        const { project } = await resolveSession(input.sessionId, caller);
        const result = await executeRelay({
            actionId: 'action.invoke',
            input: { action: { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 },
                input: SessionPullRequestBindingInputV1Schema.parse(input) },
            context: { ...caller, serverId: account.serverId, runtimeAccountId: account.accountId,
                defaultSessionId: input.sessionId, externalActionTarget: { kind: 'machine', machineId: project.machineId } },
            ...(caller.signal ? { signal: caller.signal } : {}),
        });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        if (failure.success) throw Object.assign(new Error(failure.data.error),
            { code: failure.data.errorCode, ...(failure.data.details === undefined ? {} : { details: failure.data.details }) });
        const parsed = SessionPullRequestBindingResultV1Schema.safeParse(result);
        if (!parsed.success) targetUnavailable();
        return parsed.data;
    };
    const current = async <T>(operation: () => Promise<T>): Promise<T> => {
        account.assertCurrent();
        const result = await operation();
        account.assertCurrent();
        return result;
    };
    // Trigger sets are Account-persisted Automations: the captured Home's HTTP
    // owner serves them with no Machine reachable (03 §3.1).
    const automations: WorkflowTriggerAutomationOperations = {
        list: (input) => current(() => listAutomationDefinitions(account.credentials, input, account)),
        listDetails: (input) => current(() => listAutomationDefinitionDetails(account.credentials, input, account)),
        get: (automationId) => current(async () => {
            try {
                return await getAutomationDefinition(account.credentials, automationId, account);
            } catch (error) {
                if (error instanceof AutomationApiError && error.status === 404) return null;
                throw error;
            }
        }),
        create: (input) => current(() => createAutomationDefinition(account.credentials, input, account)),
        reconcile: (automationId, input) => current(() => reconcileAutomationDefinition(account.credentials, automationId, input, account)),
        delete: (automationId) => current(() => deleteAutomationDefinition(account.credentials, automationId, account)),
        runNow: (automationId, options) => current(() => runAutomationDefinitionNow(account.credentials, automationId, account, options)),
    };
    const definitions = createWorkflowDefinitionActions({
        artifactStore: account.workflowArtifacts,
        readWorkflowTriggerSummaries: (definitionIds) => triggers.readWorkflowSummaries(definitionIds),
        encodeListCursor: account.encodeArtifactListCursor,
        readPluginWorkflows: async () => {
            account.assertCurrent();
            const machineId = resolveUiAccountActionFallbackMachineId(account);
            if (!machineId) return [];
            const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: account.serverId,
                accountLifetime: account.accountLifetime, reuseFreshReady: true, sections: ['familiesById.workflows'] });
            account.assertCurrent();
            // A failed/retained projection does not become a current plugin source.
            // Account Artifacts remain readable when the serving daemon is absent.
            if (entry?.kind !== 'ready') return [];
            return Object.values(entry.inputs.pluginProjectionV2?.familiesById.workflows?.entriesById ?? {}).flatMap((workflow) =>
                workflow.pluginId ? [projectWorkflowPluginSourceV1({ pluginId: workflow.pluginId,
                    pluginVersion: workflow.pluginVersion, definition: workflow.definition })] : []);
        },
        removeWorkflowTriggers: (definitionId) => triggers.removeForWorkflow(definitionId),
        assertDefinitionWriteAllowed: (_definition, _context, caller) => {
            // Other callers retain the canonical host authorization/materializer.
            if (caller?.authority !== 'present_user') {
                throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
        },
    });
    const resolveMaterial = () => deriveAccountScopedCryptoMaterialSnapshot(account.credentials, account.serverId);
    const resolveEncryption = async (signal?: AbortSignal) => {
        account.assertCurrent();
        const resolved = await resolveValidatedAutomationAccountEncryptionV1({
            signal: signal ?? new AbortController().signal,
            resolveAccountEncryptionCurrentness: async (signal) => await fetchAccountEncryptionCurrentness(account.credentials, { request: account.request, signal }),
            resolveAccountEncryptionMaterial: async () => resolveMaterial(),
        });
        account.assertCurrent();
        if (resolved.kind === 'unavailable' && 'cause' in resolved && isExplicitlyRetryableError(resolved.cause)) throw resolved.cause;
        if (resolved.kind !== 'available') {
            throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        }
        return resolved;
    };
    const runStorage = createWorkflowRunAccountStorage(account);
    const runs = createWorkflowAccountRunActionOwner({
        definitions,
        storage: {
            ...runStorage,
            observeChanges: (runId, onChange, onError) => {
                account.assertCurrent();
                const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
                    lifetime: account.accountLifetime, runId,
                    isVisibleWindowLoaded: () => true, invalidate: onChange,
                });
                const retirement = account.accountLifetime.onRetire(() => onError(new Error('action_account_scope_changed')));
                return { dispose: () => { retirement.dispose(); unsubscribe(); } };
            },
        },
        assertCurrent: account.assertCurrent,
        resolveAccountId: async () => { account.assertCurrent(); return account.accountId; },
        resolveEncryption,
        resolveReadEncryption: async (signal): Promise<WorkflowRunReadEncryptionV1> => {
            throwIfAborted(signal);
            const { encryption } = await account.resolveAccountEncryption();
            const current = await resolveAccountStorageContext(account.credentials, {
                encryption, request: account.request, usage: 'identity',
            });
            account.assertCurrent();
            throwIfAborted(signal);
            return current.mode === 'plain' ? { witness: { mode: 'plain' } }
                : { witness: { mode: 'e2ee' }, material: resolveMaterial() };
        },
        normalizeAbsolutePath: resolveAbsolutePath,
        sessionRead: createUiSessionRead(account),
        sessionList: async (input) => {
            account.assertCurrent();
            const result = await listSessionsForVoiceTool({ ...input, serverId: input.serverId ?? account.serverId });
            account.assertCurrent();
            return result;
        },
        randomBytes: getRandomBytes,
    });
    const triggers = createAccountWorkflowTriggerActions({
        workflowRequesterCustody,
        sessionRead: createUiSessionRead(account),
        automations,
        deploymentAction: createUiDeploymentActionDeps(account).deploymentAction,
        nativeAccount: { accountId: account.accountId, serverId: account.serverId,
            isCurrent: async () => account.credentialAuthorityKind === 'account' && account.accountLifetime.isCurrent() },
        sessionList: async (input) => {
            account.assertCurrent();
            const result = await listSessionsForVoiceTool({ ...input, serverId: account.serverId });
            account.assertCurrent();
            return result;
        },
        resolveEncryption: () => resolveEncryption(),
        resolveRetainedSession: async (sessionId): Promise<AutomationTemplateRetainedSessionV1 | null> => {
            account.assertCurrent();
            const response = await withActionAccountRequestSignal(account, account.invocationSignal, signal => readSessionByIdHttp({ sessionId, serverId: account.serverId,
                token: account.credentials.token, accessProjectionVersion: 1, readTransport: account.readTransport,
                request: (path, init) => account.request(path, init, { includeAuth: false }),
                signal }));
            account.assertCurrent();
            if (!response.ok) return null;
            const session = parseCompatSessionByIdResponse(response.body)?.session;
            account.assertCurrent();
            if (!session || session.id !== sessionId || (session.encryptionMode !== 'plain' && session.encryptionMode !== 'e2ee')) return null;
            if (session.encryptionMode === 'plain') return { sessionId, encryptionMode: 'plain' };
            const locked = { sessionId, encryptionMode: 'e2ee' as const };
            const credentialKind = readSessionDataKeyCredentialKind(account.credentials);
            if (credentialKind === 'keyless') return locked;
            const encryption = await createEncryptionFromAuthCredentials(account.credentials);
            account.assertCurrent();
            // The Session crypto owner opens this authenticated envelope with no cached-key admission.
            const hydrated = await hydrateSessionDataKeys({
                plan: createSessionDataKeyHydrationPlan({ sessions: [session], credentialKind, sessionDataKeys: new Map() }),
                encryption, sessionDataKeys: new Map(), scope: { accountId: account.accountId, serverId: account.serverId },
                shouldContinue: account.accountLifetime.isCurrent,
            });
            account.assertCurrent();
            const state = hydrated.states.get(sessionId);
            return !hydrated.stale && (state === 'ready' || state === 'legacy_fallback_ready')
                ? { ...locked, material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials) }
                : locked;
        },
        randomBytes: getRandomBytes,
        newId: randomUUID,
        resolveWorkflow: async (ref) => {
            const resolved = await resolveWorkflowDefinitionRefV1(ref, {
                readPluginWorkflows: definitions.readPluginWorkflows,
                readArtifact: (definitionId, signal) => definitions.get({ definitionId, ...(signal ? { signal } : {}) }),
            });
            if (!resolved) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
            return resolved;
        },
        resolveWorkflowTeamIds: async (artifactId) => {
            const result = await account.artifactAccessGrants.list({ artifactId });
            return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
        },
        resolveSession,
        resolveManagedMachine: async (input, caller) => {
            account.assertCurrent();
            if (input.homeId !== account.serverIdentityId) targetUnavailable();
            const response = await account.request(managedMachineActionEndpointPathV1('machines.managed.get'), {
                method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(input), ...(caller?.signal ? { signal: caller.signal } : {}),
            }, { includeAuth: false });
            account.assertCurrent();
            if (!response.ok) targetUnavailable();
            return ManagedGetOutputV1Schema.parse(await response.json());
        },
        pullRequests: {
            listLinks: async (sessionId, caller) => {
                const result = await current(() => executeDefaultActionInCapturedAccount(account, 'action.invoke', {
                    action: { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 },
                    input: { kind: 'get', sessionId },
                }, { ...caller, surface: caller?.surface ?? 'ui', defaultSessionId: sessionId }));
                if (!result.ok) targetUnavailable();
                const metadata = SessionPullRequestWatchReadResultV1Schema.safeParse(result.result);
                if (!metadata.success || metadata.data.kind !== 'ready' || metadata.data.sessionId !== sessionId) targetUnavailable();
                return resolveDistinctPullRequestLinksV1(metadata.data.bindings.map(binding => binding.link)).slice();
            },
            attach: async ({ sessionId, pullRequest, automationId, triggerId, triggerRevision, triggerKind }, caller) => {
                const result = await invokePullRequestBinding({ kind: 'attach', sessionId, pullRequest,
                    target: { automationId, triggerId, triggerRevision, triggerKind } }, caller);
                if (result.kind !== 'attached') targetUnavailable();
            },
            removeTrigger: async ({ sessionId, triggerId }, caller) => {
                const result = await invokePullRequestBinding({ kind: 'removeTrigger', sessionId, triggerId }, caller);
                if (result.kind !== 'removed') targetUnavailable();
            },
        },
        resolveRunSource: async (source, caller) => {
            account.assertCurrent();
            if (source.kind === 'workflow_run') {
                // The existing Account storage read authorizes the exact Run;
                // no private opening or lifecycle fact is invented by this adapter.
                const result = await runStorage.execute({ operation: 'get', runId: source.runId },
                    caller?.signal ? { signal: caller.signal } : undefined);
                const run = WorkflowRunSummaryV1Schema.safeParse(result && typeof result === 'object' && 'run' in result ? result.run : undefined);
                if (!run.success || run.data.id !== source.runId) targetUnavailable();
                account.assertCurrent();
                return { terminal: isTerminalAutomationRunStateV3(run.data.state) };
            } else {
                const result = await executeRelay({ actionId: 'execution.run.get', input: { runId: source.runId },
                    context: { ...caller, surface: caller?.surface ?? 'ui', serverId: account.serverId, runtimeAccountId: account.accountId,
                        ...(source.sessionId ? { defaultSessionId: source.sessionId } : {}),
                        externalActionTarget: { kind: 'machine', machineId: source.machineId } } });
                const failure = ActionExecuteFailureSchema.safeParse(result);
                if (failure.success) throw Object.assign(new Error(failure.data.error), { code: failure.data.errorCode });
                const run = ExecutionRunGetResponseSchema.safeParse(result);
                if (!run.success || run.data.run.runId !== source.runId) targetUnavailable();
                account.assertCurrent();
                return { terminal: isExecutionRunTerminalStatus(run.data.run.status) };
            }
        },
    });
    const isWorkflowFeatureEnabled = async () => {
        const [snapshot, settings] = await Promise.all([
            getServerFeaturesSnapshot({ serverId: account.serverId }),
            account.readSettings(),
        ]);
        const decision = resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'workflows', settings, snapshot });
        if (decision?.state === 'unknown' && isServerFeaturesProbeRetryable(snapshot)) {
            throw Object.assign(new Error('storage_unavailable'), { code: 'storage_unavailable' });
        }
        return decision?.state === 'enabled';
    };
    const executeAccount = createWorkflowActionExecutor({ definitions, runs, triggers, isWorkflowFeatureEnabled });
    const unavailable = { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' } as const;
    return async (rawArgs) => {
        try { account.assertCurrent(); } catch { return unavailable; }
        if (!areServerProfileIdentifiersEquivalent(rawArgs.context.serverId, account.serverId)
            || rawArgs.context.runtimeAccountId !== account.accountId) return unavailable;
        const args = rawArgs.context.serverId === account.serverId ? rawArgs
            : { ...rawArgs, context: { ...rawArgs.context, serverId: account.serverId } };
        const ordinaryAccountCredential = account.credentialAuthorityKind === 'account' || account.credentialAuthorityKind === 'terminal';
        const restrictedResource = args.context.externalActionTarget && args.context.externalActionTarget.kind !== 'machine';
        const savedOccurrence = args.actionId === 'workflow.trigger.run_now';
        const startingRun = args.actionId === WORKFLOW_RUN_START_ACTION_ID_V1;
        // Prepared recovery publishes executor rows. A present user's trigger
        // reads and writes are Account data served here; any other caller's
        // trigger or definition write consumes the host's agent-start policy
        // and materializer.
        const machineOrHostOperation = startingRun
            || args.actionId === 'workflow.run.invocations.retry'
            || (args.actionId === 'workflow.run.resume' && args.input.mode === 'recover')
            || (savedOccurrence && isWorkflowTriggerAgentCallerV1(args.context))
            || (isWorkflowHostAdmittedChildActionIdV1(args.actionId) && args.context.authority !== 'present_user');
        let result: unknown;
        try {
            const accountOperation = ordinaryAccountCredential && !restrictedResource && !machineOrHostOperation;
            // Account reads are admitted by the Workflow executor; ordinary Machine operations
            // consume the same UI policy before relaying. Scoped credentials keep host admission.
            if (ordinaryAccountCredential && !accountOperation && !await isWorkflowFeatureEnabled()) return unavailable;
            result = await (accountOperation
                ? executeAccount(args) : executeRelay(args));
            if (ordinaryAccountCredential && !restrictedResource && args.actionId === 'workflow.run.invocations.get') {
                const opened = WorkflowInvocationGetResultV1Schema.safeParse(result);
                const retry = opened.success ? opened.data.invocation.recoveryAvailability?.retry : undefined;
                if (opened.success && retry && !(retry.kind === 'unavailable' && retry.reason === 'run_not_interrupted')) {
                    const stored = await runStorage.execute({ operation: 'get', runId: args.input.runId },
                        args.signal ? { signal: args.signal } : undefined).catch(error => {
                        account.assertCurrent();
                        if ((args.signal ?? args.context.signal)?.aborted
                            || (error instanceof AutomationApiError && (error.status === 401 || error.status === 403))) throw error;
                        // This supplemental read supplies native observation placement only.
                        // Keep the opened Account history when that optional read is unavailable.
                        return undefined;
                    });
                    const run = WorkflowRunSummaryV1Schema.safeParse(stored && typeof stored === 'object' && 'run' in stored ? stored.run : undefined);
                    const target = args.context.externalActionTarget;
                    if (run.success && run.data.id === args.input.runId && run.data.state === 'interrupted'
                        && (!target || (target.kind === 'machine' && target.machineId === run.data.machineId))) {
                        // The Machine's existing Run owner observes exact native input/conversation
                        // facts. Its transport reads the exact captured-Home Machine and authorizes
                        // access; a cold or stale presentation inventory cannot decide availability.
                        // A native refusal keeps the already-authorized Account history readable.
                        try {
                            const observed = await executeRelay({ ...args, context: { ...args.context,
                                externalActionTarget: { kind: 'machine', machineId: run.data.machineId } } });
                            if (!ActionExecuteFailureSchema.safeParse(observed).success) result = observed;
                        } catch (error) {
                            account.assertCurrent();
                            if ((args.signal ?? args.context.signal)?.aborted) throw error;
                        }
                    }
                }
            }
        } catch (error) {
            try { account.assertCurrent(); } catch { return unavailable; }
            if (!startingRun) throw error;
            // Only the transport's explicit not-sent witness proves rejection.
            // A missing reply (including timeout) may follow committed admission.
            const code = readRpcRequestDisposition(error) === 'notSent'
                ? 'target_unavailable' : 'workflow_outcome_unresolved';
            return { ok: false, errorCode: code, error: code };
        }
        try { account.assertCurrent(); } catch { return unavailable; }
        if (startingRun) {
            const actionFailure = ActionExecuteFailureSchema.safeParse(result);
            if (actionFailure.success && isActionOutcomeUnknownErrorCodeV1(actionFailure.data.errorCode)) {
                // HTTP issuance can settle as a typed unknown result as well as a
                // thrown transport error. Both retain the reviewed Run admission.
                const { details: _transportDetails, ...failure } = actionFailure.data;
                return { ...failure, errorCode: 'workflow_outcome_unresolved', error: 'workflow_outcome_unresolved' };
            }
        }
        const failure = WorkflowActionFailureV1Schema.safeParse(result);
        if (failure.success) return failure.data;
        if (savedOccurrence) {
            // Project only after the trigger owner has admitted and bound the exact receipt.
            // An addressed Home must not publish private content into another focused Account.
            const receipt = WorkflowActionOutputSchemasV1['workflow.trigger.run_now'].safeParse(result);
            if (receipt.success) {
                if (receipt.data.run.automationId !== args.input.automationId) return unavailable;
                const active = getActiveServerAccountScope();
                if (active?.accountId === account.accountId
                    && areServerProfileIdentifiersEquivalent(active.serverId, account.serverId)) {
                    storage.getState().upsertAutomationRun(receipt.data.run);
                }
                return receipt.data;
            }
            // Pending human approval is not an admission receipt; preserve its existing relay result.
        }
        if (args.actionId === 'workflow.run.cancel') {
            const control = WorkflowActionOutputSchemasV1['workflow.run.cancel'].safeParse(result);
            if (control.success) publishCancelledRun(account, control.data.run);
        }
        return result as Awaited<ReturnType<WorkflowActionExecute>>;
    };
}

/**
 * A committed cancel reaches readers the same way occurrence controls do: pre-cancel
 * Automation read acquisitions are superseded, and the bounded Run projection that
 * occurrence surfaces read carries the returned lifecycle facts. Approval replay runs
 * through this same owner.
 */
function publishCancelledRun(account: LazyActionAccountContext, run: WorkflowRunSummaryV1): void {
    invalidateAutomationReadAcquisitions(account);
    if (!areServerAccountScopesEqual(account.accountLifetime.scope, getActiveServerAccountScope())) return;
    const stored = storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.automation;
    const state = AutomationRunStateV3Schema.safeParse(run.state);
    if (!stored || !state.success || stored.revision >= run.revision) return;
    const finishedAt = run.finishedAt === null ? null : Date.parse(run.finishedAt);
    const updatedAt = Date.parse(run.updatedAt);
    storage.getState().upsertAutomationRun({
        ...stored,
        state: state.data,
        revision: run.revision,
        finishedAt: finishedAt !== null && Number.isFinite(finishedAt) ? finishedAt : stored.finishedAt,
        updatedAt: Number.isFinite(updatedAt) ? Math.max(updatedAt, stored.updatedAt) : stored.updatedAt,
    });
}
