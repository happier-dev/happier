import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceV1';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowActionExecute } from '@happier-dev/protocol/actions/executor/types';
import type { WorkflowTriggerActionsDependencies } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import type { AutomationTemplateRetainedSessionV1 } from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { WorkflowStepExecutionSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import {
    createAccountWorkflowTriggerActions,
    createWorkflowActionExecutor,
    createWorkflowDefinitionActions,
    createWorkflowAccountRunActionOwner,
    removeWorkflowTriggersForDefinition,
    type WorkflowTriggerAutomationOperations,
} from '@happier-dev/protocol/actions';
import {
    SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
    SessionPullRequestBindingInputV1Schema,
    SessionPullRequestBindingResultV1Schema,
    type SessionPullRequestBindingInputV1,
    CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
    ConversationBindingReadResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createWorkflowRunAccountStorage } from '@/sync/api/automations/apiWorkflowRunStorage';
import { readActiveSessionPullRequestLinks } from '@/sync/api/plugins/data/sessionPullRequestLinks';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import {
    AutomationApiError,
    createAutomationDefinition,
    deleteAutomationDefinition,
    getAutomationDefinition,
    listAutomationDefinitions,
    reconcileAutomationDefinition,
} from '@/sync/api/automations/apiAutomations';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { randomUUID } from '@/platform/randomUUID';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { parseCompatSessionByIdResponse } from '@/sync/engine/sessions/sessionHttpCompat';
import { createSessionDataKeyHydrationPlan, hydrateSessionDataKeys, readSessionDataKeyCredentialKind } from '@/sync/encryption/sessionDataKeyHydration';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import type { WorkflowActionTransport } from './workflowActionTransport';

function targetUnavailable(): never {
    throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
}

/**
 * Opens a Session for its trigger set from the captured Home's synced Session. Only an opened
 * runtime's native-goal ownership is host-dependent, so only that check reaches the Session's
 * Machine (the same `session.goal.get` live path the CLI host reads); a closed Session needs none.
 */
function createUiTriggerSessionResolver(account: LazyActionAccountContext): NonNullable<WorkflowTriggerActionsDependencies['resolveSession']> {
    return async (sessionId, _caller, options) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, account.serverId)) targetUnavailable();
        const session = storage.getState().sessions[sessionId];
        const machineId = session?.metadata?.machineId?.trim();
        const directory = session?.metadata?.path?.trim();
        if (!session || !machineId || !directory) targetUnavailable();
        const agentTarget = resolveSessionActionDefaultBackend({ session })?.agentTarget;
        const selection = agentTarget ? WorkflowStepExecutionSelectionSchema.safeParse({
            agentTarget, ...(session.metadata?.permissionMode ? { permissionMode: session.metadata.permissionMode } : {}),
        }) : null;
        const facts = { project: { machineId, directory }, ...(selection?.success ? { executionSelection: selection.data } : {}) };
        if (session.active !== true) return { ...facts, nativeGoalOwner: false };
        if (options?.checkNativeGoalOwner !== true) return { ...facts, nativeGoalOwner: null };
        const observed = await sessionRpcWithServerScope<unknown, { capabilitiesOnly: true }>({
            sessionId, serverId: account.serverId, method: SESSION_RPC_METHODS.SESSION_GOAL_GET, payload: { capabilitiesOnly: true },
        }).catch(() => null);
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
    const resolveSession = createUiTriggerSessionResolver(account);
    const invokePullRequestBinding = async (
        input: Exclude<SessionPullRequestBindingInputV1, { kind: 'list' }>,
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
    };
    const definitions = createWorkflowDefinitionActions({
        artifactStore: account.workflowArtifacts,
        readWorkflowTriggerSummaries: () => triggers.readWorkflowSummaries(),
        encodeListCursor: account.encodeArtifactListCursor,
        readPluginWorkflows: async () => {
            account.assertCurrent();
            const machineId = resolveUiAccountActionFallbackMachineId(account);
            if (!machineId) return [];
            const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: account.serverId,
                accountLifetime: account.accountLifetime, reuseFreshReady: true });
            account.assertCurrent();
            // A failed/retained projection does not become a current plugin source.
            // Account Artifacts remain readable when the serving daemon is absent.
            if (entry?.kind !== 'ready') return [];
            return Object.values(entry.inputs.pluginProjectionV2?.familiesById.workflows?.entriesById ?? {}).flatMap((workflow) =>
                workflow.pluginId ? [projectWorkflowPluginSourceV1({ pluginId: workflow.pluginId,
                    pluginVersion: workflow.pluginVersion, definition: workflow.definition })] : []);
        },
        removeWorkflowTriggers: (definitionId) => removeWorkflowTriggersForDefinition(automations, definitionId),
        assertDefinitionWriteAllowed: (_definition, _context, caller) => {
            // Other callers retain the canonical host authorization/materializer.
            if (caller?.authority !== 'present_user') {
                throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
        },
    });
    const resolveEncryption = async (signal?: AbortSignal) => {
        account.assertCurrent();
        const resolved = await resolveValidatedAutomationAccountEncryptionV1({
            signal: signal ?? new AbortController().signal,
            resolveAccountEncryptionCurrentness: async (signal) => await fetchAccountEncryptionCurrentness(account.credentials, { request: account.request, signal }),
            resolveAccountEncryptionMaterial: async () => createAccountScopedCryptoMaterialSnapshotV1({
                accountEncryptionMode: 'e2ee',
                material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials),
                ...(isDataKeyAuthCredentials(account.credentials)
                    ? { dataKeyPublicKey: decodeBase64(account.credentials.encryption.publicKey, 'base64') } : {}),
            }),
        });
        account.assertCurrent();
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
        normalizeAbsolutePath: resolveAbsolutePath,
        randomBytes: getRandomBytes,
    });
    const triggers = createAccountWorkflowTriggerActions({
        automations,
        resolveEncryption: () => resolveEncryption(),
        resolveRetainedSession: async (sessionId): Promise<AutomationTemplateRetainedSessionV1 | null> => {
            account.assertCurrent();
            const response = await account.request(`/v2/sessions/${encodeURIComponent(sessionId)}?accessProjectionVersion=1`, {
                headers: { Authorization: `Bearer ${account.credentials.token}` },
            }, { includeAuth: false });
            account.assertCurrent();
            if (!response.ok) return null;
            const session = parseCompatSessionByIdResponse(await response.json())?.session;
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
            return resolved.definition;
        },
        resolveWorkflowTeamIds: async (artifactId) => {
            const result = await account.artifactAccessGrants.list({ artifactId });
            return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
        },
        resolveSession,
        observeLegacyChannelAssociation: async ({ automationId }, caller) => {
            try {
                account.assertCurrent();
                const result = await executeRelay({ actionId: 'action.invoke', input: {
                    action: { pluginId: 'happier.channels', localId: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead }, input: { automationId },
                }, context: { ...caller, surface: caller?.surface ?? 'ui', serverId: account.serverId, runtimeAccountId: account.accountId },
                ...(caller?.signal ? { signal: caller.signal } : {}) });
                account.assertCurrent();
                const parsed = ConversationBindingReadResultV1Schema.safeParse(result);
                return parsed.success && parsed.data.kind === 'automationAssociation' && parsed.data.automationId === automationId
                    ? { kind: parsed.data.association } : { kind: 'unknown' };
            } catch {
                caller?.signal?.throwIfAborted();
                account.assertCurrent();
                return { kind: 'unknown' };
            }
        },
        pullRequests: {
            listLinks: async (sessionId, caller) => {
                const result = await current(() => readActiveSessionPullRequestLinks({
                    accountLifetime: account.accountLifetime,
                    readAvailability: () => readPluginAccountAvailability(account.accountLifetime.scope),
                    sessionIds: [sessionId],
                    ...(caller?.signal ? { signal: caller.signal } : {}),
                }));
                if (result.status !== 'ready') {
                    const reason = result.status === 'rejected' ? result.code : result.reason;
                    // Target failures use the strict Agent refusal details contract;
                    // a collection transport reason is not an Agent admission refusal.
                    throw Object.assign(new Error(`target_unavailable:${reason}`), { code: 'target_unavailable' });
                }
                return result.sessions.find((session) => session.sessionId === sessionId)?.pullRequestLinks.slice() ?? [];
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
    const executeAccount = createWorkflowActionExecutor({
        definitions, runs, triggers,
        isWorkflowFeatureEnabled: async () => {
            const snapshot = await getServerFeaturesSnapshot({ serverId: account.serverId });
            return snapshot.status === 'ready' && readServerEnabledBit(snapshot.features, 'workflows') === true;
        },
    });
    const unavailable = { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' } as const;
    return async (rawArgs) => {
        try { account.assertCurrent(); } catch { return unavailable; }
        if (!areServerProfileIdentifiersEquivalent(rawArgs.context.serverId, account.serverId)
            || rawArgs.context.runtimeAccountId !== account.accountId) return unavailable;
        const args = rawArgs.context.serverId === account.serverId ? rawArgs
            : { ...rawArgs, context: { ...rawArgs.context, serverId: account.serverId } };
        const ordinaryAccountCredential = account.credentialAuthorityKind === 'account' || account.credentialAuthorityKind === 'terminal';
        const restrictedResource = args.context.externalActionTarget && args.context.externalActionTarget.kind !== 'machine';
        const definitionWrite = args.actionId === 'workflow.definition.create'
            || args.actionId === 'workflow.definition.update' || args.actionId === 'workflow.definition.edit'
            || args.actionId === 'workflow.definition.delete';
        const triggerOperation = args.actionId.startsWith('workflow.trigger.') || args.actionId.startsWith('session.trigger.');
        // Prepared recovery publishes executor rows. A present user's trigger
        // reads and writes are Account data served here; any other caller's
        // trigger or definition write consumes the host's agent-start policy
        // and materializer.
        const machineOrHostOperation = args.actionId === 'workflow.run.start'
            || args.actionId === 'workflow.run.invocations.retry'
            || (args.actionId === 'workflow.run.resume' && args.input.mode === 'recover')
            || ((definitionWrite || triggerOperation) && args.context.authority !== 'present_user');
        let result: unknown;
        try {
            result = await (ordinaryAccountCredential && !restrictedResource && !machineOrHostOperation
                ? executeAccount(args) : executeRelay(args));
        } catch (error) {
            try { account.assertCurrent(); } catch { return unavailable; }
            if (args.actionId !== 'workflow.run.start') throw error;
            // Only the transport's explicit not-sent witness proves rejection.
            // A missing reply (including timeout) may follow committed admission.
            const code = readRpcRequestDisposition(error) === 'notSent'
                ? 'target_unavailable' : 'workflow_outcome_unresolved';
            return { ok: false, errorCode: code, error: code };
        }
        try { account.assertCurrent(); } catch { return unavailable; }
        const failure = WorkflowActionFailureV1Schema.safeParse(result);
        return failure.success ? failure.data : result as Awaited<ReturnType<WorkflowActionExecute>>;
    };
}
