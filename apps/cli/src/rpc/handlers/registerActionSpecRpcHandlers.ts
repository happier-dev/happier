import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol/actions';
import { ACTION_SPECS } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionSpecSurfaceBindings, ActionSurfaceBindingContext } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionFollowSourceKeyPreparationResultV1Schema, SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1, projectSessionFollowSourceKeyPreparationAfterSetV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { ProjectWorkerDependencyV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionOperationFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import {
    dispatchActionFromRpc,
    type RpcActionExecutor,
} from './_actionDispatchAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { isSessionActionRpcMethodV1 } from '@happier-dev/protocol/socketRpc';
import { canUseCustodianAccountForMachineRequest } from '@/daemon/lifecycle/requesterWorkAttribution';
import { isAdmittedRequesterSessionBootstrapCurrent } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { ACTION_SPEC_RPC_EXCEPTIONS } from './actionSpecRpcExceptions';
import {
    type ActionSpecRpcRegistrationScope,
    isActionSpecRpcSpecInScopes,
} from './actionSpecRpcRegistration';

export type ActionSpecRpcHandlerSpec = Readonly<{
    id: string;
    operation?: unknown;
    surfaces?: Readonly<{ rpc?: boolean }>;
    bindings?: Readonly<{ rpcMethod?: string | null; rpcMethodAliases?: readonly string[] }>;
    surfaceBindings?: ActionSpecSurfaceBindings;
}>;

export type ActionSpecRpcExceptionLike = Readonly<{
    method: string;
    actionId?: string;
    [metadataKey: string]: unknown;
}>;

export type ActionSpecRpcRegistrar = Readonly<{
    hasHandler?: (method: string) => boolean;
    registerHandler(
        method: string,
        handler: (input: unknown, context?: RpcHandlerContext) => Promise<unknown>,
    ): void;
}>;

export type RegisterActionSpecRpcHandlersParams = Readonly<{
    rpcHandlerManager: ActionSpecRpcRegistrar;
    actionExecutor?: RpcActionExecutor;
    resolveActionExecutor?: (request: Readonly<{
        actionId: ActionId;
        method: string;
        isAlias: boolean;
        /** Original transport input, before a compatibility adapter maps it. */
        input: unknown;
        /** Genuine receiving transport custody, never reconstructed from Action context/input. */
        ingress?: RpcHandlerContext;
    }>) => RpcActionExecutor | Promise<RpcActionExecutor>;
    actionSpecs?: readonly ActionSpecRpcHandlerSpec[];
    exceptions?: readonly ActionSpecRpcExceptionLike[];
    actionIds?: readonly string[];
    methods?: readonly string[];
    scopes?: readonly ActionSpecRpcRegistrationScope[];
    /** Authority stamped by the host-owned RPC ingress; never inferred from surface. */
    /** Exact current daemon Machine; enables strict transport-target request wrappers. */
    targetMachineId?: string;
    /** Machine-scoped handlers must not let an input Session selector choose a different ingress. */
    defaultMachineTarget?: true;
    observeExecution?: (request: Readonly<{
        actionId: string;
        input: unknown;
        actionRequestId?: string;
        sessionId?: string;
        rpcContext?: RpcHandlerContext;
        execute: (context: Readonly<{
            actionRequestId?: string;
            signal: AbortSignal;
            operationProgress: NonNullable<RpcHandlerContext['localActionContext']>['operationProgress'];
            operationOwnerUpdate: NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate'];
            operationAcceptance?: NonNullable<RpcHandlerContext['localActionContext']>['operationAcceptance'];
            operationCancellation?: NonNullable<RpcHandlerContext['localActionContext']>['operationCancellation'];
            operationReview?: NonNullable<RpcHandlerContext['localActionContext']>['operationReview'];
            requesterWorkAttributionV1?: NonNullable<RpcHandlerContext['localActionContext']>['requesterWorkAttributionV1'];
        }>) => Promise<ActionExecuteResult>;
    }>) => Promise<ActionExecuteResult>;
    mapResponseForMethod?: (context: Readonly<{
        actionId: ActionId;
        method: string;
        isAlias: boolean;
        response: unknown;
    }>) => unknown | Promise<unknown>;
    mapRequestForMethod?: (context: Readonly<{
        actionId: ActionId;
        method: string;
        isAlias: boolean;
        input: unknown;
    }>) => Readonly<
        | { accepted: true; input: unknown }
        | { accepted: false; response: unknown }
    > | Promise<Readonly<
        | { accepted: true; input: unknown }
        | { accepted: false; response: unknown }
    >>;
}>;

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readObjectValue(input: unknown, key: string): unknown {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    return (input as Record<string, unknown>)[key];
}

export function readDefaultSessionIdFromRpcInput(input: unknown): string | undefined {
    return normalizeOptionalString(readObjectValue(input, 'parentSessionId'))
        ?? normalizeOptionalString(readObjectValue(input, 'sessionId'));
}

export function readServerIdFromRpcInput(input: unknown): string | undefined {
    return normalizeOptionalString(readObjectValue(input, 'serverId'));
}

export function unwrapActionResultForRpc(actionId: ActionId, result: ActionExecuteResult): unknown {
    if (result.ok) {
        return result.result;
    }
    let details: unknown = actionId === 'execution.run.start'
        ? withExecutionRunStartFailureDetails(
            undefined,
            readExecutionRunStartRunCreation(result.details),
        )
        : undefined;
    if (Object.prototype.hasOwnProperty.call(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId)) {
        const projected = ActionOperationFailureV1Schema.safeParse({ errorCode: result.errorCode, error: result.error, details: result.details });
        details = projected.success ? projected.data.details : undefined;
    }
    if (actionId === 'projects.worker.copy.retire') {
        const outcomeUnknown = readObjectValue(result.details, 'kind') === 'outcomeUnknown';
        if (result.errorCode === 'workspace_sync_relationship_in_use') {
            const dependencies = ProjectWorkerDependencyV1Schema.array().safeParse(readObjectValue(result.details, 'dependencies'));
            if (dependencies.success) details = { ...(outcomeUnknown ? { kind: 'outcomeUnknown' } : {}), dependencies: dependencies.data };
        }
        if (outcomeUnknown && details === undefined) details = { kind: 'outcomeUnknown' };
    }
    if (actionId === 'session.spawn_new'
        && result.errorCode === SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1
        && readObjectValue(result.details, 'status') === 'waiting'
        && readObjectValue(result.details, 'edgeCommitted') === true) {
        const source = SessionSpawnNewResultV1Schema.safeParse(readObjectValue(result.details, 'source'));
        const preparation = SessionFollowSourceKeyPreparationResultV1Schema.safeParse({
            kind: 'waiting', reason: readObjectValue(result.details, 'reason'),
        });
        if (source.success && source.data.type === 'success' && preparation.success) {
            const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: source.data }, preparation.data);
            if ('ok' in projected) {
                return { ok: false, errorCode: result.errorCode, error: result.error, details: projected.details };
            }
        }
    }
    return {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(details !== undefined ? { details } : {}),
    };
}

async function resolveActionExecutor(
    params: Pick<RegisterActionSpecRpcHandlersParams, 'actionExecutor' | 'resolveActionExecutor'>,
    request: Parameters<NonNullable<RegisterActionSpecRpcHandlersParams['resolveActionExecutor']>>[0],
): Promise<RpcActionExecutor> {
    const requester = request.ingress?.callerInputAuthorization?.requesterAccountExecutor;
    if (requester) return requester;
    if (params.actionExecutor) {
        return params.actionExecutor;
    }
    if (params.resolveActionExecutor) {
        return await params.resolveActionExecutor(request);
    }
    throw new Error('action_spec_rpc_executor_required');
}

function buildIncludedSet(values: readonly string[] | undefined): ReadonlySet<string> | null {
    return values ? new Set(values.map((value) => value.trim()).filter(Boolean)) : null;
}

function isIncluded(value: string, included: ReadonlySet<string> | null): boolean {
    return !included || included.has(value);
}

function buildActionExecutorContextHints(input: unknown): Pick<ActionExecutorContext, 'defaultSessionId' | 'serverId'> {
    const defaultSessionId = readDefaultSessionIdFromRpcInput(input);
    const serverId = readServerIdFromRpcInput(input);
    return {
        ...(defaultSessionId ? { defaultSessionId } : {}),
        ...(serverId ? { serverId } : {}),
    };
}

function collectExceptionMethods(exceptions: readonly ActionSpecRpcExceptionLike[] | undefined): ReadonlySet<string> {
    return new Set((exceptions ?? ACTION_SPEC_RPC_EXCEPTIONS).map((exception) => exception.method.trim()).filter(Boolean));
}

function collectRpcMethodsForSpec(spec: ActionSpecRpcHandlerSpec): readonly string[] {
    const primaryMethod = normalizeOptionalString(spec.bindings?.rpcMethod);
    const methods = [
        ...(primaryMethod ? [primaryMethod] : []),
        ...(spec.bindings?.rpcMethodAliases ?? []).map(normalizeOptionalString).filter((value): value is string => Boolean(value)),
    ];
    return [...new Set(methods)];
}

function transportFailure(
    actionId: ActionId,
    errorCode: 'invalid_action_transport_input' | 'invalid_action_transport_output',
): ActionExecuteResult {
    return {
        ok: false,
        errorCode,
        error: errorCode,
        ...(actionId === 'execution.run.start'
            ? {
                details: withExecutionRunStartFailureDetails(
                    undefined,
                    errorCode === 'invalid_action_transport_input'
                        ? 'noRunCreated'
                        : 'outcomeUnknown',
                ),
            }
            : {}),
    };
}

function buildRpcSurfaceBindingContext(
    actionId: ActionId,
    input: unknown,
    externalActionTarget?: ActionExecutorContext['externalActionTarget'],
    signal?: AbortSignal,
): ActionSurfaceBindingContext {
    const hints = buildActionExecutorContextHints(input);
    return {
        actionId,
        surface: 'rpc',
        caller: { kind: 'host' },
        ...hints,
        ...(externalActionTarget ? { externalActionTarget } : {}),
        ...(signal ? { signal } : {}),
    };
}

export function registerActionSpecRpcHandlers(params: RegisterActionSpecRpcHandlersParams): void {
    const actionSpecs = params.actionSpecs ?? ACTION_SPECS;
    const actionIds = buildIncludedSet(params.actionIds);
    const methods = buildIncludedSet(params.methods);
    const scopes = params.scopes ?? null;
    const exceptionMethods = collectExceptionMethods(params.exceptions);
    const registeredMethods = new Map<string, string>();
    const targetMachineId = normalizeOptionalString(params.targetMachineId);

    for (const spec of actionSpecs) {
        if (spec.surfaces?.rpc !== true) {
            continue;
        }
        const actionId = spec.id.trim();
        const rpcMethod = normalizeOptionalString(spec.bindings?.rpcMethod);
        if (!actionId || !rpcMethod) {
            continue;
        }
        if (!isIncluded(actionId, actionIds) || !isIncluded(rpcMethod, methods)) {
            continue;
        }
        if (scopes && !isActionSpecRpcSpecInScopes(spec, scopes)) {
            continue;
        }
        if (exceptionMethods.has(rpcMethod)) {
            continue;
        }

        const handleAction = async (
            input: unknown,
            context?: RpcHandlerContext,
            method: string = rpcMethod,
            isAlias: boolean = method !== rpcMethod,
        ) => {
            const typedActionId = actionId as ActionId;
            if (context?.machineAdmission
                && (typedActionId === 'session.spawn_new' || typedActionId === 'execution.run.start'
                    || typedActionId === 'workflow.run.start')
                && !await canUseCustodianAccountForMachineRequest(context)
                && !(typedActionId !== 'session.spawn_new' && context.callerInputAuthorization?.requesterAccountExecutor
                    && await context.callerInputAuthorization.requesterAccountProjection?.isCurrent())
                && !(typedActionId === 'session.spawn_new' && await isAdmittedRequesterSessionBootstrapCurrent(context))) {
                return unwrapActionResultForRpc(typedActionId, {
                    ok: false, errorCode: context.signal.aborted ? 'cancelled' : 'target_unavailable',
                    error: context.signal.aborted ? 'cancelled' : 'target_unavailable',
                });
            }
            // Older Homes drop unknown origin headers. Never reinterpret an
            // unstamped autonomous Session edit as local or human authority.
            if (isSessionActionRpcMethodV1(method) && !context?.sessionActionOrigin
                && !context?.localActionContext && context?.callerAuthority !== 'present_user') {
                return { ok: false, errorCode: 'role_rpc_origin_unavailable', error: 'role_rpc_origin_unavailable' };
            }
            const mappedRequest = await params.mapRequestForMethod?.({
                actionId: typedActionId,
                method,
                isAlias,
                input,
            }) ?? { accepted: true as const, input };
            if (!mappedRequest.accepted) {
                return mappedRequest.response;
            }
            let externalActionTarget: ActionExecutorContext['externalActionTarget'] = params.defaultMachineTarget && targetMachineId
                ? { kind: 'machine', machineId: targetMachineId } : undefined;
            let envelopeDefaultSessionId: string | undefined;
            let transportInput = mappedRequest.input;
            if (readObjectValue(mappedRequest.input, 'kind') === 'targeted_action_rpc') {
                const envelope = TargetedActionRpcRequestV1Schema.safeParse(mappedRequest.input);
                if (
                    !envelope.success
                    || !targetMachineId
                    || envelope.data.target.kind !== 'machine'
                    || envelope.data.target.machineId !== targetMachineId
                ) {
                    return unwrapActionResultForRpc(
                        typedActionId,
                        transportFailure(typedActionId, 'invalid_action_transport_input'),
                    );
                }
                transportInput = envelope.data.input;
                externalActionTarget = envelope.data.target;
                envelopeDefaultSessionId = envelope.data.defaultSessionId;
            }
            const rpcBinding = spec.surfaceBindings?.rpc;
            let semanticInput = transportInput;
            if (rpcBinding) {
                const parsedTransportInput = rpcBinding.inputSchema.safeParse(transportInput);
                if (!parsedTransportInput.success) {
                    return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_input'));
                }
                try {
                    semanticInput = await rpcBinding.decodeInput(
                        parsedTransportInput.data,
                        buildRpcSurfaceBindingContext(
                            typedActionId,
                            parsedTransportInput.data,
                            externalActionTarget,
                            context?.signal,
                        ),
                    );
                } catch {
                    return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_input'));
                }
            }
            const inputSessionId = readDefaultSessionIdFromRpcInput(semanticInput);
            if (envelopeDefaultSessionId && inputSessionId && inputSessionId !== envelopeDefaultSessionId) {
                return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_input'));
            }
            const executor = await resolveActionExecutor(params, { actionId: typedActionId, method, isAlias, input,
                ...(context ? { ingress: context } : {}) });
            const execute = async (execution: Readonly<{
                actionRequestId?: string;
                signal?: AbortSignal;
                operationProgress?: NonNullable<RpcHandlerContext['localActionContext']>['operationProgress'];
                operationOwnerUpdate?: NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate'];
                operationAcceptance?: NonNullable<RpcHandlerContext['localActionContext']>['operationAcceptance'];
                operationCancellation?: NonNullable<RpcHandlerContext['localActionContext']>['operationCancellation'];
                operationReview?: NonNullable<RpcHandlerContext['localActionContext']>['operationReview'];
                requesterWorkAttributionV1?: NonNullable<RpcHandlerContext['localActionContext']>['requesterWorkAttributionV1'];
            }>): Promise<ActionExecuteResult> => {
                const actionRequestId = execution.actionRequestId ?? context?.transportRequestId;
                return await dispatchActionFromRpc({
                    actionId: typedActionId,
                    input: semanticInput,
                    ...buildActionExecutorContextHints(semanticInput),
                    // The caller's invoking Session travels as transport context, never as Action input.
                    ...(envelopeDefaultSessionId ? { defaultSessionId: envelopeDefaultSessionId } : {}),
                    ...(externalActionTarget ? { externalActionTarget } : {}),
                    ...(execution.signal ? { signal: execution.signal } : {}),
                    ...(context?.callerAuthority ? { callerAuthority: context.callerAuthority } : {}),
                    ...(context?.sessionActionOrigin ? { sessionActionOrigin: context.sessionActionOrigin } : {}),
                    ...(context?.authorization?.kind === 'session.write'
                        ? { rpcSessionAuthorization: context.authorization } : {}),
                    ...(context?.machineAdmission ? { runtimeAccountId: context.machineAdmission.actorAccountId } : {}),
                    ...(context?.machineAdmission ? { machineAdmission: context.machineAdmission } : {}),
                    ...(context?.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}),
                    ...(context?.requesterSessionBootstrap ? { requesterSessionBootstrap: context.requesterSessionBootstrap } : {}),
                    ...(context?.callerInputAuthorization ? { callerInputAuthorization: context.callerInputAuthorization } : {}),
                    ...(context?.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
                    ...(context?.callerInputAuthorization && (context.callerInputAuthorization.requesterAccountProjection
                        || context.sessionActionOrigin && 'authentication' in context.callerInputAuthorization.binding
                          && context.callerInputAuthorization.binding.sessionActionOrigin)
                        ? { externalActionExecutionAuthorization: context.callerInputAuthorization } : {}),
                    ...(
                        context?.localActionContext || actionRequestId || execution.operationProgress || execution.operationOwnerUpdate || execution.operationAcceptance || execution.operationCancellation
                            ? {
                                localActionContext: {
                                    ...context?.localActionContext,
                                    ...(actionRequestId
                                        ? { actionRequestId }
                                        : {}),
                                    ...(execution.operationProgress
                                        ? { operationProgress: execution.operationProgress }
                                        : {}),
                                    ...(execution.operationOwnerUpdate
                                        ? { operationOwnerUpdate: execution.operationOwnerUpdate }
                                        : {}),
                                    ...(execution.operationAcceptance
                                        ? { operationAcceptance: execution.operationAcceptance }
                                        : {}),
                                    ...(execution.operationCancellation
                                        ? { operationCancellation: execution.operationCancellation }
                                        : {}),
                                    ...(execution.operationReview
                                        ? { operationReview: execution.operationReview }
                                        : {}),
                                    ...(execution.requesterWorkAttributionV1
                                        ? { requesterWorkAttributionV1: execution.requesterWorkAttributionV1 }
                                        : {}),
                                },
                            }
                            : {}
                    ),
                    executor,
                });
            };
            const sessionId = readDefaultSessionIdFromRpcInput(semanticInput);
            const result = params.observeExecution && spec.operation
                ? await params.observeExecution({
                    actionId,
                    input: semanticInput,
                    ...(context ? { rpcContext: context } : {}),
                    ...(context?.localActionContext?.actionRequestId
                        ? { actionRequestId: context.localActionContext.actionRequestId }
                        : {}),
                    ...(sessionId ? { sessionId } : {}),
                    execute: async ({ actionRequestId, signal, operationProgress, operationOwnerUpdate, operationAcceptance, operationCancellation, requesterWorkAttributionV1, operationReview }) => await execute({
                        ...(actionRequestId ? { actionRequestId } : {}),
                        signal,
                        operationProgress,
                        operationOwnerUpdate,
                        ...(operationAcceptance ? { operationAcceptance } : {}),
                        ...(operationCancellation ? { operationCancellation } : {}),
                        ...(operationReview ? { operationReview } : {}),
                        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
                    }),
                })
                : await execute({ ...(context?.signal ? { signal: context.signal } : {}) });
            if (!result.ok || !rpcBinding) {
                return unwrapActionResultForRpc(typedActionId, result);
            }
            const deferredApproval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (deferredApproval.success) {
                return deferredApproval.data.actionId === typedActionId
                    ? deferredApproval.data
                    : unwrapActionResultForRpc(
                        typedActionId,
                        transportFailure(typedActionId, 'invalid_action_transport_output'),
                    );
            }
            let encoded: unknown;
            try {
                encoded = await rpcBinding.encodeOutput(
                    result.result,
                    buildRpcSurfaceBindingContext(
                        typedActionId,
                        semanticInput,
                        externalActionTarget,
                        context?.signal,
                    ),
                );
            } catch {
                return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_output'));
            }
            const transportOutput = rpcBinding.outputSchema.safeParse(encoded);
            return transportOutput.success
                ? transportOutput.data
                : unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_output'));
        };

        for (const method of collectRpcMethodsForSpec(spec)) {
            if (exceptionMethods.has(method)) {
                continue;
            }

            const existingActionId = registeredMethods.get(method);
            if (existingActionId) {
                throw new Error(`duplicate_action_spec_rpc_method:${method}:${existingActionId}:${actionId}`);
            }
            if (params.rpcHandlerManager.hasHandler?.(method)) {
                throw new Error(`duplicate_action_spec_rpc_method:${method}:existing_handler:${actionId}`);
            }
            registeredMethods.set(method, actionId);

            params.rpcHandlerManager.registerHandler(method, async (
                input: unknown,
                context?: RpcHandlerContext,
            ) => {
                const isAlias = method !== rpcMethod;
                const response = await handleAction(input, context, method, isAlias);
                return await params.mapResponseForMethod?.({
                    actionId: actionId as ActionId,
                    method,
                    isAlias,
                    response,
                }) ?? response;
            });
        }
    }
}
