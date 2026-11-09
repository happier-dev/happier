import {
    PluginError,
    type JsonValue,
    type PluginInvocationCaller,
    type PluginInvocationContributionIdentity,
    type PluginInvocationOriginSurface,
} from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type {
    AdmittedTargetedOperationExecutionOptions,
    AdmittedTargetedOperationExecutionWithOriginOptions,
    AdmittedTargetedOperationExecutionHandle,
    ActionsService,
    ActionExecutionOptions,
    ContributedActionExecutionWithOriginOptions,
    ContributedActionExecutionWithOriginResult,
    PluginActionHandlerInvocation,
    PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import type {
    PluginCancellationOptions,
    PluginContributionRef } from '@happier-dev/plugin-sdk';
import type {
    PluginInvocationSurface,
} from '@happier-dev/plugin-sdk/interactions';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ActionPluginCaller, ActionCaller, ActionId } from '@happier-dev/protocol/actions';
import { arePluginMachineMaterializationRefsEqual, getPluginMachineExecutionRouting, PluginMachineExecutionOriginV1Schema, PluginMachineExecutionRoutingV1Schema, type PluginMachineExecutionRoutingV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { QualifiedConnectedAccountRef, PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { PluginUiSelectedActionInputCarrierV1, PluginUiTargetedContributionOperationV1 } from '@happier-dev/protocol/plugins/ui';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionSurfaceBindingContext } from '@happier-dev/protocol/actions/actionSpecs';
import type { AdmittedTargetedOperationExecutionRequest } from '../actions/executeContributedAction';
import { resolvePluginActionCaller, resolvePluginInvocationCallerExecutionOrigin } from './actionCaller';
import type { AgentInvocationTurnAdmissionWitness, PluginExternalActionContext, PluginInvocationServicesSeed } from './types';
import { runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { observeContributedActionRead } from './resourceActions';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { validateActionSessionAddressV1 } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

export type PluginActionsServiceSeed = Readonly<{
    requesterAccount?: PluginInvocationServicesSeed['requesterAccount'];
    readApprovalProfileId?: PluginInvocationServicesSeed['readApprovalProfileId'];
    workflowActionContext?: import('./types').WorkflowAgentActionContext;
    sessionListAccess?: ActionExecutorContext['sessionListAccess'];
    plugin: Readonly<{ id: string; version: string }>;
    /** The host-stamped immediate contribution that owns this invocation. */
    contribution?: PluginInvocationContributionIdentity;
    /** Exact process-local occurrence, projected only from host runtime ownership. */
    occurrenceId: string;
    /** Durable source custody, projected only from host runtime ownership. */
    sourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1;
    correlationId?: string;
    surface: PluginInvocationSurface;
    /** Host-stamped provenance from the invocation that created this service. */
    caller?: PluginInvocationCaller;
    /** Host-private original admission provenance, separate from immediate plugin authority. */
    initiatingActionCaller?: ActionCaller;
    startedBy?: ActionPluginCaller['startedBy'];
    /** Host-private external PAT authority; never projected into plugin input. */
    externalActionContext?: PluginExternalActionContext;
    /** Original admitted source, kept separate from this immediate plugin caller. */
    approvalContext?: ActionExecutorContext;
    /** Captured by the admitted containing Action's service owner. */
    resolveAccountSourceMachine?: PluginInvocationServicesSeed['resolveAccountSourceMachine'];
    /** The canonical admitted parent, projected once by the target invocation owner. */
    reviewedParent?: import('@happier-dev/protocol/actions/actionExecutor').HostReviewedParentV1;
    /** Host-only finite invocation cause; never a fallback for an active-turn reader. */
    actionRequestAttributionV1?: ActionExecutorContext['actionRequestAttributionV1'];
    /** Host-private lookup of this invocation's current plugin materialization. */
    resolveCurrentPluginMaterializationRef?(): import('@happier-dev/protocol').PluginMachineMaterializationRefV1 | null;
    resolveCurrentPluginExecutionOrigin?(signal?: AbortSignal): Promise<PluginMachineExecutionOriginV1 | null>;
    /** Untrusted, transient settlement forwarded from one mounted UI caller. */
    selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
    /** Re-read the originating mounted UI caller immediately before provider effect. */
    isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    /** Host-only current declaration reader for an opaque targeted operation. */
    readCurrentTargetedDeclarations?(signal?: AbortSignal): Promise<readonly import('@happier-dev/cli-common/plugins/registration').TargetedContributionManifestDeclaration[]>;
    session?: Readonly<{ id: string }>;
    /** Host-private active-turn authority for Agent-placed Action execution. */
    readActiveTurnAdmissionWitness?(): import('./types').AgentInvocationTurnAdmissionWitness | null;
    signal: AbortSignal;
    /** Host-only authority withdrawal of the enclosing observed read. */
    retireReadObservation?(): void;
    isOccurrenceCurrent(): boolean;
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
    bindInvocation?(signal: AbortSignal, approvalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime']): PluginActionsHostExecutor;
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

/** Decode the public PluginError envelope at the generic Action/SDK boundary. */
export function projectContributedActionExecuteResult(result: ActionExecuteResult): ContributedActionInvocationResult {
    if (result.ok) return { status: 'executed', value: StrictJsonValueSchema.parse(result.result) };
    const projected = StrictJsonValueSchema.safeParse(result.details);
    const data = projected.success ? projected.data : null;
    const record = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const pluginFailure = record?.name === 'PluginError' && record.code === result.errorCode
        && (record.message ?? record.code) === result.error ? record : null;
    return { status: 'failed', code: result.errorCode, message: result.error,
        ...(pluginFailure ? { data: pluginFailure,
            ...(typeof pluginFailure.retryable === 'boolean' ? { retryable: pluginFailure.retryable } : {}),
            ...(pluginFailure.actionHandlerInvocation === 'notStarted' ? { actionHandlerInvocation: 'notStarted' as const } : {}),
        } : {}) };
}

export type InvokeContributedAction = (params: Readonly<{
    expectedContributorOccurrenceId?: string;
    action: PluginContributionRef;
    /** `action.invoke` accepts omitted input; target validation retains that distinction. */
    input: JsonValue | undefined;
    /** Host-only constrained nested source read; not a public service option. */
    requiredDangerLevel?: 'safe';
    requiredReadOnly?: true;
    resourceSessionId?: string;
    readObservation?: Readonly<{ invalidate(): void; retire?(): void; accept(subscription: import('@happier-dev/plugin-sdk').Disposable): void }>;
    /** A plugin-to-plugin invocation is always authorized on the target plugin surface. */
    surface: 'plugin';
    /** Diagnostic origin, deliberately separate from the target authorization surface. */
    originSurface?: PluginInvocationOriginSurface;
    /** Host-stamped immediate caller; plugin input never supplies this value. */
    caller: Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
    initiatingActionCaller?: ActionCaller;
    /** Host-private original source context; never authored by the nested plugin. */
    approvalContext?: ActionExecutorContext;
    resolveAccountSourceMachine?: PluginInvocationServicesSeed['resolveAccountSourceMachine'];
    /** Account custody retained from the admitted containing Session. */
    requesterAccount?: PluginInvocationServicesSeed['requesterAccount'];
    /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
    captureExecutionOrigin?: true;
    /** Equality-only precondition from ActionsService.executeWithExecutionOrigin only. */
    expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
    expectedExecutionRouting?: PluginMachineExecutionRoutingV1;
    /** Opaque target-operation evidence from one original admitted-operation handle. */
    admittedTargetedOperation?: AdmittedTargetedOperationExecutionRequest;
    /** Host-private original-handle fence, run by the final handler owner. */
    beforeHandlerInvocation?(): Promise<void>;
    sessionId?: string;
    signal: AbortSignal;
}>) => Promise<ContributedActionInvocationResult>;

export { createAdmittedTargetedOperationExecutionHandle } from '@happier-dev/cli-common/plugins/registration';
import { requireAdmittedTargetedOperationExecutionBinding, resolveAdmittedTargetedOperationInput, type AdmittedTargetedOperationExecutionBinding } from '@happier-dev/cli-common/plugins/registration';

function composeActionSignal(retirementSignal: AbortSignal, ...callerSignals: readonly (AbortSignal | undefined)[]): AbortSignal {
    const signals = [retirementSignal];
    for (const signal of callerSignals) {
        if (signal && !signals.includes(signal)) signals.push(signal);
    }
    return signals.length === 1 ? retirementSignal : AbortSignal.any(signals);
}

function readExpectedExecutionRouting(value: unknown): PluginMachineExecutionRoutingV1 | undefined {
    if (value === undefined) return undefined;
    const parsed = PluginMachineExecutionRoutingV1Schema.safeParse(value);
    if (!parsed.success) {
        throw createPluginActionHandlerNotStartedError({
            code: 'plugin_action_execution_origin_invalid',
            message: 'Expected target execution routing is invalid',
        });
    }
    return Object.freeze(parsed.data);
}

function readExpectedExecutionOrigin(expectedExecutionOrigin: unknown): PluginMachineExecutionOriginV1 | undefined {
    if (expectedExecutionOrigin === undefined) return undefined;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse(expectedExecutionOrigin);
    if (!parsed.success) {
        throw createPluginActionHandlerNotStartedError({
            code: 'plugin_action_execution_origin_invalid',
            message: 'Expected target execution origin is invalid',
        });
    }
    return Object.freeze({
        serverIdentityId: parsed.data.serverIdentityId,
        ...('materializationRef' in parsed.data
            ? { materializationRef: Object.freeze({ ...parsed.data.materializationRef }) }
            : { sourceRef: Object.freeze({ ...parsed.data.sourceRef, sourceCustody: Object.freeze({ ...parsed.data.sourceRef.sourceCustody }) }) }),
    });
}

function throwIfInactive(
    seed: PluginActionsServiceSeed,
    signal: AbortSignal,
    details?: JsonValue,
    beforeActionHandler = false,
): void {
    if (!seed.isOccurrenceCurrent() || seed.signal.aborted) {
        const error = {
            code: 'plugin_action_generation_retired',
            message: 'Plugin occurrenceId retired before the action result could be admitted',
            ...(details === undefined ? {} : { details }),
        };
        throw beforeActionHandler ? createPluginActionHandlerNotStartedError(error) : new PluginError(error);
    }
    if (signal.aborted) {
        const error = {
            code: 'plugin_action_aborted',
            message: 'Plugin action invocation was aborted',
            ...(details === undefined ? {} : { details }),
        };
        throw beforeActionHandler ? createPluginActionHandlerNotStartedError(error) : new PluginError(error);
    }
}

function hasCurrentContributedActionCaller(
    seed: PluginActionsServiceSeed,
    caller: ActionPluginCaller,
): boolean {
    const currentCaller = resolvePluginActionCaller(seed);
    const currentMaterialization = currentCaller?.materialization;
    const callerMaterialization = caller.materialization;
    return currentCaller !== null
        && currentCaller.occurrenceId === caller.occurrenceId
        && (currentMaterialization === undefined
            ? callerMaterialization === undefined
            : callerMaterialization !== undefined
                && arePluginMachineMaterializationRefsEqual(currentMaterialization, callerMaterialization));
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

async function resolveContributedActionCaller(
    seed: PluginActionsServiceSeed,
    caller: ActionPluginCaller,
): Promise<Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>> | null> {
    if (
        !seed.contribution
        || !caller.occurrenceId
        || !caller.sourceCustody
    ) return null;
    const executionOrigin = await resolvePluginInvocationCallerExecutionOrigin(caller, seed.resolveCurrentPluginExecutionOrigin, seed.signal);
    if (executionOrigin === null) return null;
    const originSurface = caller.originSurface;
    return Object.freeze({
        kind: 'plugin' as const,
        pluginId: seed.plugin.id,
        contribution: seed.contribution,
        occurrenceId: caller.occurrenceId,
        sourceCustody: caller.sourceCustody,
        ...(executionOrigin === undefined ? {} : { executionOrigin }),
        ...(caller.materialization === undefined
            ? {}
            : { materialization: caller.materialization }),
        ...(originSurface ? { originSurface } : {}),
    });
}

function resolveInvocationActionCaller(
    seed: PluginActionsServiceSeed,
    agentWitness: AgentInvocationTurnAdmissionWitness | null,
) {
    return resolvePluginActionCaller({ ...seed,
        ...(seed.initiatingActionCaller === undefined && agentWitness?.agentStartCaller
            ? { initiatingActionCaller: agentWitness.agentStartCaller }
            : {}),
    });
}

function executorFailure(
    actionId: ActionId,
    result: Extract<ActionExecuteResult, { ok: false }>,
): PluginError {
    const normalizedDetails = actionId === 'execution.run.start'
        ? withExecutionRunStartFailureDetails(
            result.details,
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
    const error = {
        code: result.code,
        message: result.message,
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...payload,
    };
    return result.actionHandlerInvocation === 'notStarted'
            ? createPluginActionHandlerNotStartedError(error)
        : new PluginError(error);
}

export function createPluginInvocationActionsService(params: Readonly<{
    seed: PluginActionsServiceSeed;
    actionExecutor: PluginActionsHostExecutor;
    invokeContributedAction: InvokeContributedAction;
}>): ActionsService {
    // A contributed Action keeps its initiating surface as provenance; it is
    // plugin code, not an Agent runtime bound to that surface's current Session.
    // Use only the host-stamped canonical identity, never absence of a turn reader:
    // finite and retired Agents must retain their Agent authority restrictions.
    const contribution = parseQualifiedPluginActionId(params.seed.contribution?.qualifiedId);
    const isActionContribution = contribution !== null
        && contribution.pluginId === params.seed.plugin.id
        && contribution.localId === params.seed.contribution?.id;
    const executionSurface = params.seed.surface === 'agent' && !isActionContribution ? 'agent' : 'plugin';
    const readAgentWitness = () => executionSurface === 'agent'
        ? params.seed.readActiveTurnAdmissionWitness?.() ?? null
        : null;
    let actionInvocationSequence = 0;
    // This is invocation-local transit state, not a registry or durable
    // receipt. A fresh outer Action invocation receives a fresh service seed.
    const selectedActionInputClaimed = { current: false };
    const actionExecutor = params.actionExecutor.bindInvocation?.(params.seed.signal)
        ?? params.actionExecutor;
    const workflowActionContext = params.seed.workflowActionContext;
    const readWorkflowRunId = () => workflowActionContext?.readRunId()
        ?? params.seed.approvalContext?.executionRunWorkflowRunId;
    const readApprovalContext = (): ActionExecutorContext | undefined => {
        const executionRunWorkflowRunId = readWorkflowRunId();
        const approvalProfileId = params.seed.readApprovalProfileId
            ? params.seed.readApprovalProfileId() : params.seed.approvalContext?.approvalProfileId;
        return executionRunWorkflowRunId || approvalProfileId !== undefined
            ? { ...params.seed.approvalContext,
                ...(executionRunWorkflowRunId ? { executionRunWorkflowRunId } : {}),
                ...(approvalProfileId !== undefined ? { approvalProfileId } : {}) }
            : params.seed.approvalContext;
    };
    const failWorkflowApproval = (error: PluginError): PluginError => {
        if (error.code === 'approval_requester_unavailable' && !params.seed.session && readWorkflowRunId()) {
            workflowActionContext?.fail(error);
        }
        return error;
    };
    const invokeContributedActionWithCaller = async (
        target: AdmittedTargetedOperationExecutionBinding | PluginContributionRef,
        input: JsonValue,
        options: PluginCancellationOptions | undefined,
        originalOperation: unknown,
        captureExecutionOrigin: boolean,
        expectedExecutionOrigin?: unknown,
        expectedExecutionRouting?: unknown,
        readObservation?: Parameters<InvokeContributedAction>[0]['readObservation'],
    ): Promise<Extract<ContributedActionInvocationResult, { status: 'executed' }>> => {
        const admittedTargetedOperation = 'action' in target ? target : undefined;
        const action = 'action' in target ? target.action : target;
        const agentWitness = readAgentWitness();
        const signal = composeActionSignal(params.seed.signal, options?.signal, agentWitness?.signal,
            params.seed.approvalContext?.nativeRealtimeInput ? params.seed.approvalContext.signal : undefined);
        throwIfInactive(params.seed, signal, undefined, true);
        const parsedExpectedExecutionOrigin = readExpectedExecutionOrigin(expectedExecutionOrigin);
        const parsedExpectedExecutionRouting = readExpectedExecutionRouting(expectedExecutionRouting);
        const actionCaller = resolveInvocationActionCaller(params.seed, agentWitness);
        if (!actionCaller) {
            throw createPluginActionHandlerNotStartedError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin Action calls require current host-stamped caller provenance',
            });
        }
        const caller = await resolveContributedActionCaller(params.seed, actionCaller);
        if (!caller) {
            throw createPluginActionHandlerNotStartedError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin contributed action calls require host-stamped caller provenance',
            });
        }
        throwIfContributedActionCallerInactive(params.seed, signal, actionCaller);
        // A new contributed child owns its target expectation and confirmation.
        // The reviewedParent issuer below supplies any exact reviewed-child authority.
        const inherited = readApprovalContext();
        const originalApprovalContext = inherited ? { ...inherited, presentUserConfirmation: undefined,
            presentUserApproval: undefined, expectedContributedActionOccurrenceId: undefined } : undefined;
        const approvalContext = agentWitness?.nativeRealtimeAdmission
            ? { ...originalApprovalContext, nativeRealtimeInput: true as const, signal }
            : originalApprovalContext;
        const invoke = (invocationInput: JsonValue | undefined,
            invocationContext: ActionExecutorContext | undefined, invokedAction: PluginContributionRef) => params.invokeContributedAction({
            action: invokedAction,
            input: invocationInput,
            surface: 'plugin',
            ...(readObservation ? { requiredReadOnly: true as const, readObservation } : {}),
            ...(caller.originSurface ? { originSurface: caller.originSurface } : {}),
            caller,
            initiatingActionCaller: actionCaller,
            ...(invocationContext ? { approvalContext: invocationContext } : {}),
            ...(params.seed.resolveAccountSourceMachine ? { resolveAccountSourceMachine: params.seed.resolveAccountSourceMachine } : {}),
            ...(captureExecutionOrigin ? { captureExecutionOrigin: true as const } : {}),
            ...(parsedExpectedExecutionOrigin === undefined
                ? {}
                : { expectedExecutionOrigin: parsedExpectedExecutionOrigin }),
            ...(parsedExpectedExecutionRouting === undefined
                ? {}
                : { expectedExecutionRouting: parsedExpectedExecutionRouting }),
            ...(admittedTargetedOperation ? { admittedTargetedOperation: Object.freeze({
                action: Object.freeze({ ...admittedTargetedOperation.action }),
                target: Object.freeze({
                    pluginId: admittedTargetedOperation.targetPluginId,
                    occurrenceId: admittedTargetedOperation.targetOccurrenceId,
                }),
                contributorOccurrenceId: admittedTargetedOperation.contributorOccurrenceId,
                targetProtocol: admittedTargetedOperation.targetProtocol,
            }), beforeHandlerInvocation: async () => {
                throwIfInactive(params.seed, signal, undefined, true);
                requireAdmittedTargetedOperationExecutionBinding(originalOperation, params.seed,
                    await params.seed.readCurrentTargetedDeclarations?.(signal));
                throwIfInactive(params.seed, signal, undefined, true);
            } } : {}),
            ...(params.seed.requesterAccount ? { requesterAccount: params.seed.requesterAccount } : {}),
            ...(params.seed.session ? { sessionId: params.seed.session.id } : {}),
            signal,
        });
        const dispatch = async (): Promise<ContributedActionInvocationResult> => {
            if (!params.seed.reviewedParent || readObservation) return invoke(input, approvalContext, action);
            const role = admittedTargetedOperation?.operation.role ?? 'actions.execute';
            const issued = await invokeHostReviewedChildV1({
                parent: params.seed.reviewedParent,
                context: { ...approvalContext, surface: 'plugin', authority: 'account_automation', actionCaller, signal },
                child: { action, role, input },
                admittedReview: { action, role, surface: 'plugin' },
                execute: (operand, childContext) => {
                    // The issuer supplies the ordinary single envelope for a
                    // contribution ref. This already-bound adapter consumes it
                    // without reparsing or replacing its prepared operand.
                    const envelope = operand as Readonly<{ action: PluginContributionRef; input?: JsonValue }>;
                    return invoke(envelope.input, childContext, envelope.action);
                },
            });
            if ('status' in issued) return issued;
            throw createPluginActionHandlerNotStartedError({ code: issued.errorCode, message: issued.error });
        };
        const result = await runTracedExternalActionInnerStage(
            'contributed.targeted_operation',
            dispatch, params.seed.correlationId ? { invocationId: params.seed.correlationId } : {});
        // The caller was admitted before dispatch; a settled effect is reported
        // as it happened and the caller's retirement applies at its next call.
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
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, params.seed,
            await params.seed.readCurrentTargetedDeclarations?.(signal));
        const admittedInput = await resolveAdmittedTargetedOperationInput({
            seed: params.seed,
            assertCurrent: () => throwIfInactive(params.seed, signal, undefined, true),
            binding,
            input,
            expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed,
            signal,
        });
        const result = await invokeContributedActionWithCaller(
            binding,
            admittedInput,
            options,
            operation,
            false,
        );
        return result.value as TResult;
    };
    const observeAdmittedTargetedOperation: ActionsService['observeAdmittedTargetedOperation'] = async (operation, input, invalidate, options) => {
        const sourceSignal = composeActionSignal(params.seed.signal, options?.signal);
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, params.seed,
            await params.seed.readCurrentTargetedDeclarations?.(sourceSignal));
        const admittedInput = await resolveAdmittedTargetedOperationInput({
            seed: params.seed, assertCurrent: () => throwIfInactive(params.seed, sourceSignal, undefined, true),
            binding, input, expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed, signal: sourceSignal,
        });
        return await observeContributedActionRead({
            signal: sourceSignal, invalidate, isCurrent: params.seed.isOccurrenceCurrent,
            retire: params.seed.retireReadObservation,
            invoke: (observation, signal) => invokeContributedActionWithCaller(
                binding, admittedInput, { ...options, signal }, operation, false, undefined, undefined, observation,
            ),
        });
    };
    const observe: ActionsService['observe'] = async (action, input, invalidate, options) => {
        const reference = PluginContributionIdentityV1Schema.safeParse(action);
        if (!reference.success) throw createPluginActionHandlerNotStartedError({
            code: 'plugin_action_reference_invalid', message: 'Read observation requires a contributed Action reference',
        });
        const sourceSignal = composeActionSignal(params.seed.signal, options?.signal);
        throwIfInactive(params.seed, sourceSignal, undefined, true);
        return await observeContributedActionRead({ signal: sourceSignal, invalidate,
            isCurrent: params.seed.isOccurrenceCurrent, retire: params.seed.retireReadObservation,
            invoke: (observation, signal) => invokeContributedActionWithCaller(reference.data, input,
                { ...options, signal }, undefined, false, options?.expectedExecutionOrigin,
                options?.expectedExecutionRouting, observation),
        });
    };
    const executeOnce = async (
        actionOrRef: PluginInvocableActionId | PluginContributionRef,
        input: unknown,
        options?: ActionExecutionOptions,
        executionOriginRequest?: ActionExecutorContext['contributedActionExecutionOrigin'],
    ): Promise<unknown> => {
        // Both ordinary SDK ref methods share canonical Action admission.
        // Only opaque host-admitted target-operation handles use the separate
        // exact-operation contract above, never an arbitrary contribution ref.
        const contributionRef = typeof actionOrRef === 'string' ? null : actionOrRef;
        const canonicalActionId = contributionRef ? 'action.invoke' : actionOrRef;
        const canonicalInput = contributionRef
            ? { action: contributionRef, ...(input === undefined ? {} : { input }) }
            : input;
        const agentWitness = readAgentWitness();
        const signal = composeActionSignal(params.seed.signal, options?.signal, agentWitness?.signal,
            params.seed.approvalContext?.nativeRealtimeInput ? params.seed.approvalContext.signal : undefined);
        const isExecutionRunStart = actionOrRef === 'execution.run.start';
        const beforeStartDetails = isExecutionRunStart
            ? withExecutionRunStartFailureDetails(undefined, 'noRunCreated')
            : undefined;
        throwIfInactive(
            params.seed,
            signal,
            beforeStartDetails,
        );
        const attribution = params.seed.readActiveTurnAdmissionWitness
            ? agentWitness?.actionRequestAttributionV1
            : params.seed.actionRequestAttributionV1 ?? params.seed.approvalContext?.actionRequestAttributionV1;
        const actionCaller = resolveInvocationActionCaller(params.seed, agentWitness);
        if (!actionCaller) {
            throw new PluginError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin Action calls require current host-stamped caller provenance',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }

        const parsedActionId = ActionIdSchema.safeParse(canonicalActionId);
        if (!parsedActionId.success) {
            throw new PluginError({
                code: 'plugin_action_unknown',
                message: 'Plugin action id is not part of the canonical Action registry',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }
        const actionId = parsedActionId.data;
        const spec = getActionSpec(actionId);
        let sessionAddress: import('@happier-dev/plugin-sdk/sessions').ActionSessionAddressV1 | undefined;
        if (options?.sessionAddress !== undefined) {
            if (contributionRef) throw createPluginActionHandlerNotStartedError({
                code: 'session_address_unsupported', message: 'An exact Session address requires a host Session Action',
            });
            const scoped = validateActionSessionAddressV1({ sessionTarget: spec.sessionTarget,
                input: canonicalInput, sessionAddress: options.sessionAddress });
            if (!scoped.ok) throw createPluginActionHandlerNotStartedError({ code: scoped.errorCode, message: scoped.error });
            const source = params.seed.approvalContext;
            const home = source?.serverId?.trim();
            // This executor owns constructor-bound credentials and transport.
            // A context override cannot acquire another Home's authority.
            if (!home || !areServerProfileIdentifiersEquivalent(home, scoped.sessionAddress.serverId,
                identifier => identifier === home || identifier === source?.serverIdentityId ? source?.serverIdentityId : undefined)) {
                throw createPluginActionHandlerNotStartedError({ code: 'plugin_action_session_address_unavailable',
                    message: 'The exact Session address is outside this invocation\'s bound Home' });
            }
            sessionAddress = scoped.sessionAddress;
        }
        if (spec.surfaces.plugin !== true && !contributionRef) {
            throw new PluginError({
                code: 'plugin_action_not_available',
                message: 'Action is not available to plugin callers',
                ...(beforeStartDetails ? { details: beforeStartDetails } : {}),
            });
        }
        const pluginInputSchema = spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema;
        const parsedPluginInput = pluginInputSchema.safeParse(canonicalInput);
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
        const actionRequestId = params.seed.externalActionContext?.actionRequestId
            ?? (params.seed.approvalContext?.externalActionExecutionAuthorization ? params.seed.approvalContext.actionRequestId : undefined)
            ?? (params.seed.correlationId
            ? `${params.seed.correlationId}:${actionId}:${actionInvocationSequence}`
            : undefined);
        const readSessionActionRpcOrigin = () => {
            if (signal.aborted || !params.seed.isOccurrenceCurrent()) return null;
            const witness = params.seed.readActiveTurnAdmissionWitness?.();
            const caller = witness?.agentStartCaller;
            if (!witness || !params.seed.session || caller?.sessionId !== params.seed.session.id) return null;
            try {
                return resolveSessionRoleRpcOrigin({
                    actionCaller: caller,
                    actionRequestId,
                    callerPermissionMode: witness.callerPermissionMode,
                    causalPermissionAuthority: witness.causalPermissionAuthority,
                    sessionInputSource: {
                        sourceSessionId: params.seed.session.id,
                        sourceTurnId: witness.turnId,
                        sourceInputId: witness.inputId,
                    },
                });
            } catch {
                return null;
            }
        };
        const source: RpcActionExecutorContext | undefined = readApprovalContext();
        // A Discussion publication or an Event occurrence admission belongs to
        // this invocation through approval and native settlement, even without
        // local upload sources. Returning only an approval receipt makes a
        // retained ingress or checkpointed observer create another Ask on every
        // retry instead of waiting for that one consent and its result.
        const retainsInput = actionId === 'automation.event.source.status.report'
            || actionId === 'discussion.post' || actionId === 'discussion.reply'
            || actionId === 'automation.event.admit';
        const invocationRetirement = retainsInput ? new AbortController() : null;
        const executionSignal = invocationRetirement ? AbortSignal.any([signal, invocationRetirement.signal]) : signal;
        const invocationExecutor = retainsInput
            ? params.actionExecutor.bindInvocation?.(executionSignal, {
                actionId, signal: executionSignal, surface: 'plugin',
                isCurrent: () => !signal.aborted && params.seed.isOccurrenceCurrent()
                    && hasCurrentContributedActionCaller(params.seed, actionCaller),
                // The composed signal retains its first cause. A caller's own
                // abort therefore stays withdrawal even if retirement follows.
                isRetired: () => params.seed.signal.aborted && !params.seed.isOccurrenceCurrent()
                    && signal.reason === params.seed.signal.reason,
            }) ?? actionExecutor
            : actionExecutor;
        const executionRunWorkflowRunId = readWorkflowRunId();
        const executionContext = {
            ...(executionOriginRequest ? { contributedActionExecutionOrigin: executionOriginRequest } : {}),
            // Preserve original execution/signing custody without inheriting
            // present-person authority or a bypass from the initiating call.
            ...(source?.runtimeAccountId ? { runtimeAccountId: source.runtimeAccountId } : {}),
            ...(source?.expectedAccountId ? { expectedAccountId: source.expectedAccountId } : {}),
            ...(source?.serverId ? { serverId: source.serverId } : {}),
            ...(source?.serverIdentityId ? { serverIdentityId: source.serverIdentityId } : {}),
            ...(source?.machineAdmission ? { machineAdmission: source.machineAdmission } : {}),
            ...(source?.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: source.verifyMachineAdmissionCurrent } : {}),
            ...(source?.callerInputAuthorization ? { callerInputAuthorization: source.callerInputAuthorization } : {}),
            ...(source?.sessionActionOrigin ? { sessionActionOrigin: source.sessionActionOrigin } : {}),
            ...(source?.requesterSessionBootstrap ? { requesterSessionBootstrap: source.requesterSessionBootstrap } : {}),
            ...(source?.externalActionExecutionAuthorization
                ? { externalActionExecutionAuthorization: source.externalActionExecutionAuthorization } : {}),
            ...(source?.externalActionCredential ? { externalActionCredential: source.externalActionCredential } : {}),
            ...(source?.externalActionTarget ? { externalActionTarget: source.externalActionTarget } : {}),
            ...(source?.signExternalActionApprovalInput
                ? { signExternalActionApprovalInput: source.signExternalActionApprovalInput } : {}),
            ...(source?.callerPermissionMode !== undefined ? { callerPermissionMode: source.callerPermissionMode } : {}),
            ...(source?.approvalProfileId !== undefined ? { approvalProfileId: source.approvalProfileId } : {}),
            ...(source?.causalPermissionAuthority !== undefined ? { causalPermissionAuthority: source.causalPermissionAuthority } : {}),
            ...(source?.nativeRealtimeInput || agentWitness?.nativeRealtimeAdmission ? { nativeRealtimeInput: true } : {}),
            ...(source?.workspaceWrites !== undefined ? { workspaceWrites: source.workspaceWrites } : {}),
            ...(source?.sessionInputSource ? { sessionInputSource: source.sessionInputSource } : {}),
            ...(executionRunWorkflowRunId ? { executionRunWorkflowRunId } : {}),
            ...(params.seed.externalActionContext ?? {}),
            ...(params.seed.sessionListAccess ? { sessionListAccess: params.seed.sessionListAccess } : {}),
            ...(params.seed.session ? { defaultSessionId: params.seed.session.id } : {}),
            ...(params.seed.session && !params.seed.sessionListAccess
                ? { sessionListAccess: 'current_session' as const }
                : {}),
            ...(sessionAddress ? { serverId: sessionAddress.serverId, expectedSessionAddress: sessionAddress } : {}),
            surface: executionSurface,
            authority: 'account_automation',
            actionCaller,
            ...(executionSurface === 'agent'
                && (actionId === 'session.needs_you.raise' || actionId === 'session.user_action.answer')
                ? { readSessionActionRpcOrigin } : {}),
            signal: executionSignal,
            ...(attribution ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(attribution) } : {}),
            ...(executionSurface === 'agent'
                ? {
                    callerPermissionMode: agentWitness?.callerPermissionMode ?? null,
                    causalPermissionAuthority:
                        agentWitness?.causalPermissionAuthority ?? null,
                }
                : {}),
            ...(agentWitness && params.seed.session
                ? {
                    sessionInputSource: {
                        sourceSessionId: params.seed.session.id,
                        sourceTurnId: agentWitness.turnId,
                        sourceInputId: agentWitness.inputId,
                        ...(agentWitness.discussionAddressing ? { discussionAddressing: agentWitness.discussionAddressing } : {}),
                        via: 'action' as const,
                    },
                }
                : {}),
            ...(params.seed.externalActionContext
                ? { actionRequestId: params.seed.externalActionContext.actionRequestId }
                : actionRequestId ? { actionRequestId } : {}),
            ...(params.seed.bypassActionInterception === true
                ? { bypassActionInterception: true }
                : {}),
        } satisfies RpcActionExecutorContext & Readonly<{ actionCaller: ActionPluginCaller; signal: AbortSignal }>;
        const execute = () => params.seed.reviewedParent ? invokeHostReviewedChildV1({
            parent: params.seed.reviewedParent,
            context: executionContext,
            // Contribution refs already have their canonical action.invoke
            // envelope. The shared issuer owns target preparation, not this adapter.
            child: { action: actionId, role: 'actions.execute', input: parsedPluginInput.data as JsonValue },
            admittedReview: { action: actionId, role: 'actions.execute', surface: executionSurface },
            execute: (input, childContext, childActionId) => invocationExecutor.execute(childActionId, input,
                // The issuer preserves this ordinary plugin provenance and
                // augments it with host-private review; it does not replace the caller.
                childContext as typeof executionContext),
        }) : invocationExecutor.execute(actionId, parsedPluginInput.data, executionContext);
        const result = await execute().finally(() => {
            invocationRetirement?.abort();
        });
        const inactiveStartDetails = actionId === 'execution.run.start'
            ? withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown')
            : undefined;
        throwIfInactive(params.seed, signal, inactiveStartDetails);
        if (!result.ok) {
            if (contributionRef) {
                const failure = projectContributedActionExecuteResult(result);
                if (failure.status !== 'executed' && failure.data) throw contributedActionFailureError(failure);
            }
            throw failWorkflowApproval(executorFailure(actionId, result));
        }

        const deferredApproval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (deferredApproval.success) {
            if (deferredApproval.data.actionId !== actionId) {
                throw new PluginError({
                    code: 'plugin_action_result_schema_invalid',
                    message: 'Plugin Action approval result does not match the invoked Action',
                });
            }
            return deferredApproval.data;
        }

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

    // Status publication retains one live invocation while the canonical
    // Action approval waiter owns consent and execution. Repeated source wakes
    // observe that invocation, rather than creating another approval. This is
    // service-local interest only; settlement and retirement release it.
    const pendingStatusReports: Array<Readonly<{ input: JsonValue; signal: AbortSignal; result: Promise<unknown> }>> = [];
    const execute: typeof executeOnce = async (actionOrRef, input, options, executionOriginRequest) => {
        if (actionOrRef !== 'automation.event.source.status.report') {
            return await executeOnce(actionOrRef, input, options, executionOriginRequest);
        }
        const signal = options?.signal ?? params.seed.signal;
        throwIfInactive(params.seed, signal);
        const parsed = StrictJsonValueSchema.safeParse(input);
        if (!parsed.success) return await executeOnce(actionOrRef, input, options, executionOriginRequest);
        const pending = pendingStatusReports.find(report => report.signal === signal && sameStrictJsonValue(report.input, parsed.data));
        if (pending) return await pending.result;
        const report = { input: parsed.data, signal, result: executeOnce(actionOrRef, parsed.data, options, executionOriginRequest) };
        pendingStatusReports.push(report);
        try {
            return await report.result;
        } finally {
            pendingStatusReports.splice(pendingStatusReports.indexOf(report), 1);
        }
    };

    const executeWithExecutionOrigin = async (
        action: PluginContributionRef,
        input: JsonValue,
        options?: ContributedActionExecutionWithOriginOptions,
    ): Promise<ContributedActionExecutionWithOriginResult> => {
        const expectedExecutionOrigin = readExpectedExecutionOrigin(options?.expectedExecutionOrigin);
        const expectedExecutionRouting = readExpectedExecutionRouting(options?.expectedExecutionRouting);
        let executionOrigin: PluginMachineExecutionOriginV1 | undefined;
        const result = await execute(action, input, options, {
            ...(expectedExecutionOrigin === undefined ? {} : { expectedExecutionOrigin }),
            ...(expectedExecutionRouting === undefined ? {} : { expectedExecutionRouting }),
            onExecuted: origin => { executionOrigin = origin; },
        });
        if (!executionOrigin) {
            throw new PluginError({
                code: 'plugin_action_execution_origin_unavailable',
                message: 'Current target execution origin is unavailable',
            });
        }
        return Object.freeze({
            result: StrictJsonValueSchema.parse(result),
            executionOrigin,
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
        const signal = composeActionSignal(params.seed.signal, options?.signal);
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, params.seed,
            await params.seed.readCurrentTargetedDeclarations?.(signal));
        const admittedInput = await resolveAdmittedTargetedOperationInput({
            seed: params.seed,
            assertCurrent: () => throwIfInactive(params.seed, signal, undefined, true),
            binding,
            input,
            expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed,
            signal,
        });
        const result = await invokeContributedActionWithCaller(
            binding,
            admittedInput,
            options,
            operation,
            true,
            options?.expectedExecutionOrigin,
            options?.expectedExecutionRouting,
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
        async getCurrentExecutionRouting(options?: PluginCancellationOptions): Promise<PluginMachineExecutionRoutingV1 | null> {
            const signal = composeActionSignal(params.seed.signal, options?.signal);
            if (signal.aborted || !params.seed.isOccurrenceCurrent()) return null;
            const caller = resolveInvocationActionCaller(params.seed, readAgentWitness());
            if (!caller) return null;
            const origin = await resolvePluginInvocationCallerExecutionOrigin(caller, params.seed.resolveCurrentPluginExecutionOrigin, signal);
            if (!origin || signal.aborted || !params.seed.isOccurrenceCurrent()) return null;
            return Object.freeze(getPluginMachineExecutionRouting(origin));
        },
        execute,
        observe,
        executeAdmittedTargetedOperation,
        observeAdmittedTargetedOperation,
        executeWithExecutionOrigin,
        executeAdmittedTargetedOperationWithExecutionOrigin,
    }) as ActionsService;
}
