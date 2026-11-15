import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedAcquireInputV1Schema, ManagedCredentialInstallInputV1Schema, ManagedMachineActionOutputSchemasV1, ManagedGetOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveAccountExecutionRuntime, type AccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { openManagedMachineRead } from '@/machines/managed/readManagedMachine';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ManagedMachineFullV1, ManagedMachineV1, ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { randomUUID } from 'node:crypto';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { logger } from '@/ui/logger';
import { ManagedMachineControllerError, ManagedRetentionWaitSuperseded } from '@/machines/managed/controllerErrors';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineOperationSettlementContext } from '@/machines/managed/managedIntentReconciler';

import { prepareInstalledWorkflowActionAuthorization } from '@/api/installedWorkflowActionAuthorization';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { StoredCredentials } from '@/persistence';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import type { ManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
import type { PrepareExternalActionRequesterAccountContext } from '../externalActions/executeExternalAction';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { ManagedGuestLocalStop } from '@/machines/managed/managedRetentionPolicy';

/** The incumbent daemon factory binds the current controller to its driver. */
type ManagedMachineActionAdapterParams = Readonly<{
    credentials: StoredCredentials;
    /** Installed native custody is separate from an admitted foreign requester's policy/Ask. */
    controllerCredentials?: StoredCredentials;
    machineId: string;
    serverBaseUrl: string;
    serverId: string;
    executeSessionStart?: (input: SessionSpawnNewInputV2, context: ActionExecutorContext, machine: ManagedMachineV1) => Promise<ActionExecuteResult>;
    executeEnvironmentSetup?: (machine: ManagedMachineFullV1, context: ActionExecutorContext, isCurrent: () => Promise<boolean>) => Promise<ActionExecuteResult>;
    subscribeEnvironmentSetupChanges?: (context: ActionExecutorContext, callbacks: Readonly<{ onChange(): void; onError(error: unknown): void }>) => Promise<{ dispose(): void | Promise<void> }>;
    observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
    preflightSessionStart?: (context: ActionExecutorContext) => Promise<boolean>;
    resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
    installationIdentity: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }> | null;
    managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
    executeTeamCredentialBrokerAction?: Parameters<typeof resolveAccountExecutionRuntime>[0]['executeTeamCredentialBrokerAction'];
    managedGuestLocalStop?: ManagedGuestLocalStop;
    observeActionExecution?: ApiMachineClient['observeActionExecution'];
    readPolicyCurrent?: (managedId: string, signal?: AbortSignal) => Promise<ManagedMachineV1 | null>;
    prepareTeamCredentialNativeSource?: RuntimeProviderModelManagementServices['prepareTeamCredentialNativeSource'];
    subscribeManagedMachineChanges?: ApiMachineClient['onManagedMachinePolicyInvalidated'];
    executeManagedPolicyAction?: <Machine extends ManagedMachineReadSnapshotV1>(machine: Machine, context: ActionExecutorContext,
        runApproved: (context: ActionExecutorContext) => Promise<Machine>, purpose: ManagedPolicyPurposeV1) => Promise<Machine>;
    prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
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

async function withBoundDriver<T>(params: ManagedMachineActionAdapterParams, signal: AbortSignal | undefined,
    execute: (driver: ReturnType<typeof import('@/machines/managed/acquire')['createManagedMachineAcquisitionDriver']>,
        controllerCredentials: StoredCredentials) => Promise<T>): Promise<T> {
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
        let accountRuntime: Promise<AccountExecutionRuntime> | undefined;
        let current = true;
        try {
            const { createManagedMachineAcquisitionDriver } = await import('@/machines/managed/acquire');
            const controllerCredentials = params.controllerCredentials ?? params.credentials;
            const isCurrent = () => current && !signal?.aborted;
            const resolveAccountRuntime = async () => {
                accountRuntime ??= runWithServerHttpBaseUrl(params.serverBaseUrl, async () => {
                    await ensureCliActionPolicySettings(controllerCredentials, params.serverBaseUrl);
                    const snapshot = getActiveAccountSettingsSnapshot();
                    if (!snapshot) throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
                    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                    const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({
                        credentials: controllerCredentials, snapshot, serverHttpBaseUrl: params.serverBaseUrl,
                        isCurrent: async () => isCurrent() && lifetime === getActiveAccountSettingsSnapshotLifetimeToken(),
                    });
                    return await resolveAccountExecutionRuntime({ signal,
                        executeTeamCredentialBrokerAction: params.executeTeamCredentialBrokerAction,
                        credentialRuntimeRegistry: lease.registry,
                        accountExecution: { credentials: controllerCredentials, serverUrl: params.serverBaseUrl,
                            serverId: params.serverId, serverIdentityId: origin.serverIdentityId,
                            machineId: params.machineId, explicitMachineId: params.machineId,
                            savedSecretOperationContext, isCurrent,
                        } });
                });
                const runtime = await accountRuntime;
                if (!runtime.purposeRuntime) throw Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' });
                return { runtimeRegistry: runtime.registry, managedProviderOperationAuthority:
                    params.managedProviderOperationAuthority!.forPurposeBindingOwner(runtime.purposeRuntime.purposes) };
            };
            return await execute(createManagedMachineAcquisitionDriver({
                token: controllerCredentials.token, serverUrl: params.serverBaseUrl,
                homeId: origin.serverIdentityId,
                controller: { machineId: params.machineId, installationId: params.installationIdentity.installationId },
                runtimeRegistry: lease.registry,
                resolveAccountRuntime,
                externalActionMachineRequestPrivateKey: params.installationIdentity.privateKey,
                managedProviderOperationAuthority: params.managedProviderOperationAuthority,
                ...(params.managedGuestLocalStop ? { managedGuestLocalStop: params.managedGuestLocalStop } : {}),
                credentials: controllerCredentials,
                observeRecordedApprovalExecution: params.observeRecordedApprovalExecution,
                homeTarget,
                ...(params.readPolicyCurrent ? { readPolicyCurrent: params.readPolicyCurrent } : {}),
                ...(params.prepareTeamCredentialNativeSource ? { prepareTeamCredentialNativeSource: params.prepareTeamCredentialNativeSource } : {}),
                ...(params.subscribeManagedMachineChanges ? { subscribeManagedMachineChanges: params.subscribeManagedMachineChanges } : {}),
            }), controllerCredentials);
        } finally {
            current = false;
            try { if (accountRuntime) await accountRuntime.then(runtime => runtime.registry.dispose(), () => {}); }
            finally { await lease.release(); }
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
        // Preflight reads retain the invoking Action's context; they do not
        // become separately authorized Workflow effects.
        if (runId && getActionSpec(actionId).sideEffectClass !== 'read' && !context.externalActionExecutionAuthorization) {
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
            || (context.externalActionExecutionAuthorization && context.actionCaller?.kind === 'session' && !params.observeRecordedApprovalExecution)
            || (context.externalActionExecutionAuthorization && (!params.preflightSessionStart || !await params.preflightSessionStart(context))))) {
            throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
        }
        const result = await withBoundDriver(params, signal, async (driver, controllerCredentials) => await driver.execute(actionId, input, { requestId, context, signal,
                ...(params.subscribeEnvironmentSetupChanges ? { subscribeEnvironmentSetupChanges: callbacks => params.subscribeEnvironmentSetupChanges!(context, callbacks) } : {}),
                ...(params.executeEnvironmentSetup ? { runEnvironmentSetup: async ({ machine, isCurrent }) => {
                    if (!machine.enrolledMachineId || !machine.preset) throw Object.assign(new Error('intent_changed'), { code: 'intent_changed' });
                    const setup = await params.executeEnvironmentSetup!(machine, context, isCurrent);
                    if (!setup.ok) throw ManagedMachineControllerError.fromActionFailure(setup, 'machines.setup.apply');
                    const read = ManagedGetOutputV1Schema.parse(await driver.execute('machines.managed.get',
                        { homeId: machine.homeId, managedId: machine.id }, { requestId, context, signal }));
                    return await openManagedMachineRead({ credentials: controllerCredentials, serverHttpBaseUrl: params.serverBaseUrl,
                        read, ...(signal ? { signal } : {}) });
                } } : {}),
                ...(agentStart && executeSessionStart ? { runAgentStart: async ({ machine }) => {
                    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
                    if (!machine.enrolledMachineId) {
                        throw Object.assign(new Error('intent_changed'), { code: 'intent_changed' });
                    }
                    const result = await executeSessionStart({ ...agentStart,
                        executionTarget: { serverId: params.serverId, machineId: machine.enrolledMachineId },
                        managedCreation: { homeId: machine.homeId, managedId: machine.id, controller: machine.controller },
                    }, context, machine);
                    if (!result.ok) throw ManagedMachineControllerError.fromActionFailure(result, 'session.spawn_new');
                    const spawn = SessionSpawnNewActionResultV1Schema.safeParse(result.result);
                    if (!spawn.success) throw Object.assign(new Error('invalid_action_output'), { code: 'invalid_action_output' });
                    if (spawn.success && spawn.data.type === 'error') {
                        throw new ManagedMachineControllerError(spawn.data.code, undefined,
                            'agentId' in spawn.data && typeof spawn.data.agentId === 'string'
                                ? { kind: 'managedAgentStart', machineId: machine.enrolledMachineId, agentId: spawn.data.agentId }
                                : undefined);
                    }
                    if (spawn.success && spawn.data.type === 'pending') {
                        if (!context.operationOwnerUpdate) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                        context.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } });
                    } else if (spawn.success && spawn.data.type === 'success') {
                        context.operationOwnerUpdate?.update({ observation: null,
                            ...(spawn.data.agentUpdate ? { domainRef: { kind: 'managedMachine', id: machine.id,
                                agentUpdate: spawn.data.agentUpdate } } : {}),
                        });
                    }
                } } : {}),
            }));
        return result;
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
        const settlementContext: ManagedMachineOperationSettlementContext = context;
        const observesNativeSettlement = actionId === 'machines.managed.inspect' && observe
            && !settlementContext.settleManagedNativeOperation;
        // Detached Ask replay has no live parent's ports. Bind once through the
        // existing operation owner. Inspect binds only its private settlement
        // port; it remains read-only and creates no operation of its own.
        if (!context.operationAcceptance && (observesNativeSettlement || (getActionSpec(actionId).operation && (runId || observe)))) {
            if (!context.actionRequestId || !observe) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            const observed = await observe({ actionId, input, actionRequestId: context.actionRequestId,
                execute: async operation => {
                    if (runId && actionId !== 'machines.managed.inspect' && !operation.operationAcceptance) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                    // A detached Ask replay is only the admission carrier. Once
                    // the durable operation owns the accepted effect, ending the
                    // approving HTTP request must not cancel native dispatch.
                    // Explicit operation cancellation remains authoritative.
                    const lifetime = actionId === 'machines.managed.inspect' ? signal ?? operation.signal : operation.signal;
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
        /**
         * A Session placed on a managed target: the bound driver (and its runtime
         * lease) stays held for the Session's lifetime, because the target's
         * channels live as long as the Session; it is released when `lifetime` ends.
         */
        openSessionTarget: (request: import('@/machines/managed/acquire').ManagedSessionTargetRequest) =>
            new Promise<import('@/machines/managed/acquire').ManagedSessionTarget>((resolve, reject) => {
                void withBoundDriver(params, request.lifetime, async driver => {
                    resolve(await driver.openSessionTarget(request));
                    if (request.lifetime.aborted) return;
                    await new Promise(settle => request.lifetime.addEventListener('abort', settle, { once: true }));
                }).catch(reject);
            }),
        snapshotAdmitted: async (request: import('@/machines/managed/acquire').ManagedNativeSnapshotRequest) =>
            withBoundDriver(params, request.options.signal, driver => driver.snapshotAdmitted(request)),
        supportsNativeLifetimeRenewal: async (machine: ManagedMachineV1, signal: AbortSignal): Promise<boolean> =>
            withBoundDriver(params, signal, async driver => driver.supportsNativeLifetimeRenewal(machine)),
        reconcileObservation: async (machine: ManagedMachineV1, signal: AbortSignal): Promise<ManagedMachineV1> =>
            withBoundDriver(params, signal, async driver => ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse(
                await driver.execute('machines.managed.inspect', { homeId: machine.homeId, managedId: machine.id }, {
                    requestId: randomUUID(), signal, policyMachine: machine, policyPurpose: { kind: 'retention' },
                })).machine),
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
                                    policySchedulerSignal: request.signal,
                                    ...(request.retentionContinuationRequestId ? { retentionContinuationRequestId: request.retentionContinuationRequestId } : {}),
                                    ...(request.actionOrigin ? { actionOrigin: request.actionOrigin } : {}),
                                    runPolicyAction: (machine, runApproved) => params.executeManagedPolicyAction!(machine, context, runApproved, request.purpose) },
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
                            return { ok: false as const, errorCode: code, error: code,
                                ...(error instanceof ManagedMachineControllerError && error.code === code && error.details
                                    ? { details: error.details } : {}) };
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
