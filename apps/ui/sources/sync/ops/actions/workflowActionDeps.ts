import { lendAccountEncryptionObservation } from '@/sync/http/accountEncryptionObservationBinding';
import { createUiSessionRead } from './sessionReadAction';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowActionOutputSchemasV1, WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { ActionExecutorDeps, WorkflowActionExecute, WorkflowActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';
import { createWorkflowActorConsentPortV1, isWorkflowTriggerAgentCallerV1, readWorkflowTriggerSessionCapabilities, type WorkflowTriggerActionsDependencies } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { readActionAutomationExecutionMachineV1 } from '@happier-dev/protocol/actions/executor/actionSettlement';
import type { ActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import type { AutomationTemplateRetainedSessionV1 } from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { WorkflowStepExecutionSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
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
    SESSION_PULL_REQUEST_LINKS_ACTION_ID_V1,
    SessionPullRequestLinksResultV1Schema,
    type SessionPullRequestBindingInputV1,
} from '@happier-dev/channels-protocol/v1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionGoalGetRequestV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { isWorkflowHostAdmittedChildActionIdV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { ExternalActionTargetV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WORKFLOW_RUN_INVOCATIONS_RETRY_ACTION_ID_V1, WORKFLOW_RUN_RESUME_ACTION_ID_V1, WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { ActionExecuteFailureSchema, createActionExecuteFailureError, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionCurrentness, fetchBorrowedAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
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
    readAutomationTriggerEventDeclarations,
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
import { loadDaemonMergedProjectionCacheEntry, loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { projectedActionToDefinition } from '@/components/appShell/currentUiContext/contributedActionDefinition';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createPluginUiProjectedActionResolver, isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';
import { pluginUiSections } from '@/sync/domains/plugins/ui/projectionSections';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionByIdHttp } from '@/sync/engine/sessions/sessionByIdHttp';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { bindPresentUserActionConfirmation } from './presentUserConfirmation';
import { randomUUID } from '@/platform/randomUUID';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { parseCompatSessionByIdResponse } from '@/sync/engine/sessions/sessionHttpCompat';
import { createSessionDataKeyHydrationPlan, hydrateSessionDataKeys, readSessionDataKeyCredentialKind } from '@/sync/encryption/sessionDataKeyHydration';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { listSessionsForVoiceTool } from '@/voice/tools/actionImpl/sessionList';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import type { AccountActionTransport } from './accountActionTransport';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { executeDefaultActionInCapturedAccount } from './defaultActionExecutor';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { prepareRequesterSessionForSpawn } from './requesterSessionSpawnPreparation';
import { sealSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

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
                authority: { ...authority, request: lendAccountEncryptionObservation((path: string, init?: RequestInit, options?: Parameters<typeof authority.request>[2]) => authority.request(path,
                    { ...init, ...(signal ? { signal } : {}) }, options), authority.request) },
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
        const capabilities = await readWorkflowTriggerSessionCapabilities(payload =>
            withActionAccountRequestSignal(account, caller?.signal, signal => sessionRpcWithServerScope<unknown, SessionGoalGetRequestV1>({
                sessionId, serverId: account.serverId, method: SESSION_RPC_METHODS.SESSION_GOAL_GET,
                payload, timeoutMs: null, signal,
            })).catch(() => null), options.rolePolicy);
        account.assertCurrent();
        return { ...facts, ...capabilities };
    };
}

type WorkflowStartConfirmation = Readonly<{ reviewDigest?: string }>;

/** Compose Account content owners and the existing exact-Machine effect relay. */
export type UiWorkflowAction = WorkflowActionExecute
    & ((args: WorkflowActionExecuteArgs, confirmation: WorkflowStartConfirmation) => ReturnType<WorkflowActionExecute>)
    & Readonly<{
    actionAutomationChecks: ReturnType<typeof createWorkflowActorConsentPortV1> & Required<Pick<ActionAutomationPortV1, 'wait' | 'cancel'>>;
    prepareTriggerMutation: NonNullable<WorkflowActionExecute['prepareTriggerMutation']>;
}>;

type UiWorkflowActionInput = Readonly<{
    account: LazyActionAccountContext;
    transport?: AccountActionTransport;
    listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
}>;

export function createUiWorkflowAction(params: UiWorkflowActionInput): UiWorkflowAction {
    // An ordinary Action may never select a Workflow or an automatic check.
    // Prepare their shared owner on first demand using this invocation's Account.
    let bound: UiWorkflowAction | undefined;
    const read = () => bound ??= buildUiWorkflowAction(params);
    const execute = (args: WorkflowActionExecuteArgs, confirmation?: WorkflowStartConfirmation) =>
        confirmation ? read()(args, confirmation) : read()(args);
    const actionAutomationChecks: UiWorkflowAction['actionAutomationChecks'] = {
        prepareMatching: (...args) => read().actionAutomationChecks.prepareMatching(...args),
        resolveConsent: (...args) => read().actionAutomationChecks.resolveConsent(...args),
        allowConsent: args => read().actionAutomationChecks.allowConsent(args),
        wait: args => read().actionAutomationChecks.wait(args),
        cancel: args => read().actionAutomationChecks.cancel(args),
    };
    const prepareTriggerMutation: UiWorkflowAction['prepareTriggerMutation'] = args => read().prepareTriggerMutation(args);
    return Object.assign(execute, { actionAutomationChecks, prepareTriggerMutation });
}

function buildUiWorkflowAction(params: UiWorkflowActionInput): UiWorkflowAction {
    const account = params.account;
    const executeRelay = createUiAccountAction(params);
    const resolveOriginSessionProject = async ({ context, input, signal }: WorkflowActionExecuteArgs<'workflow.run.start'>) => {
        // Signed invocations, approved replays, Discussion starts and Run-again have their own placement.
        if (context.externalActionExecutionAuthorization || context.externalActionCredential || context.rpcSessionAuthorization
            || context.presentUserConfirmation || context.presentUserApproval || context.approvedActionReplay
            || input.origin || (input.source.kind === 'inline' && input.source.replay)) return undefined;
        const sessionId = context.defaultSessionId?.trim();
        if (!sessionId || (context.actionCaller?.kind === 'session' && context.actionCaller.sessionId !== sessionId)) return undefined;
        const requestSignal = signal ?? context.signal;
        const opened = await withActionAccountRequestSignal(account, requestSignal, signal =>
            runWithServerRequestAuthorityForServerAccountScope({
                scope: account.accountLifetime.scope, activeRequest: account.request,
            }, authority => readSessionSnapshotForAuthority({ authority, sessionId, signal,
                includeTurns: false, isCurrent: account.accountLifetime.isCurrent })))
            .catch(error => { if (error instanceof SessionSnapshotReadError) return null; throw error; });
        account.assertCurrent();
        throwIfAborted(requestSignal);
        const metadata = opened ? readSessionOwnerMetadataView(opened.session) : null;
        const machineId = resolveSessionMachineId(metadata);
        if (!machineId) return undefined;
        const directory = resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath: metadata?.path?.trim() ?? '' }).machinePath;
        return directory ? { machineId, directory } : undefined;
    };
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
            method: RPC_METHODS.DAEMON_WORKFLOW_REQUESTER_CUSTODY, payload, requireEncryptedPayload: true,
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
        if (failure.success) throw createActionExecuteFailureError(failure.data);
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
        readTriggerEventDeclarations: (input) => current(() => readAutomationTriggerEventDeclarations(account.credentials, input, account)),
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
        readWorkflowTriggerEvents: (input) => triggers.readWorkflowTriggerEvents(input),
        encodeListCursor: account.encodeArtifactListCursor,
        readPluginWorkflows: async (workflow, signal) => {
            account.assertCurrent();
            const machineId = resolveUiAccountActionFallbackMachineId(account);
            if (!machineId) return [];
            if (workflow !== undefined) {
                const target = parseWorkflowDefinitionRefV1(workflow);
                if (target?.kind !== 'plugin') return [];
                const response = await machineRpcWithServerScope({
                    machineId, serverId: account.serverId, accountId: account.accountId, signal,
                    method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                    payload: { machineId, selection: 'workflowSource', workflowSource: target.contribution },
                });
                account.assertCurrent();
                const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(response).projection;
                const selected = projection.familiesById.workflows?.entriesById[buildQualifiedPluginContributionKey(target.contribution)];
                return selected?.pluginId ? [projectWorkflowPluginSourceV1({
                    pluginId: selected.pluginId, pluginVersion: selected.pluginVersion, definition: selected.definition,
                })] : [];
            }
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
        removeWorkflowTriggers: (definitionId, caller) => triggers.removeForWorkflow(definitionId, caller),
        assertDefinitionWriteAllowed: (_definition, _context, caller) => {
            // Other callers retain the canonical host authorization/materializer.
            if (caller?.authority !== 'present_user') {
                throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
        },
    });
    const resolveMaterial = () => deriveAccountScopedCryptoMaterialSnapshot(account.credentials, account.serverId);
    const resolveEncryption = async (signal?: AbortSignal, read = fetchAccountEncryptionCurrentness) => {
        account.assertCurrent();
        const resolved = await resolveValidatedAutomationAccountEncryptionV1({
            signal: signal ?? new AbortController().signal,
            resolveAccountEncryptionCurrentness: async (signal) => await read(account.credentials, { request: account.request, signal }),
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
    const readRunSummary = async (runId: string, signal?: AbortSignal) => {
        const stored = await runStorage.execute({ operation: 'get', runId }, signal ? { signal } : undefined);
        const run = WorkflowRunSummaryV1Schema.safeParse(stored && typeof stored === 'object' && 'run' in stored ? stored.run : undefined);
        if (!run.success || run.data.id !== runId) targetUnavailable();
        account.assertCurrent();
        return run.data;
    };
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
        listContributedActionDefinitions: async (selection, caller, placement) => {
            if (!placement) return await params.listContributedActionDefinitions?.(selection) ?? [];
            const identity = parseQualifiedPluginActionId(selection.id);
            if (!identity) return [];
            account.assertCurrent();
            const inputs = await loadDaemonMergedProjectionInputs({
                machineId: placement.machineId, serverId: account.serverId, accountLifetime: account.accountLifetime,
                signal: caller?.signal ?? account.invocationSignal, sections: pluginUiSections(identity.pluginId),
            });
            account.assertCurrent();
            const projection = inputs?.pluginUiProjection;
            if (!projection) return [];
            const action = createPluginUiProjectedActionResolver(projection.actionsById)(identity);
            return action && isPluginProjectedActionExecutable(action) ? [projectedActionToDefinition(action, projection)] : [];
        },
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
        resolveReadEncryption: () => resolveEncryption(undefined, fetchBorrowedAccountEncryptionCurrentness),
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
        readWorkflowChildBodyVersions: async (artifactIds, signal) => {
            const headers = await account.readArtifactHeaders(artifactIds, { signal, fresh: true });
            return headers.map(header => header.status === 'fulfilled' && header.value?.isDecrypted ? header.value.bodyVersion : undefined);
        },
        resolveWorkflowTeamIds: async (artifactId) => {
            const result = await account.artifactAccessGrants.list({ artifactId });
            return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
        },
        resolveWorkflowContent: async (workflowId) => {
            const opened = await account.readArtifactContent(workflowId, { includeAssociatedContentOpener: true });
            if (!opened?.openAssociatedContent || !opened.sealAssociatedContent) {
                throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
            }
            return { revision: opened.revision, openAssociatedContent: opened.openAssociatedContent,
                sealAssociatedContent: opened.sealAssociatedContent };
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
            return unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(await response.json()));
        },
        pullRequests: {
            listLinks: async (sessionId, caller) => {
                const result = await current(() => executeDefaultActionInCapturedAccount(account, 'action.invoke', {
                    action: { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_LINKS_ACTION_ID_V1 },
                    input: { sessionId },
                }, { ...caller, surface: caller?.surface ?? 'ui', defaultSessionId: sessionId }));
                if (!result.ok) targetUnavailable();
                const links = SessionPullRequestLinksResultV1Schema.safeParse(result.result);
                if (!links.success || links.data.sessionId !== sessionId) targetUnavailable();
                return links.data.pullRequestLinks;
            },
            attach: async ({ sessionId, pullRequest, automationId, triggerId, triggerRevision, triggerKind }, caller) => {
                const result = await invokePullRequestBinding({ kind: 'attach', sessionId, pullRequest,
                    target: { automationId, triggerId, triggerRevision, triggerKind, origin: 'automatic' } }, caller);
                if (result.kind !== 'attached') targetUnavailable();
            },
            removeTrigger: async (input, caller) => {
                const result = await invokePullRequestBinding({ kind: 'removeTrigger', ...input }, caller);
                if (result.kind !== 'removed') targetUnavailable();
            },
        },
        resolveRunSource: async (source, caller) => {
            account.assertCurrent();
            if (source.kind === 'workflow_run') {
                // The existing Account storage read authorizes the exact Run;
                // no private opening or lifecycle fact is invented by this adapter.
                const run = await readRunSummary(source.runId, caller?.signal);
                return { terminal: isTerminalAutomationRunStateV3(run.state) };
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
    const ordinaryAccountCredential = account.credentialAuthorityKind === 'account' || account.credentialAuthorityKind === 'terminal';
    const resolveExecutionPlacement = (args: WorkflowActionExecuteArgs) => {
        const restrictedResource = args.context.externalActionTarget && args.context.externalActionTarget.kind !== 'machine';
        const recoveryRunId = args.actionId === WORKFLOW_RUN_INVOCATIONS_RETRY_ACTION_ID_V1
            || (args.actionId === WORKFLOW_RUN_RESUME_ACTION_ID_V1 && args.input.mode === 'recover') ? args.input.runId : undefined;
        const machineOrHostOperation = args.actionId === WORKFLOW_RUN_START_ACTION_ID_V1
            || recoveryRunId !== undefined
            || (args.actionId === 'workflow.trigger.run_now' && isWorkflowTriggerAgentCallerV1(args.context))
            || (isWorkflowHostAdmittedChildActionIdV1(args.actionId) && args.context.authority !== 'present_user');
        return { accountOperation: ordinaryAccountCredential && !restrictedResource && !machineOrHostOperation, recoveryRunId };
    };
    const execute = async (rawArgs: WorkflowActionExecuteArgs,
        confirmation?: WorkflowStartConfirmation): ReturnType<WorkflowActionExecute> => {
        try { account.assertCurrent(); } catch { return unavailable; }
        if (!areServerProfileIdentifiersEquivalent(rawArgs.context.serverId, account.serverId)
            || rawArgs.context.runtimeAccountId !== account.accountId) return unavailable;
        const args = rawArgs.context.serverId === account.serverId ? rawArgs
            : { ...rawArgs, context: { ...rawArgs.context, serverId: account.serverId } };
        const restrictedResource = args.context.externalActionTarget && args.context.externalActionTarget.kind !== 'machine';
        const savedOccurrence = args.actionId === 'workflow.trigger.run_now';
        const startingRun = args.actionId === WORKFLOW_RUN_START_ACTION_ID_V1;
        // Prepared recovery publishes executor rows. A present user's trigger
        // reads and writes are Account data served here; any other caller's
        // trigger or definition write consumes the host's agent-start policy
        // and materializer.
        let result: unknown;
        try {
            const { accountOperation, recoveryRunId } = resolveExecutionPlacement(args);
            // Account reads are admitted by the Workflow executor; ordinary Machine operations
            // consume the same UI policy before relaying. Scoped credentials keep host admission.
            if (ordinaryAccountCredential && !accountOperation && !await isWorkflowFeatureEnabled()) return unavailable;
            let relayArgs = args;
            if (startingRun) {
                const target = args.context.externalActionTarget;
                let startContext = args.context;
                if (!target || (target.kind === 'machine' && !target.project)) {
                    // Resolve an omitted Project from the admitted origin before binding confirmation and signing.
                    const project = args.context.workflowStartProject ?? (ordinaryAccountCredential ? await resolveOriginSessionProject(args) : undefined);
                    if (project) {
                        const projected = ExternalActionTargetV1Schema.safeParse({
                            ...(target ?? { kind: 'machine', machineId: project.machineId }), project,
                        });
                        if (!projected.success) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
                        startContext = { ...args.context, externalActionTarget: projected.data };
                    }
                }
                if (confirmation) startContext = bindPresentUserActionConfirmation(args.actionId, args.input, startContext, confirmation.reviewDigest);
                if (startContext !== args.context) relayArgs = { ...args, context: startContext };
            }
            if (ordinaryAccountCredential && args.context.externalActionTarget === undefined && recoveryRunId !== undefined) {
                // Recovery belongs to the retained Run's Machine. A reachable Account
                // relay is not a resource target and can fail the Run's target binding.
                const run = await readRunSummary(recoveryRunId, args.signal ?? args.context.signal);
                relayArgs = { ...args, context: { ...args.context,
                    externalActionTarget: { kind: 'machine', machineId: run.machineId } } };
            }
            result = await (accountOperation
                ? executeAccount(args) : executeRelay(relayArgs));
            if (ordinaryAccountCredential && !restrictedResource && args.actionId === 'workflow.run.invocations.get') {
                const opened = WorkflowInvocationGetResultV1Schema.safeParse(result);
                const retry = opened.success ? opened.data.invocation.recoveryAvailability?.retry : undefined;
                if (opened.success && retry && !(retry.kind === 'unavailable' && retry.reason === 'run_not_interrupted')) {
                    const run = await readRunSummary(args.input.runId, args.signal ?? args.context.signal).catch(error => {
                        account.assertCurrent();
                        if ((args.signal ?? args.context.signal)?.aborted
                            || (error instanceof AutomationApiError && (error.status === 401 || error.status === 403))) throw error;
                        // This supplemental read supplies native observation placement only.
                        // Keep the opened Account history when that optional read is unavailable.
                        return undefined;
                    });
                    const target = args.context.externalActionTarget;
                    if (run?.state === 'interrupted'
                        && (!target || (target.kind === 'machine' && target.machineId === run.machineId))) {
                        // The Machine's existing Run owner observes exact native input/conversation
                        // facts. Its transport reads the exact captured-Home Machine and authorizes
                        // access; a cold or stale presentation inventory cannot decide availability.
                        // A native refusal keeps the already-authorized Account history readable.
                        try {
                            const observed = await executeRelay({ ...args, context: { ...args.context,
                                externalActionTarget: { kind: 'machine', machineId: run.machineId } } });
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
            if (control.success && 'run' in control.data) publishCancelledRun(account, control.data.run);
        }
        return result as Awaited<ReturnType<WorkflowActionExecute>>;
    };
    const actionAutomationChecks: UiWorkflowAction['actionAutomationChecks'] = {
        ...createWorkflowActorConsentPortV1({ actions: triggers, accountId: account.accountId,
            resolveProject: async context => {
                const machineId = readActionAutomationExecutionMachineV1(context);
                const target = context.externalActionTarget;
                let project = target?.kind === 'machine' ? target.project : undefined;
                if (!project) {
                    const sessionId = target?.kind === 'session' ? target.sessionId
                        : context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId : context.defaultSessionId;
                    if (sessionId) project = (await resolveSession(sessionId, context)).project;
                }
                if (!machineId || !project || project.machineId !== machineId) targetUnavailable();
                return project;
            },
        }),
        wait: async args => {
            if (!executeAccount.waitAutomaticCheck) targetUnavailable();
            return executeAccount.waitAutomaticCheck(args);
        },
        cancel: async args => {
            if (!executeAccount.cancelAutomaticCheck) targetUnavailable();
            await executeAccount.cancelAutomaticCheck(args);
        },
    };
    return Object.assign(execute, { actionAutomationChecks,
        prepareTriggerMutation: async (rawArgs: Parameters<NonNullable<WorkflowActionExecute['prepareTriggerMutation']>>[0]) => {
            try { account.assertCurrent(); } catch { return unavailable; }
            if (!areServerProfileIdentifiersEquivalent(rawArgs.context.serverId, account.serverId)
                || rawArgs.context.runtimeAccountId !== account.accountId) return unavailable;
            // Relayed work is prepared by its receiving executor, which owns that invocation's row.
            if (!resolveExecutionPlacement(rawArgs).accountOperation) return null;
            return executeAccount.prepareTriggerMutation({ ...rawArgs,
                context: { ...rawArgs.context, serverId: account.serverId } });
        },
    });
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
