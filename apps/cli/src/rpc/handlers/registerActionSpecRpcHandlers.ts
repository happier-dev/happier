import {
    readExecutionRunStartRunCreation,
    withExecutionRunStartFailureDetails,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type ActionId,
} from '@happier-dev/protocol/actions';
import {
    ACTION_SPECS,
    type ActionSpecSurfaceBindings,
    type ActionSurfaceBindingContext,
} from '@happier-dev/protocol/actions/actionSpecs';

import {
    dispatchActionFromRpc,
    type RpcActionExecutor,
} from './_actionDispatchAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
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
    resolveActionExecutor?: () => RpcActionExecutor | Promise<RpcActionExecutor>;
    actionSpecs?: readonly ActionSpecRpcHandlerSpec[];
    exceptions?: readonly ActionSpecRpcExceptionLike[];
    actionIds?: readonly string[];
    methods?: readonly string[];
    scopes?: readonly ActionSpecRpcRegistrationScope[];
    /** Authority stamped by the host-owned RPC ingress; never inferred from surface. */
    authority?: ActionExecutorContext['authority'];
    observeExecution?: (request: Readonly<{
        actionId: string;
        input: unknown;
        sessionId?: string;
        execute: (context: Readonly<{
            signal: AbortSignal;
            operationProgress: NonNullable<RpcHandlerContext['localActionContext']>['operationProgress'];
            operationOwnerUpdate: NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate'];
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
    const details = actionId === 'execution.run.start'
        ? withExecutionRunStartFailureDetails(
            undefined,
            readExecutionRunStartRunCreation(result.details),
        )
        : undefined;
    return {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(details !== undefined ? { details } : {}),
    };
}

async function resolveActionExecutor(
    params: Pick<RegisterActionSpecRpcHandlersParams, 'actionExecutor' | 'resolveActionExecutor'>,
): Promise<RpcActionExecutor> {
    if (params.actionExecutor) {
        return params.actionExecutor;
    }
    if (params.resolveActionExecutor) {
        return await params.resolveActionExecutor();
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
    signal?: AbortSignal,
): ActionSurfaceBindingContext {
    const hints = buildActionExecutorContextHints(input);
    return {
        actionId,
        surface: 'rpc',
        caller: { kind: 'host' },
        ...hints,
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
            const mappedRequest = await params.mapRequestForMethod?.({
                actionId: typedActionId,
                method,
                isAlias,
                input,
            }) ?? { accepted: true as const, input };
            if (!mappedRequest.accepted) {
                return mappedRequest.response;
            }
            const rpcBinding = spec.surfaceBindings?.rpc;
            let semanticInput = mappedRequest.input;
            if (rpcBinding) {
                const transportInput = rpcBinding.inputSchema.safeParse(mappedRequest.input);
                if (!transportInput.success) {
                    return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_input'));
                }
                try {
                    semanticInput = await rpcBinding.decodeInput(
                        transportInput.data,
                        buildRpcSurfaceBindingContext(typedActionId, transportInput.data, context?.signal),
                    );
                } catch {
                    return unwrapActionResultForRpc(typedActionId, transportFailure(typedActionId, 'invalid_action_transport_input'));
                }
            }
            const executor = await resolveActionExecutor(params);
            const execute = async (execution: Readonly<{
                signal?: AbortSignal;
                operationProgress?: NonNullable<RpcHandlerContext['localActionContext']>['operationProgress'];
                operationOwnerUpdate?: NonNullable<RpcHandlerContext['localActionContext']>['operationOwnerUpdate'];
            }>): Promise<ActionExecuteResult> => await dispatchActionFromRpc({
                actionId: typedActionId,
                input: semanticInput,
                ...buildActionExecutorContextHints(semanticInput),
                ...(execution.signal ? { signal: execution.signal } : {}),
                ...(
                    context?.localActionContext || execution.operationProgress || execution.operationOwnerUpdate || params.authority
                      ? {
                          localActionContext: {
                              ...context?.localActionContext,
                              ...(params.authority ? { authority: params.authority } : {}),
                              ...(execution.operationProgress
                                ? { operationProgress: execution.operationProgress }
                                : {}),
                              ...(execution.operationOwnerUpdate
                                ? { operationOwnerUpdate: execution.operationOwnerUpdate }
                                : {}),
                          },
                        }
                      : {}
                ),
                executor,
            });
            const sessionId = readDefaultSessionIdFromRpcInput(semanticInput);
            const result = params.observeExecution && spec.operation
                ? await params.observeExecution({
                    actionId,
                    input: semanticInput,
                    ...(sessionId ? { sessionId } : {}),
                    execute: async ({ signal, operationProgress, operationOwnerUpdate }) => await execute({
                        signal,
                        operationProgress,
                        operationOwnerUpdate,
                    }),
                })
                : await execute({ ...(context?.signal ? { signal: context.signal } : {}) });
            if (!result.ok || !rpcBinding) {
                return unwrapActionResultForRpc(typedActionId, result);
            }
            let encoded: unknown;
            try {
                encoded = await rpcBinding.encodeOutput(
                    result.result,
                    buildRpcSurfaceBindingContext(typedActionId, semanticInput, context?.signal),
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
