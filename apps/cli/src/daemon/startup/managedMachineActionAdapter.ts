import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedAcquireInputV1Schema, ManagedControllerUpdateInputV1Schema, ManagedCredentialInstallInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { randomUUID } from 'node:crypto';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { isOriginalLocalManagedSetupContext } from '@/api/externalActionExecutionAuthorization';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { logger } from '@/ui/logger';
import { ManagedRetentionWaitSuperseded } from '@/machines/managed/controllerErrors';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';

import { prepareInstalledWorkflowActionAuthorization, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { StoredCredentials } from '@/persistence';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import type { ManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
import type { PrepareExternalActionRequesterAccountContext } from '../externalActions/executeExternalAction';

/** The incumbent daemon factory binds the current controller to its driver. */
type ManagedMachineActionAdapterParams = Readonly<{
    credentials: StoredCredentials;
    /** Installed native custody is separate from an admitted foreign requester's policy/Ask. */
    controllerCredentials?: StoredCredentials;
    machineId: string;
    serverBaseUrl: string;
    serverId: string;
    executeSessionStart?: (input: SessionSpawnNewInputV2, context: ActionExecutorContext, machine: ManagedMachineV1) => Promise<ActionExecuteResult>;
    executeEnvironmentSetup?: (machine: ManagedMachineV1, context: ActionExecutorContext, isCurrent: () => Promise<boolean>) => Promise<ActionExecuteResult>;
    subscribeEnvironmentSetupChanges?: (context: ActionExecutorContext, callbacks: Readonly<{ onChange(): void; onError(error: unknown): void }>) => Promise<{ dispose(): void | Promise<void> }>;
    /** Original requester-private observation only; the guest retains replay authority. */
    observeSessionStartApproval?: (args: Readonly<{ artifactId: string; context: ActionExecutorContext;
        machine: ManagedMachineV1; isCurrent(): Promise<boolean> }>) => Promise<ActionExecuteResult>;
    observeEnvironmentSetupApproval?: ManagedMachineActionAdapterParams['observeSessionStartApproval'];
    preflightSessionStart?: (context: ActionExecutorContext) => Promise<boolean>;
    resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
    installationIdentity: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }> | null;
    managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
    observeActionExecution?: ApiMachineClient['observeActionExecution'];
    readPolicyCurrent?: (managedId: string, signal?: AbortSignal) => Promise<ManagedMachineV1 | null>;
    prepareTeamCredentialNativeSource?: RuntimeProviderModelManagementServices['prepareTeamCredentialNativeSource'];
    executeManagedPolicyAction?: (machine: ManagedMachineV1, context: ActionExecutorContext,
        runApproved: (context: ActionExecutorContext) => Promise<ManagedMachineV1>) => Promise<ManagedMachineV1>;
    prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
    subscribeManagedMachineChanges?: ApiMachineClient['onManagedMachinePolicyInvalidated'];
    acquireRuntimeRegistryLease(): Promise<PluginRuntimeRegistryLease>;
}>;

export type ManagedMachinePolicyRequest = Readonly<{ machine: ManagedMachineV1; purpose: ManagedPolicyPurposeV1; signal?: AbortSignal; actionOrigin?: ExternalActionExecutionAuthorizationV1;
    retentionContinuationRequestId?: string }>;

export const MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT = Object.freeze({
    kind: 'managed_machine_policy_abort',
    reasonCode: 'retention_satisfied',
    outcome: 'satisfied',
} as const);

function isManagedMachinePolicyRetentionSatisfiedAbort(reason: unknown): boolean {
    return reason === MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT;
}

/** Captures this runtime's own requester Account services, never borrowed custodian credentials. */
export function createManagedSessionStartApprovalObserver(params: Readonly<{
    actionId?: 'session.spawn_new' | 'machines.environment.apply';
    credentials: StoredCredentials;
    machineId: string;
    observeRecordedApprovalExecution(args: RecordedApprovalExecutionObservationArgs): Promise<ActionExecuteResult>;
    isRequesterRuntimeCurrent?: (context: ActionExecutorContext, machine: ManagedMachineV1) => Promise<boolean>;
}>): NonNullable<ManagedMachineActionAdapterParams['observeSessionStartApproval']> {
    return async ({ artifactId, context, machine, isCurrent }) => {
        const authorization = context.externalActionExecutionAuthorization;
        const root = authorization?.binding;
        const requesterHttpProjection = authorization?.requesterHttpProjection;
        const actionId = params.actionId ?? 'session.spawn_new';
        if (actionId === 'machines.environment.apply' && !authorization) {
            // Observation consumes the original installed Account's private
            // recorded result. Only the ordinary Home signer admits effects.
            if (!machine.enrolledMachineId || !context.signal || !params.isRequesterRuntimeCurrent
                || !isOriginalLocalManagedSetupContext({ context, credentials: params.credentials,
                    custodianAccountId: machine.custodianAccountId, homeId: machine.homeId })) {
                return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
            }
            return params.observeRecordedApprovalExecution({ artifactId, signal: context.signal,
                expectedOrigin: { actionId, requestId: context.actionRequestId!, accountId: machine.custodianAccountId,
                    serverIdentityId: machine.homeId, machineId: machine.enrolledMachineId },
                isCurrent: async () => await isCurrent() && await params.isRequesterRuntimeCurrent!(context, machine) });
        }
        if (!authorization || !root || root.actionId !== 'machines.managed.acquire'
            || root.requestId !== context.actionRequestId || root.serverIdentityId !== machine.homeId
            || root.machineId !== params.machineId || root.machineId !== machine.controller?.machineId
            || root.installationId !== machine.controller?.installationId || root.custodianAccountId !== machine.custodianAccountId
            || (actionId === 'session.spawn_new' && (!root.sessionActionOrigin || !root.sessionActionSource))
            || readAccountIdFromToken(params.credentials.token) !== root.accountId
            || !root.accountEncryptionMode || !requesterHttpProjection
            || requesterHttpProjection.accountId !== root.accountId
            || requesterHttpProjection.serverIdentityId !== root.serverIdentityId
            || requesterHttpProjection.accountEncryptionMode !== root.accountEncryptionMode
            || !machine.enrolledMachineId || !context.signal) {
            return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
        }
        return await params.observeRecordedApprovalExecution({ artifactId, signal: context.signal,
            expectedOrigin: { actionId, requestId: root.requestId, accountId: root.accountId,
                serverIdentityId: root.serverIdentityId, machineId: machine.enrolledMachineId },
            isCurrent: async () => await isCurrent()
                && (!params.isRequesterRuntimeCurrent || await params.isRequesterRuntimeCurrent(context, machine))
                && await requesterHttpProjection.isCurrent(),
        });
    };
}

async function withBoundDriver<T>(params: ManagedMachineActionAdapterParams, signal: AbortSignal | undefined,
    execute: (driver: ReturnType<typeof import('@/machines/managed/acquire')['createManagedMachineAcquisitionDriver']>) => Promise<T>): Promise<T> {
        if (!params.managedProviderOperationAuthority) {
            throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
        }
        const origin = await params.resolveCurrentMachineExecutionOriginContext?.(signal);
        if (!origin || origin.machineId !== params.machineId || !params.installationIdentity) {
            throw Object.assign(new Error('controller_unavailable'), { code: 'controller_unavailable' });
        }
        const homeTarget = await resolveCurrentCliHomeTarget();
        if (homeTarget.homeServerIdentityId !== origin.serverIdentityId) {
            throw Object.assign(new Error('controller_unavailable'), { code: 'controller_unavailable' });
        }
        const lease = await params.acquireRuntimeRegistryLease();
        try {
            const { createManagedMachineAcquisitionDriver } = await import('@/machines/managed/acquire');
            const controllerCredentials = params.controllerCredentials ?? params.credentials;
            return await execute(createManagedMachineAcquisitionDriver({
                token: controllerCredentials.token, serverUrl: params.serverBaseUrl,
                homeId: origin.serverIdentityId,
                controller: { machineId: params.machineId, installationId: params.installationIdentity.installationId },
                runtimeRegistry: lease.registry,
                externalActionMachineRequestPrivateKey: params.installationIdentity.privateKey,
                managedProviderOperationAuthority: params.managedProviderOperationAuthority,
                credentials: controllerCredentials,
                homeTarget,
                ...(params.prepareTeamCredentialNativeSource ? { prepareTeamCredentialNativeSource: params.prepareTeamCredentialNativeSource } : {}),
                ...(params.readPolicyCurrent ? { readPolicyCurrent: params.readPolicyCurrent } : {}),
                ...(params.subscribeManagedMachineChanges ? { subscribeManagedMachineChanges: params.subscribeManagedMachineChanges } : {}),
            }));
        } finally {
            await lease.release();
        }
}

/** Explicit callers and automatic host policy work consume the same bound native owner. */
// Factories are also created by finite execution paths. The live resource
// writer therefore belongs to this module, not an individual adapter instance.
// Entries contain only joined work, never desired policy or replay authority.
const nativeCredentialWrites = new Map<string, Promise<void>>();

async function serializeNativeCredentialWrite<T>(homeId: string, managedId: string, signal: AbortSignal | undefined,
    execute: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([homeId, managedId]);
    const previous = nativeCredentialWrites.get(key) ?? Promise.resolve();
    const result = previous.then(async () => { signal?.throwIfAborted(); return execute(); });
    const settled = result.then(() => {}, () => {});
    nativeCredentialWrites.set(key, settled);
    try { return await result; }
    finally { if (nativeCredentialWrites.get(key) === settled) nativeCredentialWrites.delete(key); }
}

export function createDaemonManagedMachineActionAdapter(params: ManagedMachineActionAdapterParams) {
    const executeNativeActionNow: NonNullable<ActionExecutorDeps['managedMachineAction']> = async ({ actionId, input, context, signal }) => {
        const requestId = context.actionRequestId;
        if (!requestId) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
        // This identity is stamped by the accepted in-process FIN invocation;
        // the public Action/RPC payload cannot supply it. Home independently
        // checks the signed installation's persisted Run assignment and cause.
        const runId = context.executionRunWorkflowRunId;
        if (runId && !context.externalActionExecutionAuthorization) {
            const installation = params.installationIdentity;
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(signal);
            if (!installation || !origin || origin.machineId !== params.machineId) {
                throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            }
            const target = { kind: 'machine' as const, machineId: params.machineId };
            const authorization = await prepareInstalledWorkflowActionAuthorization({ actionId, input, context: { ...context, ...(signal ? { signal } : {}) }, target,
                machineId: params.machineId, credentials: params.credentials, serverId: params.serverId, serverIdentityId: origin.serverIdentityId,
                serverHttpBaseUrl: params.serverBaseUrl, installationId: installation.installationId, privateKey: installation.privateKey,
            });
            if (!authorization) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            context = { ...context, externalActionExecutionAuthorization: authorization, externalActionTarget: target };
        }
        const agentStart = actionId === 'machines.managed.acquire' ? ManagedAcquireInputV1Schema.parse(input).agentStart : undefined;
        const executeSessionStart = params.executeSessionStart;
        if (agentStart && (!executeSessionStart || !context.operationOwnerUpdate
            || (context.externalActionCredential && !context.externalActionExecutionAuthorization)
            // A Session continuation needs a private reader owned by the
            // requester Account, not another resource custodian's credentials.
            || (context.externalActionExecutionAuthorization && context.actionCaller?.kind === 'session' && !params.observeSessionStartApproval)
            || (context.externalActionExecutionAuthorization && (!params.preflightSessionStart || !await params.preflightSessionStart(context))))) {
            throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
        }
        const result = await withBoundDriver(params, signal, async driver => await driver.execute(actionId, input, { requestId, context, signal,
                ...(params.subscribeEnvironmentSetupChanges ? { subscribeEnvironmentSetupChanges: callbacks => params.subscribeEnvironmentSetupChanges!(context, callbacks) } : {}),
                ...(params.executeEnvironmentSetup ? { runEnvironmentSetup: async ({ machine, isCurrent }) => {
                    if (!machine.enrolledMachineId || !machine.preset || !await isCurrent()) throw Object.assign(new Error('intent_changed'), { code: 'intent_changed' });
                    let setup = await params.executeEnvironmentSetup!(machine, context, isCurrent);
                    if (setup.ok) {
                        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(setup.result);
                        if (approval.success && approval.data.actionId === 'machines.environment.apply') {
                            if (!params.observeEnvironmentSetupApproval) throw Object.assign(new Error('approval_context_unavailable'), { code: 'approval_context_unavailable' });
                            context.operationOwnerUpdate?.update({ observation: { kind: 'outcome_uncertain', code: 'approval_pending' } });
                            setup = await params.observeEnvironmentSetupApproval({ artifactId: approval.data.artifactId, context, machine, isCurrent });
                            if (setup.ok) context.operationOwnerUpdate?.update({ observation: null });
                        }
                    }
                    if (!setup.ok) throw Object.assign(new Error(setup.errorCode), { code: setup.errorCode });
                    const current = await driver.execute('machines.managed.get', { homeId: machine.homeId, managedId: machine.id }, { requestId, context, signal });
                    return ManagedMachineV1Schema.parse(current);
                } } : {}),
                ...(agentStart && executeSessionStart ? { runAgentStart: async ({ machine, isCurrent }) => {
                    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
                    if (!machine.enrolledMachineId || !await isCurrent()) {
                        throw Object.assign(new Error('intent_changed'), { code: 'intent_changed' });
                    }
                    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
                    let result = await executeSessionStart({ ...agentStart,
                        executionTarget: { serverId: params.serverId, machineId: machine.enrolledMachineId },
                        managedCreation: { homeId: machine.homeId, managedId: machine.id, controller: machine.controller },
                    }, context, machine);
                    if (result.ok && params.observeSessionStartApproval) {
                        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                        if (approval.success && approval.data.actionId === 'session.spawn_new') {
                            context.operationOwnerUpdate!.update({ observation: { kind: 'outcome_uncertain', code: 'approval_pending' } });
                            result = await params.observeSessionStartApproval({ artifactId: approval.data.artifactId, context, machine, isCurrent });
                        }
                    }
                    if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
                    const spawn = SessionSpawnNewResultV1Schema.safeParse(result.result);
                    if (!spawn.success) {
                        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
                        if (!approval.success || approval.data.actionId !== 'session.spawn_new') {
                            throw Object.assign(new Error('invalid_action_output'), { code: 'invalid_action_output' });
                        }
                        // A real Inbox request is not a Session-start result.
                        // Requester-private Artifact consumption stays with its
                        // existing owner; this projection grants no read power.
                        context.operationOwnerUpdate!.update({ observation: { kind: 'outcome_uncertain', code: 'approval_pending' } });
                        return;
                    }
                    if (spawn.success && spawn.data.type === 'error') {
                        throw Object.assign(new Error(spawn.data.code), { code: spawn.data.code });
                    }
                    if (spawn.success && spawn.data.type === 'pending') {
                        if (!context.operationOwnerUpdate) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                        context.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } });
                    } else if (spawn.success && spawn.data.type === 'success') {
                        context.operationOwnerUpdate?.update({ observation: null });
                    }
                } } : {}),
            }));
        if (actionId !== 'machines.managed.controller.update') return result;
        const machine = ManagedMachineV1Schema.parse(result);
        try {
            const move = ManagedControllerUpdateInputV1Schema.parse(input);
            if (machine.id !== move.managedId || machine.homeId !== move.homeId
                || !sameStrictJsonValue(machine.controller, move.controller ?? undefined)
                || machine.custodianAccountId !== readAccountIdFromToken(params.credentials.token)) {
                throw Object.assign(new Error('Moved controller receipt is not current'), { code: 'controller_unavailable' });
            }
            // The admitted native owner alone uses its private custodian FIN
            // material. A foreign Manage requester gains no generic recipe rewrite.
            const { createCliWorkflowTriggerActions } = await import('@/session/actions/workflowTriggers');
            const triggers = createCliWorkflowTriggerActions({ credentials: params.credentials,
                serverHttpBaseUrl: params.serverBaseUrl,
                resolveWorkflow: async () => { throw Object.assign(new Error('Not an inline managed scope binding'), { code: 'source_unavailable' }); } });
            await triggers.moveManagedMachineScopeBindings({ machine, ...(signal ? { signal } : {}) });
            return machine;
        } catch (error) {
            const code = readRpcErrorCode(error)
                ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'binding_outcome_unknown');
            return { ok: false, errorCode: 'managed_binding_move_incomplete', error: 'managed_binding_move_incomplete', details: { machine, code } };
        }
    };
    const executeNativeAction: NonNullable<ActionExecutorDeps['managedMachineAction']> = async request => {
        if (request.actionId !== 'machines.managed.credentials.install') return executeNativeActionNow(request);
        const input = ManagedCredentialInstallInputV1Schema.parse(request.input);
        return serializeNativeCredentialWrite(input.homeId, input.managedId, request.signal,
            () => executeNativeActionNow(request));
    };
    const actionAdapter: NonNullable<ActionExecutorDeps['managedMachineAction']> = async request => {
        const { actionId, input, context, signal } = request;
        const runId = context.executionRunWorkflowRunId;
        const observe = params.observeActionExecution;
        // Detached Ask replay has no live parent's ports. Bind once through the
        // existing operation owner; ordinary calls may have no observed scope.
        if (!context.operationAcceptance && (runId || (getActionSpec(actionId).operation && observe))) {
            if (!context.actionRequestId || !observe) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            const observed = await observe({ actionId, input, actionRequestId: context.actionRequestId,
                execute: async operation => {
                    if (runId && !operation.operationAcceptance) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                    // A detached Ask replay is only the admission carrier. Once
                    // the durable operation owns the accepted effect, ending the
                    // approving HTTP request must not cancel native dispatch.
                    // Explicit operation cancellation remains authoritative.
                    const lifetime = operation.signal;
                    // The driver retains all native admission requirements,
                    // including acceptance for acquisition and lifecycle effects.
                    const result = await executeNativeAction({ ...request, context: { ...context, ...operation, signal: lifetime }, signal: lifetime });
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : { ok: true, result };
                } });
            return observed.ok ? observed.result : observed;
        }
        return await executeNativeAction(request);
    };
    return Object.assign(actionAdapter, {
        reconcileNativeCredentials: async (machine: ManagedMachineV1, signal: AbortSignal): Promise<void> =>
            serializeNativeCredentialWrite(machine.homeId, machine.id, signal, () =>
                withBoundDriver(params, signal, driver => driver.reconcileNativeCredentials(machine, {
                    requestId: randomUUID(), signal,
                }))),
        executePolicy: async (request: ManagedMachinePolicyRequest): Promise<ActionExecuteResult> => {
            if (!params.observeActionExecution || !params.executeManagedPolicyAction) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            request.signal?.throwIfAborted();
            if (request.purpose.kind === 'accepted-input-start' && request.purpose.target.origin.kind === 'finite-command'
                && (!request.actionOrigin || request.actionOrigin.binding.accountId !== readAccountIdFromToken(params.credentials.token))) {
                const prepared = request.actionOrigin && params.prepareRequesterAccountContext
                    ? await params.prepareRequesterAccountContext({ authorization: request.actionOrigin,
                        purpose: { kind: 'managed_finite_wake', target: request.purpose.target },
                        ...(request.signal ? { signal: request.signal } : {}) }) : null;
                try {
                    return prepared?.executeManagedFiniteWake ? await prepared.executeManagedFiniteWake(request)
                        : { ok: false, errorCode: 'requester_account_context_unavailable', error: 'requester_account_context_unavailable' };
                } finally { await prepared?.dispose(); }
            }
            const actionId = request.purpose.kind === 'creation-cleanup'
                || (request.purpose.kind === 'retention' && request.machine.retention.kind !== 'until-delete'
                    && request.machine.retention.effect === 'delete') ? 'machines.managed.delete' : 'machines.managed.power.set';
            const requestId = randomUUID();
            let completion: Promise<ActionExecuteResult> | undefined;
            const observed = await params.observeActionExecution({ actionId, input: { managedId: request.machine.id, purpose: request.purpose },
                actionRequestId: requestId, execute: operation => {
                    operation.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: request.machine.id } });
                    completion = (async () => {
                        const lifetime = new AbortController();
                        const cancel = () => {
                            if (lifetime.signal.aborted) return;
                            try { logger.warnLocalFile('[managed-policy.operation-abort]', { managedId: request.machine.id,
                                operationId: operation.operationAcceptance?.operationId,
                                reasonCode: operation.signal.aborted ? 'operation_cancelled' : 'policy_scheduler_aborted' }); } catch { /* Diagnostic only. */ }
                            lifetime.abort(operation.signal.aborted ? operation.signal.reason : request.signal?.reason);
                        };
                        operation.signal.addEventListener('abort', cancel, { once: true });
                        request.signal?.addEventListener('abort', cancel, { once: true });
                        if (operation.signal.aborted || request.signal?.aborted) cancel();
                        try {
                            const context = { ...operation, signal: lifetime.signal };
                            const result = await withBoundDriver(params, lifetime.signal, async driver => await driver.executePolicy(
                                request.machine, request.purpose, { requestId, context, signal: lifetime.signal,
                                    ...(request.retentionContinuationRequestId ? { retentionContinuationRequestId: request.retentionContinuationRequestId } : {}),
                                    ...(request.actionOrigin ? { actionOrigin: request.actionOrigin } : {}),
                                    runPolicyAction: (machine, runApproved) => params.executeManagedPolicyAction!(machine, context, runApproved) },
                            ));
                            return { ok: true as const, result };
                        } catch (error) {
                            const actionFailure = error && typeof error === 'object' && 'actionFailure' in error
                                ? ActionExecuteFailureSchema.safeParse(error.actionFailure) : null;
                            if (!lifetime.signal.aborted && actionFailure?.success) return actionFailure.data;
                            if (isManagedMachinePolicyRetentionSatisfiedAbort(lifetime.signal.reason)
                                && operation.operationAcceptance?.operationId) {
                                return { ok: true as const, result: ManagedIntentResultSchema.parse({
                                    kind: 'accepted', managedId: request.machine.id,
                                    intentRevision: request.machine.intentRevision,
                                    operation: { operationId: operation.operationAcceptance.operationId },
                                }) };
                            }
                            const supersededWait = request.purpose.kind === 'retention' && error instanceof ManagedRetentionWaitSuperseded;
                            if (supersededWait) {
                                try { logger.warnLocalFile('[managed-policy.wait-superseded]', { managedId: request.machine.id,
                                    operationId: operation.operationAcceptance?.operationId, reasonCode: error.code }); } catch { /* Diagnostic only. */ }
                            }
                            const code = lifetime.signal.aborted || supersededWait ? 'cancelled'
                                : readRpcErrorCode(error)
                                    ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'managed_controller_request_failed');
                            return { ok: false as const, errorCode: code, error: code };
                        } finally {
                            operation.signal.removeEventListener('abort', cancel);
                            request.signal?.removeEventListener('abort', cancel);
                        }
                    })();
                    return completion;
                } });
            // The UI may observe acceptance early; the native preparation
            // caller stays within this same real host operation's lifetime.
            return completion ? await completion : observed;
        },
    });
}
