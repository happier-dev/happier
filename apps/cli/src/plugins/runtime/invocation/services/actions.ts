import {
    PluginError,
    type JsonValue,
    type PluginInvocationCaller,
    type PluginInvocationContributionIdentity,
    type PluginInvocationOriginSurface,
} from '@happier-dev/plugin-sdk';
import type {
    AdmittedTargetedOperationExecutionOptions,
    AdmittedTargetedOperationExecutionWithOriginOptions,
    AdmittedTargetedOperationExecutionHandle,
    AdmittedTargetedOperationIdentity,
    ActionsService,
    ContributedActionExecutionWithOriginOptions,
    ContributedActionExecutionWithOriginResult,
    PluginActionHandlerInvocation,
    PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import type {
    PluginCancellationOptions,
    PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointSemanticOperation } from '@happier-dev/plugin-sdk/host/targeted-contributions';
import type {
    PluginInvocationSurface,
} from '@happier-dev/plugin-sdk/interactions';
import {
    ActionIdSchema,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type ActionPluginCaller,
    type ActionId,
} from '@happier-dev/protocol/actions';
import {
    readExecutionRunStartRunCreation,
    pluginJsonValuesEqual,
    readPluginActionFailureAuthorPayload,
    PluginMachineExecutionOriginV1Schema,
    StrictJsonValueSchema,
    type QualifiedConnectedAccountRef,
    type PluginMachineExecutionOriginV1,
    withExecutionRunStartFailureDetails,
} from '@happier-dev/protocol';
import {
    pluginUiSelectedActionInputMatchesOperation,
    pluginUiTargetedContributionOperationKey,
    reconstructPluginUiSelectedActionInput,
    type PluginUiSelectedActionInputCarrierV1,
    PluginUiSelectedActionInputCarrierV1Schema,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    getActionSpec,
    type ActionSurfaceBindingContext,
} from '@happier-dev/protocol/actions/actionSpecs';
import type { AdmittedTargetedOperationExecutionRequest } from '../actions/executeContributedAction';
import { resolvePluginActionCaller } from './actionCaller';

export type PluginActionsServiceSeed = Readonly<{
    plugin: Readonly<{ id: string; version: string }>;
    /** The host-stamped immediate contribution that owns this invocation. */
    contribution?: PluginInvocationContributionIdentity;
    generation: string;
    /** Exact admitted plugin bytes, projected only from host runtime ownership. */
    immutableGenerationId?: string;
    correlationId?: string;
    surface: PluginInvocationSurface;
    /** Host-stamped provenance from the invocation that created this service. */
    caller?: PluginInvocationCaller;
    /** Host-private lookup of this invocation's current plugin materialization. */
    resolveCurrentPluginMaterializationRef?(): import('@happier-dev/protocol').PluginMachineMaterializationRefV1 | null;
    /** Untrusted, transient settlement forwarded from one mounted UI caller. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Re-read the originating mounted UI caller immediately before provider effect. */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    session?: Readonly<{ id: string }>;
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    /** Host-private recursion fence; only hook invocation owners may set this. */
    bypassActionInterception?: true;
}>;

export type PluginActionsHostExecutor = Readonly<{
    execute(
        actionId: ActionId,
        input: unknown,
        context?: ActionExecutorContext & Readonly<{
            actionCaller: ActionPluginCaller;
            signal: AbortSignal;
        }>,
    ): Promise<ActionExecuteResult>;
    bindInvocation?(signal: AbortSignal): PluginActionsHostExecutor;
}>;

export type ContributedActionInvocationResult = Readonly<
    | {
        status: 'executed';
        value: JsonValue | null;
        /** Present only for the host-private execution-origin request. */
        executionOrigin?: PluginMachineExecutionOriginV1;
    }
    | {
        status: 'unavailable' | 'invalid' | 'failed';
        code: string;
        message: string;
        /** Present only for a proven canonical PluginError from the target. */
        retryable?: boolean;
        /** The target's own published PluginError contract payload. */
        data?: JsonValue;
        /** Present only when the generic Action executor proves no handler began. */
        actionHandlerInvocation?: PluginActionHandlerInvocation;
    }
>;

export type InvokeContributedAction = (params: Readonly<{
    action: PluginContributionRef;
    input: JsonValue;
    /** A plugin-to-plugin invocation is always authorized on the target plugin surface. */
    surface: 'plugin';
    /** Diagnostic origin, deliberately separate from the target authorization surface. */
    originSurface?: PluginInvocationOriginSurface;
    /** Host-stamped immediate caller; plugin input never supplies this value. */
    caller: Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
    /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
    captureExecutionOrigin?: true;
    /** Equality-only precondition from ActionsService.executeWithExecutionOrigin only. */
    expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
    /** Opaque target-operation evidence from one original admitted-operation handle. */
    admittedTargetedOperation?: AdmittedTargetedOperationExecutionRequest;
    sessionId?: string;
    signal: AbortSignal;
}>) => Promise<ContributedActionInvocationResult>;

/**
 * The original host-created handle is the only executable capability. Its
 * public identity can be copied for display or comparison, but no copied value
 * is present in this host-private binding map.
 */
type AdmittedTargetedOperationSelectedActionInput = Readonly<
    | { kind: 'none' }
    | { kind: 'connectedAccount'; fieldPath: string }
    | { kind: 'unavailable' }
>;

type AdmittedTargetedOperationExecutionBinding = Readonly<{
    action: PluginContributionRef;
    contributorImmutableGenerationId: string;
    /** Full exact operation identity; the public handle exposes only a copy. */
    operation: PluginUiTargetedContributionOperationV1;
    /** The target that admitted this operation, absent from the public operation shape. */
    targetPluginId: string;
    /** Exact target generation that admitted this operation, also host-private. */
    targetImmutableGenerationId: string;
    /** Exact Action-definition selection fact, never carrier supplied. */
    selectedActionInput: AdmittedTargetedOperationSelectedActionInput;
    /** Exact target parser pair, retained only through this original handle. */
    targetProtocol: TargetedContributionPointSemanticOperation;
}>;

const admittedTargetedOperationExecutionBindings = new WeakMap<object, AdmittedTargetedOperationExecutionBinding>();

function freezeSelectedActionInput(
    selectedActionInput: AdmittedTargetedOperationSelectedActionInput | undefined,
): AdmittedTargetedOperationSelectedActionInput {
    if (!selectedActionInput || selectedActionInput.kind === 'none') {
        return Object.freeze({ kind: 'none' as const });
    }
    if (selectedActionInput.kind === 'unavailable') {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    return Object.freeze({
        kind: 'connectedAccount' as const,
        fieldPath: selectedActionInput.fieldPath,
    });
}

export function createAdmittedTargetedOperationExecutionHandle<
    TInput extends JsonValue = JsonValue,
    TResult extends JsonValue | void = JsonValue | void,
    TRole extends string = string,
>(params: Readonly<{
    action: PluginContributionRef;
    identity: AdmittedTargetedOperationIdentity<TRole>;
    /** Exact target generation from the admitted snapshot, never public handle data. */
    targetImmutableGenerationId: string;
    /** Host-private fact derived from the exact admitted Action definition. */
    selectedActionInput?: AdmittedTargetedOperationSelectedActionInput;
    /** Exact target parser pair selected by cold targeted-contribution admission. */
    targetProtocol: TargetedContributionPointSemanticOperation;
}>): AdmittedTargetedOperationExecutionHandle<TInput, TResult, TRole> {
    const identity = Object.freeze({
        target: Object.freeze({ pluginId: params.identity.target.pluginId }),
        point: Object.freeze({
            pointId: params.identity.point.pointId,
            protocol: Object.freeze({
                id: params.identity.point.protocol.id,
                version: params.identity.point.protocol.version,
            }),
        }),
        contributor: Object.freeze({
            pluginId: params.identity.contributor.pluginId,
            contributionId: params.identity.contributor.contributionId,
            immutableGenerationId: params.identity.contributor.immutableGenerationId,
        }),
        role: params.identity.role,
    });
    const operation = Object.freeze({
        point: Object.freeze({
            pointId: identity.point.pointId,
            protocol: Object.freeze({
                id: identity.point.protocol.id,
                version: identity.point.protocol.version,
            }),
        }),
        contributor: Object.freeze({
            pluginId: identity.contributor.pluginId,
            contributionId: identity.contributor.contributionId,
            immutableGenerationId: identity.contributor.immutableGenerationId,
        }),
        role: identity.role,
        action: Object.freeze({
            pluginId: params.action.pluginId,
            localId: params.action.localId,
        }),
    }) satisfies PluginUiTargetedContributionOperationV1;
    const handle = Object.freeze({ identity }) as AdmittedTargetedOperationExecutionHandle<
        TInput,
        TResult,
        TRole
    >;
    admittedTargetedOperationExecutionBindings.set(
        handle,
        Object.freeze({
            action: Object.freeze({
                pluginId: params.action.pluginId,
                localId: params.action.localId,
            }),
            contributorImmutableGenerationId: identity.contributor.immutableGenerationId,
            operation,
            targetPluginId: identity.target.pluginId,
            targetImmutableGenerationId: params.targetImmutableGenerationId,
            selectedActionInput: freezeSelectedActionInput(params.selectedActionInput),
            targetProtocol: params.targetProtocol,
        }),
    );
    return handle;
}

function readAdmittedTargetedOperationExecutionBinding(
    operation: unknown,
): AdmittedTargetedOperationExecutionBinding | null {
    if (operation === null || typeof operation !== 'object') return null;
    return admittedTargetedOperationExecutionBindings.get(operation) ?? null;
}

/**
 * An opaque operation belongs to the exact target generation that admitted it.
 * The public identity deliberately omits that private fact, so a replacement
 * target cannot recover an old capability from the original object.
 */
function requireAdmittedTargetedOperationExecutionBinding(
    operation: unknown,
    seed: PluginActionsServiceSeed,
): AdmittedTargetedOperationExecutionBinding {
    const binding = readAdmittedTargetedOperationExecutionBinding(operation);
    if (binding === null || binding.targetPluginId !== seed.plugin.id) {
        throw invalidAdmittedTargetedOperationHandle();
    }
    if (binding.targetImmutableGenerationId !== seed.immutableGenerationId) {
        throw actionHandlerNotStartedError({
            code: 'plugin_action_generation_retired',
            message: 'Admitted targeted operation target generation is no longer current',
        });
    }
    return binding;
}

function invalidAdmittedTargetedOperationHandle(): PluginError {
    return actionHandlerNotStartedError({
        code: 'plugin_admitted_targeted_operation_handle_invalid',
        message: 'Admitted targeted operation handle is invalid',
    });
}

function actionHandlerNotStartedError(input: Readonly<{
    code: string;
    message: string;
    details?: JsonValue;
}>): PluginError {
    return new PluginError({
        ...input,
        actionHandlerInvocation: 'notStarted',
    });
}

function composeActionSignal(retirementSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
    if (!callerSignal || callerSignal === retirementSignal) return retirementSignal;
    return AbortSignal.any([retirementSignal, callerSignal]);
}

function readExpectedExecutionOrigin(expectedExecutionOrigin: unknown): PluginMachineExecutionOriginV1 | undefined {
    if (expectedExecutionOrigin === undefined) return undefined;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse(expectedExecutionOrigin);
    if (!parsed.success) {
        throw actionHandlerNotStartedError({
            code: 'plugin_action_execution_origin_invalid',
            message: 'Expected target execution origin is invalid',
        });
    }
    return Object.freeze({
        serverIdentityId: parsed.data.serverIdentityId,
        materializationRef: Object.freeze({ ...parsed.data.materializationRef }),
    });
}

function throwIfInactive(
    seed: PluginActionsServiceSeed,
    signal: AbortSignal,
    details?: JsonValue,
    beforeActionHandler = false,
): void {
    if (!seed.isGenerationCurrent() || seed.signal.aborted) {
        throw new PluginError({
            code: 'plugin_action_generation_retired',
            message: 'Plugin generation retired before the action result could be admitted',
            ...(details === undefined ? {} : { details }),
            ...(beforeActionHandler ? { actionHandlerInvocation: 'notStarted' as const } : {}),
        });
    }
    if (signal.aborted) {
        throw new PluginError({
            code: 'plugin_action_aborted',
            message: 'Plugin action invocation was aborted',
            ...(details === undefined ? {} : { details }),
            ...(beforeActionHandler ? { actionHandlerInvocation: 'notStarted' as const } : {}),
        });
    }
}

function selectedActionInputInvalid(): PluginError {
    return actionHandlerNotStartedError({
        code: 'plugin_selected_action_input_invalid',
        message: 'Selected Action input does not match the admitted operation',
    });
}

function selectedActionInputUnavailable(): PluginError {
    return actionHandlerNotStartedError({
        code: 'plugin_selected_action_input_unavailable',
        message: 'Selected Action input is unavailable for the admitted operation',
    });
}

function mountedCallerUnavailable(): PluginError {
    return actionHandlerNotStartedError({
        code: 'plugin_mounted_caller_unavailable',
        message: 'Mounted plugin caller is no longer current',
    });
}

/**
 * The admitted-operation handle is the sole daemon consumer of a selected UI
 * settlement. It compares every carried identity to host-private admission,
 * then reconstructs at the last point before the provider Action receives
 * input. The carrier itself is deliberately neither a capability nor storage.
 */
async function resolveAdmittedTargetedOperationInput(params: Readonly<{
    seed: PluginActionsServiceSeed;
    binding: AdmittedTargetedOperationExecutionBinding;
    input: JsonValue;
    expectedSelectedConnectedAccountRef: QualifiedConnectedAccountRef | null | undefined;
    /** One outer UI invocation may reconstruct its selected settlement once. */
    selectedActionInputClaimed: { current: boolean };
    signal: AbortSignal;
}>): Promise<JsonValue> {
    // Ordinary (zero-carrier) callers retain their existing pass-through
    // behavior. A carrier does not turn unrelated admitted operations (such
    // as Channels' connectionTest after setup) into selected-account calls.
    if (params.seed.selectedActionInputCarrier === undefined) return params.input;
    const parsedCarrier = PluginUiSelectedActionInputCarrierV1Schema.safeParse(
        params.seed.selectedActionInputCarrier,
    );
    if (!parsedCarrier.success) {
        throw selectedActionInputUnavailable();
    }
    const carrier = parsedCarrier.data;
    const carrierMatchesBinding = pluginUiTargetedContributionOperationKey(carrier.operation)
        === pluginUiTargetedContributionOperationKey(params.binding.operation);
    if (!carrierMatchesBinding) {
        // Supplying an outer selected-account fact to any other handle is a
        // confused-deputy attempt, never a request to run it ordinarily.
        if (params.expectedSelectedConnectedAccountRef !== undefined) {
            throw selectedActionInputInvalid();
        }
        return params.input;
    }
    // Claim before the first currentness await. The carrier is a one-shot
    // settlement inside this outer invocation, so concurrent setup calls can
    // never both reach provider I/O. A failed validation/currentness read also
    // keeps this claim consumed, preventing a credential replay after failure.
    if (params.selectedActionInputClaimed.current) throw selectedActionInputInvalid();
    params.selectedActionInputClaimed.current = true;
    if (params.expectedSelectedConnectedAccountRef === undefined) {
        throw selectedActionInputInvalid();
    }
    if (params.binding.selectedActionInput.kind === 'unavailable') {
        throw selectedActionInputUnavailable();
    }
    if (!params.seed.immutableGenerationId || !params.seed.isMountedCallerCurrent) {
        throw selectedActionInputUnavailable();
    }
    if (
        !pluginUiSelectedActionInputMatchesOperation(carrier.result, carrier.operation)
        || carrier.result.selection.target.pluginId !== params.binding.targetPluginId
        || carrier.result.selection.target.pluginId !== params.seed.plugin.id
        || carrier.result.selection.target.immutableGenerationId !== params.seed.immutableGenerationId
    ) {
        throw selectedActionInputInvalid();
    }
    throwIfInactive(params.seed, params.signal, undefined, true);
    let mountedCallerCurrent = false;
    try {
        mountedCallerCurrent = await params.seed.isMountedCallerCurrent();
    } catch {
        // Current mounted-caller evidence is external to this service. A
        // failed re-read cannot authorize disclosure to a provider Action.
    }
    throwIfInactive(params.seed, params.signal, undefined, true);
    if (!mountedCallerCurrent) throw mountedCallerUnavailable();
    if (!pluginJsonValuesEqual(params.input, carrier.result.input)) {
        throw selectedActionInputInvalid();
    }

    const expectedRef = params.expectedSelectedConnectedAccountRef;
    const selected = params.binding.selectedActionInput;
    if (selected.kind === 'none') {
        if (expectedRef !== null || carrier.result.connectedAccount.kind !== 'none') {
            throw selectedActionInputInvalid();
        }
    } else if (
        expectedRef === null
        || carrier.result.connectedAccount.kind !== 'selected'
        || carrier.result.connectedAccount.fieldPath !== selected.fieldPath
        || !pluginJsonValuesEqual(expectedRef, carrier.result.connectedAccount.ref)
    ) {
        throw selectedActionInputInvalid();
    }
    const reconstructed = reconstructPluginUiSelectedActionInput(carrier.result);
    const parsedInput = reconstructed === null
        ? null
        : StrictJsonValueSchema.safeParse(reconstructed);
    if (!parsedInput || !parsedInput.success) throw selectedActionInputInvalid();
    return parsedInput.data;
}

function hasCurrentContributedActionCaller(
    seed: PluginActionsServiceSeed,
    caller: ActionPluginCaller,
): boolean {
    const currentCaller = resolvePluginActionCaller(seed);
    const currentMaterialization = currentCaller?.materialization;
    const callerMaterialization = caller.materialization;
    return currentCaller !== null
        && currentMaterialization !== undefined
        && callerMaterialization !== undefined
        && currentMaterialization.pluginId === callerMaterialization.pluginId
        && currentMaterialization.machineId === callerMaterialization.machineId
        && currentMaterialization.materializationId === callerMaterialization.materializationId
        && currentCaller.immutableGenerationId === caller.immutableGenerationId;
}

function throwIfContributedActionCallerInactive(
    seed: PluginActionsServiceSeed,
    signal: AbortSignal,
    caller: ActionPluginCaller,
): void {
    throwIfInactive(seed, signal);
    if (!hasCurrentContributedActionCaller(seed, caller)) {
        throw new PluginError({
            code: 'plugin_action_caller_unavailable',
            message: 'Plugin contributed action caller materialization is no longer current',
        });
    }
}

function bindingContext(
    seed: PluginActionsServiceSeed,
    actionId: ActionId,
    signal: AbortSignal,
    caller: ActionPluginCaller,
    input?: unknown,
): ActionSurfaceBindingContext {
    return {
        actionId,
        surface: 'plugin',
        caller,
        ...(seed.session ? { defaultSessionId: seed.session.id } : {}),
        signal,
        ...(input === undefined ? {} : { input }),
    };
}

function resolveContributedActionCaller(
    seed: PluginActionsServiceSeed,
    caller: ActionPluginCaller,
): Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>> | null {
    if (!seed.contribution || !caller.materialization) return null;
    const originSurface = seed.surface === 'plugin'
        && seed.caller?.kind === 'plugin'
        ? seed.caller.originSurface
        : seed.surface === 'plugin'
            ? undefined
            : seed.surface;
    return Object.freeze({
        kind: 'plugin' as const,
        pluginId: seed.plugin.id,
        contribution: seed.contribution,
        materialization: caller.materialization,
        ...(originSurface ? { originSurface } : {}),
    });
}

function executorFailure(
    actionId: ActionId,
    result: Extract<ActionExecuteResult, { ok: false }>,
): PluginError {
    const normalizedDetails = actionId === 'execution.run.start'
        ? withExecutionRunStartFailureDetails(
            undefined,
            readExecutionRunStartRunCreation(result.details),
        )
        : undefined;
    const details = normalizedDetails === undefined
        ? undefined
        : StrictJsonValueSchema.safeParse(normalizedDetails);
    const error = new PluginError({
        code: result.errorCode,
        message: result.error,
        ...(details?.success ? { details: details.data } : {}),
    });
    if (actionId !== 'execution.run.start') {
        Reflect.deleteProperty(error, 'details');
    }
    return error;
}

/**
 * Rebuilds the target's canonical PluginError for its plugin caller. Plugins
 * are trusted code, so the author's `retryable` signal and published contract
 * payload cross the call instead of collapsing into a bare code. The
 * transported value is data: no class identity, prototype, or `cause` chain is
 * reconstructed, and the canonical Protocol reader owns the author vocabulary
 * so the daemon host and the SDK test host cannot disagree about it.
 */
function contributedActionFailureError(
    result: Extract<ContributedActionInvocationResult, { status: 'failed' | 'unavailable' | 'invalid' }>,
): PluginError {
    const payload = readPluginActionFailureAuthorPayload(result.data);
    return new PluginError({
        code: result.code,
        message: result.message,
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...payload,
        ...(result.actionHandlerInvocation === undefined
            ? {}
            : { actionHandlerInvocation: result.actionHandlerInvocation }),
    });
}

export function createPluginInvocationActionsService(params: Readonly<{
    seed: PluginActionsServiceSeed;
    actionExecutor: PluginActionsHostExecutor;
    invokeContributedAction: InvokeContributedAction;
}>): ActionsService {
    let actionInvocationSequence = 0;
    // This is invocation-local transit state, not a registry or durable
    // receipt. A fresh outer Action invocation receives a fresh service seed.
    const selectedActionInputClaimed = { current: false };
    const actionExecutor = params.actionExecutor.bindInvocation?.(params.seed.signal)
        ?? params.actionExecutor;
    const executeContributed = async (
        action: PluginContributionRef,
        input: JsonValue,
        options: PluginCancellationOptions | undefined,
        captureExecutionOrigin: boolean,
        expectedExecutionOrigin?: unknown,
        admittedTargetedOperation?: AdmittedTargetedOperationExecutionBinding,
    ): Promise<Extract<ContributedActionInvocationResult, { status: 'executed' }>> => {
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        throwIfInactive(params.seed, signal, undefined, true);
        const parsedExpectedExecutionOrigin = readExpectedExecutionOrigin(expectedExecutionOrigin);
        const actionCaller = resolvePluginActionCaller(params.seed);
        if (!actionCaller) {
            throw actionHandlerNotStartedError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin Action calls require current host-stamped caller provenance',
            });
        }
        const caller = resolveContributedActionCaller(params.seed, actionCaller);
        if (!caller) {
            throw actionHandlerNotStartedError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin contributed action calls require host-stamped caller provenance',
            });
        }
        const result = await params.invokeContributedAction({
            action,
            input,
            surface: 'plugin',
            ...(caller.originSurface ? { originSurface: caller.originSurface } : {}),
            caller,
            ...(captureExecutionOrigin ? { captureExecutionOrigin: true as const } : {}),
            ...(parsedExpectedExecutionOrigin === undefined
                ? {}
                : { expectedExecutionOrigin: parsedExpectedExecutionOrigin }),
            ...(admittedTargetedOperation === undefined
                ? {}
                : {
                    admittedTargetedOperation: Object.freeze({
                        action: Object.freeze({ ...admittedTargetedOperation.action }),
                        target: Object.freeze({
                            pluginId: admittedTargetedOperation.targetPluginId,
                            immutableGenerationId: admittedTargetedOperation.targetImmutableGenerationId,
                        }),
                        contributorImmutableGenerationId: admittedTargetedOperation.contributorImmutableGenerationId,
                        targetProtocol: admittedTargetedOperation.targetProtocol,
                    }),
                }),
            ...(params.seed.session ? { sessionId: params.seed.session.id } : {}),
            signal,
        });
        throwIfContributedActionCallerInactive(params.seed, signal, actionCaller);
        if (result.status !== 'executed') {
            throw contributedActionFailureError(result);
        }
        return result;
    };

    const executeAdmittedTargetedOperation = async <
        TInput extends JsonValue,
        TResult extends JsonValue | void,
    >(
        operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
        input: NoInfer<TInput>,
        options?: AdmittedTargetedOperationExecutionOptions,
    ): Promise<TResult> => {
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, params.seed);
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        const admittedInput = await resolveAdmittedTargetedOperationInput({
            seed: params.seed,
            binding,
            input,
            expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed,
            signal,
        });
        const result = await executeContributed(
            binding.action,
            admittedInput,
            options,
            false,
            undefined,
            binding,
        );
        return result.value as TResult;
    };
    const execute = async (
        actionOrRef: PluginInvocableActionId | PluginContributionRef,
        input: unknown,
        options?: PluginCancellationOptions,
    ): Promise<unknown> => {
        if (typeof actionOrRef !== 'string') {
            const result = await executeContributed(
                actionOrRef,
                input as JsonValue,
                options,
                false,
            );
            return result.value;
        }
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        const isExecutionRunStart = actionOrRef === 'execution.run.start';
        const beforeStartDetails = isExecutionRunStart
            ? withExecutionRunStartFailureDetails(undefined, 'noRunCreated')
            : undefined;
        throwIfInactive(
            params.seed,
            signal,
            beforeStartDetails,
        );
        const actionCaller = resolvePluginActionCaller(params.seed);
        if (!actionCaller) {
            throw new PluginError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin Action calls require current host-stamped caller provenance',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }

        const parsedActionId = ActionIdSchema.safeParse(actionOrRef);
        if (!parsedActionId.success) {
            throw new PluginError({
                code: 'plugin_action_unknown',
                message: 'Plugin action id is not part of the canonical Action registry',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }
        const actionId = parsedActionId.data;
        const spec = getActionSpec(actionId);
        if (spec.surfaces.plugin !== true) {
            throw new PluginError({
                code: 'plugin_action_not_available',
                message: 'Action is not available to plugin callers',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }
        const pluginInputSchema = spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema;
        const parsedPluginInput = pluginInputSchema.safeParse(input);
        if (!parsedPluginInput.success) {
            throw new PluginError({
                code: 'plugin_action_input_schema_invalid',
                message: 'Plugin action input does not match its caller schema',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }
        const surfaceContext = bindingContext(
            params.seed,
            actionId,
            signal,
            actionCaller,
            parsedPluginInput.data,
        );
        throwIfInactive(params.seed, signal);
        actionInvocationSequence += 1;
        const actionRequestId = params.seed.correlationId
            ? `${params.seed.correlationId}:${actionId}:${actionInvocationSequence}`
            : undefined;
        const result = await actionExecutor.execute(actionId, parsedPluginInput.data, {
            ...(params.seed.session ? { defaultSessionId: params.seed.session.id } : {}),
            surface: 'plugin',
            actionCaller,
            signal,
            ...(actionRequestId ? { actionRequestId } : {}),
            ...(params.seed.bypassActionInterception === true
                ? { bypassActionInterception: true }
                : {}),
        });
        const inactiveStartDetails = actionId === 'execution.run.start'
            ? withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown')
            : undefined;
        throwIfInactive(params.seed, signal, inactiveStartDetails);
        if (!result.ok) throw executorFailure(actionId, result);

        let projectedResult = result.result;
        if (spec.surfaceBindings?.plugin?.projectOutput) {
            try {
                projectedResult = await spec.surfaceBindings.plugin.projectOutput(result.result, surfaceContext);
            } catch {
                throw new PluginError({
                    code: 'plugin_action_result_projection_failed',
                    message: 'Plugin action result could not be projected for the caller',
                    ...(inactiveStartDetails ? { details: inactiveStartDetails } : {}),
                });
            }
        }
        const outputSchema = spec.surfaceBindings?.plugin?.outputSchema ?? spec.outputSchema;
        const parsedResult = outputSchema?.safeParse(projectedResult);
        if (!parsedResult?.success) {
            throw new PluginError({
                code: 'plugin_action_result_schema_invalid',
                message: 'Plugin action result does not match its canonical output schema',
                ...(inactiveStartDetails ? { details: inactiveStartDetails } : {}),
            });
        }
        return parsedResult.data;
    };

    const executeWithExecutionOrigin = async (
        action: PluginContributionRef,
        input: JsonValue,
        options?: ContributedActionExecutionWithOriginOptions,
    ): Promise<ContributedActionExecutionWithOriginResult> => {
        const result = await executeContributed(
            action,
            input,
            options,
            true,
            options?.expectedExecutionOrigin,
        );
        if (!result.executionOrigin) {
            throw new PluginError({
                code: 'plugin_action_execution_origin_unavailable',
                message: 'Current target execution origin is unavailable',
            });
        }
        return Object.freeze({
            result: result.value,
            executionOrigin: result.executionOrigin,
        });
    };

    const executeAdmittedTargetedOperationWithExecutionOrigin = async <
        TInput extends JsonValue,
        TResult extends JsonValue | void,
    >(
        operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
        input: NoInfer<TInput>,
        options?: AdmittedTargetedOperationExecutionWithOriginOptions,
    ): Promise<Readonly<{
        result: TResult;
        executionOrigin: PluginMachineExecutionOriginV1;
    }>> => {
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, params.seed);
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        const admittedInput = await resolveAdmittedTargetedOperationInput({
            seed: params.seed,
            binding,
            input,
            expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed,
            signal,
        });
        const result = await executeContributed(
            binding.action,
            admittedInput,
            options,
            true,
            options?.expectedExecutionOrigin,
            binding,
        );
        if (!result.executionOrigin) {
            throw new PluginError({
                code: 'plugin_action_execution_origin_unavailable',
                message: 'Current target execution origin is unavailable',
            });
        }
        return Object.freeze({
            result: result.value as TResult,
            executionOrigin: result.executionOrigin,
        });
    };

    return Object.freeze({
        execute,
        executeAdmittedTargetedOperation,
        executeWithExecutionOrigin,
        executeAdmittedTargetedOperationWithExecutionOrigin,
    }) as ActionsService;
}
