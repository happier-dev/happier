import type { PluginServiceId, PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionMediaService, SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import type {
    HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
    HostCurrentSessionUiServices,
    HostSessionApprovalRequest as PluginSessionApprovalRequest,
    HostSessionApprovalResult as PluginSessionApprovalResult,
    HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
    HostSessionConfirmationResult as PluginSessionConfirmationResult,
    HostSessionInteractionOptions,
    HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
    HostSessionQuestionsResult as PluginSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import {
    type InteractionTransientQuestionV1,
    type InteractionTransientRequestV1,
    type InteractionTransientRequesterV1,
    type InteractionTransientResultV1,
    type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { PermissionResult } from '@/agent/permissions/BasePermissionHandler';
import { toStructuredQuestionPermissionInput } from '@/agent/permissions/structuredQuestionPermissionInput';
import { normalizeQuestionAnswers, type QuestionAnswerWireValue } from '@/agent/permissions/structuredQuestionAnswers';
import { NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';
import { isWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInteractionsService, readActiveTurnPermissionContext } from '@/plugins/runtime/invocation/services/interactions';
import type { ExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { StoredCredentials } from '@/persistence';
import {
    bindPluginSessionsSubagentObservation,
    createPluginSessionsInventory,
    readPluginSessionsSubagentObservation,
} from '@/session/services/pluginSessionsInventory';
import { combineSignals, createNativePermissionDecisionApplication, createPluginSessionHandleCapabilitiesFactory, readNativeObservedPermissionDecision, requestNativePermissionDecision } from '@/session/services/pluginSessionHandleCapabilities';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { executePluginSessionMessageAction } from '@/session/services/executePluginSessionMessageAction';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
    CURRENT_SESSION_INTERACTION_DEADLINE_MS,
    createCurrentExecutionRunInteractionOwner,
    createCurrentSessionInteractionOwner,
    createUnavailableCurrentSessionInteractionOwner,
    isCurrentSessionInteractionDeadlineMs,
    type CurrentSessionInteractionOwner,
} from '@/session/presentation/currentSessionInteractionOwner';

type InteractionResult =
    | PluginSessionApprovalResult
    | PluginSessionQuestionsResult
    | PluginSessionConfirmationResult;

function unavailable(
    request: { kind: InteractionResult['kind'] },
    requestId: string,
): InteractionResult {
    return Object.freeze({
        requestId,
        kind: request.kind,
        status: 'unavailable',
    }) as InteractionResult;
}

function interactionQuestions(
    request: Exclude<InteractionTransientRequestV1, { kind: 'approval' }>,
): readonly InteractionTransientQuestionV1[] {
    return request.kind === 'questions' ? request.questions : [{
        id: 'confirmation',
        prompt: request.message,
        type: 'singleChoice',
        required: true,
        allowCustom: false,
        choices: [{ id: 'confirm', label: 'Confirm' }, { id: 'decline', label: 'Cancel' }],
    }];
}

function toPermissionInput(request: InteractionTransientRequestV1): unknown {
    if (request.kind === 'approval') {
        // Native tool policy and presentation consume the actual operands. The
        // transient owner retains the approval envelope and persistence ceiling.
        return request.subject.input;
    }
    return toStructuredQuestionPermissionInput({
        ...(request.title && (request.kind !== 'confirmation' || request.title !== 'Confirmation')
            ? { title: request.title } : {}),
        questions: interactionQuestions(request),
    });
}

export type NativeAgentSessionInteractionParams = Readonly<{
    permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'> | null | undefined;
    pluginId: string;
    contributionId: string;
    runtimeId: string;
    sessionId: string;
    occurrenceId: string;
    immutableGenerationId?: string;
    sourceCustody?: PluginSourceCustodyV1;
    /**
     * Host-side override only. Omitted in production so the Session arm binds the
     * canonical `CURRENT_SESSION_INTERACTION_DEADLINE_MS` policy; a supplied value
     * must still satisfy the cross-realm bound or the arm fails closed.
     */
    interactionDeadlineMs?: number;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    credentials?: StoredCredentials;
    readCredentials?: () => Promise<StoredCredentials | null>;
    /** The daemon's already-retained snapshot for this exact Home. */
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    readPermissionMode?: () => string;
    applyPermissionModeIntent?: (mode: NonNullable<PermissionResult['mode']>) => Promise<void>;
    media?: SessionMediaService;
    presentation?: HostCurrentSessionUiServices['presentation'];
    currentSessionUi?: HostCurrentSessionUiServices;
    resolveCallerMaterialization?(): PluginMachineMaterializationRefV1 | null;
    readActiveTurnAdmissionWitness?(): AgentInvocationTurnAdmissionWitness | null;
    onUnavailable?(): void;
}>;

export type NativeAgentExecutionRunInteractionParams = Omit<
    NativeAgentSessionInteractionParams,
    'sessionId' | 'credentials' | 'readCredentials' | 'readPermissionMode' | 'media' | 'sourceCustody'
> & Readonly<{
    executionRunId: string;
}>;

type PluginGenerationState = 'current' | 'retired' | 'unverifiable';

function readPluginGenerationState(isCurrent: (() => boolean) | undefined): PluginGenerationState {
    if (!isCurrent) return 'unverifiable';
    try {
        const current = isCurrent();
        return current === true ? 'current' : current === false ? 'retired' : 'unverifiable';
    } catch {
        return 'unverifiable';
    }
}

type NativePermissionPresentationContext = Readonly<{
    permissionContext?: HostSessionInteractionOptions['permissionContext'];
    buildNativeChoices?: HostSessionInteractionOptions['buildNativeChoices'];
}>;

function defaultRequester(
    params: NativeAgentSessionInteractionParams | NativeAgentExecutionRunInteractionParams,
): InteractionTransientRequesterV1 {
    return Object.freeze({
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        occurrenceId: params.occurrenceId,
        invocationId: params.runtimeId,
    });
}

function readPermissionHandler(
    params: NativeAgentSessionInteractionParams | NativeAgentExecutionRunInteractionParams,
): Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'> | null {
    return params.permissionHandler && typeof params.permissionHandler.handleToolCall === 'function'
        ? params.permissionHandler
        : null;
}

/**
 * The one place the Session arm resolves its deadline. `ok: false` is the only
 * fail-closed arm and is reachable only from a caller-supplied value outside the
 * cross-realm bound; omission is the production case and binds host policy,
 * whose `deadlineMs` is `null` — no host deadline, no timer.
 */
type CurrentSessionInteractionDeadlineResolution =
    | Readonly<{ ok: true; deadlineMs: number | null }>
    | Readonly<{ ok: false }>;

function readInteractionDeadlineMs(
    params: NativeAgentSessionInteractionParams | NativeAgentExecutionRunInteractionParams,
): CurrentSessionInteractionDeadlineResolution {
    if (params.interactionDeadlineMs === undefined) {
        return Object.freeze({ ok: true, deadlineMs: CURRENT_SESSION_INTERACTION_DEADLINE_MS });
    }
    return isCurrentSessionInteractionDeadlineMs(params.interactionDeadlineMs)
        ? Object.freeze({ ok: true, deadlineMs: params.interactionDeadlineMs })
        : Object.freeze({ ok: false });
}

function canPresentCurrentSessionInteraction(
    params: NativeAgentSessionInteractionParams | NativeAgentExecutionRunInteractionParams,
): boolean {
    return readInteractionDeadlineMs(params).ok
        && params.signal !== undefined
        && params.isCurrent !== undefined
        && readPermissionHandler(params) !== null;
}

async function presentBoundPermissionRequest(
    params: Readonly<{
        permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
        request: InteractionTransientRequestV1;
        signal: AbortSignal;
        permissionContext?: HostSessionInteractionOptions['permissionContext'];
        buildNativeChoices?: HostSessionInteractionOptions['buildNativeChoices'];
        applyPermissionModeIntent?: NativeAgentSessionInteractionParams['applyPermissionModeIntent'];
    }>,
): Promise<InteractionTransientResultV1> {
    const { request } = params;
    const permissionContext = params.permissionContext;
    const hasCausalPermissionAuthority = permissionContext !== undefined
        && Object.hasOwn(permissionContext, 'causalPermissionAuthority');
    const hasTurnId = permissionContext !== undefined
        && Object.hasOwn(permissionContext, 'turnId');
    const toolName = request.kind === 'approval'
        ? request.subject.name
        : 'AskUserQuestion';
    const acknowledgeDecisionApplication = createNativePermissionDecisionApplication({
        applyPermissionModeIntent: params.applyPermissionModeIntent,
    });
    let result: Awaited<ReturnType<ProviderEnforcedPermissionHandler['handleToolCall']>>;
    try {
        result = await params.permissionHandler.handleToolCall(
            request.kind === 'approval' ? request.subject.toolCallId ?? request.requestId : request.requestId,
            toolName,
            toPermissionInput(request),
            {
                ...(request.kind === 'approval'
                    ? { source: request.allowedPersistenceScopes?.includes('session') === true
                        ? NATIVE_TOOL_APPROVAL_REQUEST_SOURCE : NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE }
                    : {}),
                ...(request.kind === 'approval' && request.nativeChoices !== undefined
                    ? { nativeChoices: request.nativeChoices } : {}),
                ...(request.kind === 'approval' && params.buildNativeChoices
                    ? { buildNativeChoices: params.buildNativeChoices } : {}),
                ...(request.kind === 'questions' && permissionContext?.lifetime === 'occurrence'
                    ? { origin: 'host_occurrence_question' as const }
                    : permissionContext?.origin ? { origin: permissionContext.origin } : {}),
                ...(permissionContext?.lifetime ? { lifetime: permissionContext.lifetime } : {}),
                ...(hasTurnId && permissionContext
                    ? { turnId: permissionContext.turnId }
                    : {}),
                ...(hasCausalPermissionAuthority && permissionContext
                    ? { causalPermissionAuthority: permissionContext.causalPermissionAuthority }
                    : {}),
                ...(permissionContext?.callerPermissionMode !== undefined
                    ? { callerPermissionMode: permissionContext.callerPermissionMode } : {}),
                owner: permissionContext?.owner ?? {
                    kind: 'plugin',
                    pluginId: request.requester.pluginId,
                    runtimeId: request.requester.invocationId,
                },
                signal: params.signal,
                ...(acknowledgeDecisionApplication ? { acknowledgeDecisionApplication } : {}),
            },
        );
    } catch (error) {
        if (isWorkflowInteractionCapacityError(error)) throw error;
        return unavailable(request, request.requestId);
    }
    if (!result || typeof result !== 'object' || typeof result.decision !== 'string') {
        return unavailable(request, request.requestId);
    }
    if (result.execPolicyAmendment !== undefined && !(request.kind === 'approval' && result.nativeChoice)) {
        return unavailable(request, request.requestId);
    }
    const decision = result.decision;
    if (request.kind === 'approval') {
        const nativeAnswer = result.nativeChoice ? { nativeChoice: result.nativeChoice } : {};
        if (decision === 'abort') return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'userCancelled', ...nativeAnswer });
        if (decision === 'denied') return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'declined', ...nativeAnswer });
        if (decision !== 'approved' && decision !== 'approved_for_session'
            && !(decision === 'approved_execpolicy_amendment' && result.nativeChoice)) {
            return unavailable(request, request.requestId);
        }
        const canPersistSession = decision === 'approved_for_session'
            && request.allowedPersistenceScopes?.includes('session') === true;
        if (decision === 'approved_for_session' && !canPersistSession) {
            return unavailable(request, request.requestId);
        }
        return Object.freeze({
            requestId: request.requestId,
            kind: 'approval',
            status: 'approved',
            persistence: canPersistSession ? 'session' : 'once',
            ...nativeAnswer,
        });
    }
    if (decision === 'abort' || decision === 'denied') {
        return request.kind === 'confirmation'
            ? Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: decision === 'denied' ? 'declined' : 'userCancelled' })
            : Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'userCancelled' });
    }
    if (
        decision !== 'approved'
        || !result.answers
        || typeof result.answers !== 'object'
        || Array.isArray(result.answers)
    ) {
        return unavailable(request, request.requestId);
    }
    const answerEntries = Object.entries(result.answers);
    const allLegacyScalars = answerEntries.every((entry) => typeof entry[1] === 'string');
    const allStructuredArrays = answerEntries.every((entry) => (
        Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string')
    ));
    if (!allLegacyScalars && !allStructuredArrays) {
        return unavailable(request, request.requestId);
    }
    const answers = normalizeQuestionAnswers(
        interactionQuestions(request),
        Object.fromEntries(answerEntries) as Record<string, QuestionAnswerWireValue>,
        result.answerDetails,
    );
    if (!answers) return unavailable(request, request.requestId);
    if (request.kind === 'questions') {
        return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'answered', answers });
    }
    const answer = answers.confirmation;
    if (answer?.kind !== 'singleChoice' || answer.answer.kind !== 'choice') {
        return unavailable(request, request.requestId);
    }
    return Object.freeze({
        requestId: request.requestId,
        kind: 'confirmation',
        status: answer.answer.choiceId === 'confirm' ? 'approved' : 'declined',
    });
}

function createNativeCurrentSessionInteractionOwner(
    params: NativeAgentSessionInteractionParams,
): CurrentSessionInteractionOwner {
    const deadline = readInteractionDeadlineMs(params);
    const signal = params.signal;
    const isCurrent = params.isCurrent;
    const permissionHandler = readPermissionHandler(params);
    if (!deadline.ok || !signal || !isCurrent || !permissionHandler) {
        return createUnavailableCurrentSessionInteractionOwner();
    }
    return createCurrentSessionInteractionOwner({
        sessionId: params.sessionId,
        sessionSignal: signal,
        isOccurrenceCurrent: isCurrent,
        deadlineMs: deadline.deadlineMs,
        propagatePresentationError: isWorkflowInteractionCapacityError,
        present: async (request, options) => await presentBoundPermissionRequest({
            permissionHandler,
            request,
            signal: options.signal,
            applyPermissionModeIntent: params.applyPermissionModeIntent,
            ...(options.presentationContext === undefined
                ? {}
                : {
                    ...options.presentationContext as NativePermissionPresentationContext,
                }),
        }),
    });
}

function createNativeCurrentExecutionRunInteractionOwner(
    params: NativeAgentExecutionRunInteractionParams,
): CurrentSessionInteractionOwner {
    const deadline = readInteractionDeadlineMs(params);
    const signal = params.signal;
    const isCurrent = params.isCurrent;
    const permissionHandler = readPermissionHandler(params);
    if (!deadline.ok || !signal || !isCurrent || !permissionHandler) {
        return createUnavailableCurrentSessionInteractionOwner();
    }
    return createCurrentExecutionRunInteractionOwner({
        executionRunId: params.executionRunId,
        executionRunSignal: signal,
        isOccurrenceCurrent: isCurrent,
        deadlineMs: deadline.deadlineMs,
        propagatePresentationError: isWorkflowInteractionCapacityError,
        present: async (request, options) => await presentBoundPermissionRequest({
            permissionHandler,
            request,
            signal: options.signal,
            applyPermissionModeIntent: params.applyPermissionModeIntent,
            ...(options.presentationContext === undefined
                ? {}
                : {
                    ...options.presentationContext as NativePermissionPresentationContext,
                }),
        }),
    });
}

/** Thin adapter only: canonical normalization, currentness, timing, and settlement stay above it. */
class NativeAgentCurrentSessionInteractionAdapter implements PluginCurrentSessionInteractionsService {
    private readonly owner: CurrentSessionInteractionOwner;
    private readonly requester: InteractionTransientRequesterV1;

    constructor(private readonly params: NativeAgentSessionInteractionParams) {
        this.owner = createNativeCurrentSessionInteractionOwner(params);
        this.requester = defaultRequester(params);
    }

    request(request: PluginSessionApprovalRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionApprovalResult>;
    request(request: PluginSessionQuestionsRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionQuestionsResult>;
    request(request: PluginSessionConfirmationRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionConfirmationResult>;
    async request(
        request: PluginSessionApprovalRequest | PluginSessionQuestionsRequest | PluginSessionConfirmationRequest,
        options?: HostSessionInteractionOptions,
    ): Promise<InteractionResult> {
        const result = await this.owner.request(request, {
            requester: options?.requester ?? this.requester,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.permissionContext === undefined && options?.buildNativeChoices === undefined
                ? {}
                : { presentationContext: Object.freeze({
                    ...(options?.permissionContext ? { permissionContext: options.permissionContext } : {}),
                    ...(options?.buildNativeChoices ? { buildNativeChoices: options.buildNativeChoices } : {}),
                }) }),
        }) as InteractionResult;
        if (result.status === 'unavailable') this.params.onUnavailable?.();
        return result;
    }
}

class NativeAgentCurrentExecutionRunInteractionAdapter implements PluginCurrentSessionInteractionsService {
    private readonly owner: CurrentSessionInteractionOwner;
    private readonly requester: InteractionTransientRequesterV1;

    constructor(private readonly params: NativeAgentExecutionRunInteractionParams) {
        this.owner = createNativeCurrentExecutionRunInteractionOwner(params);
        this.requester = defaultRequester(params);
    }

    request(request: PluginSessionApprovalRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionApprovalResult>;
    request(request: PluginSessionQuestionsRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionQuestionsResult>;
    request(request: PluginSessionConfirmationRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionConfirmationResult>;
    async request(
        request: PluginSessionApprovalRequest | PluginSessionQuestionsRequest | PluginSessionConfirmationRequest,
        options?: HostSessionInteractionOptions,
    ): Promise<InteractionResult> {
        const result = await this.owner.request(request, {
            requester: options?.requester ?? this.requester,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.permissionContext === undefined && options?.buildNativeChoices === undefined
                ? {}
                : { presentationContext: Object.freeze({
                    ...(options?.permissionContext ? { permissionContext: options.permissionContext } : {}),
                    ...(options?.buildNativeChoices ? { buildNativeChoices: options.buildNativeChoices } : {}),
                }) }),
        }) as InteractionResult;
        if (result.status === 'unavailable') this.params.onUnavailable?.();
        return result;
    }
}

export function createNativeAgentCurrentSessionUiServices(
    params: NativeAgentSessionInteractionParams,
): HostCurrentSessionUiServices {
    return Object.freeze({
        interactions: Object.freeze(new NativeAgentCurrentSessionInteractionAdapter(params)),
        ...(params.presentation ? { presentation: params.presentation } : {}),
    });
}

/** Interaction-only binding for a detached Execution Run; no Session inventory is projected. */
export function createNativeAgentCurrentExecutionRunUiServices(
    params: NativeAgentExecutionRunInteractionParams,
): HostCurrentSessionUiServices {
    return Object.freeze({
        interactions: Object.freeze(new NativeAgentCurrentExecutionRunInteractionAdapter(params)),
        ...(params.presentation ? { presentation: params.presentation } : {}),
    });
}

/** The admitted Run binds its existing pending owner without manufacturing a Session handle. */
export function createNativeAgentExecutionRunPermissions(
    params: Pick<NativeAgentExecutionRunInteractionParams, 'pluginId' | 'runtimeId' | 'signal' | 'isCurrent' | 'readActiveTurnAdmissionWitness' | 'onUnavailable'> & Readonly<{
        permissionHandler: Pick<ExecutionRunPermissionHandler, 'handleToolCall' | 'settleObservedDecision'>;
        readPermissionMode: () => string;
    }>,
): SessionPermissionsService {
    const owner = Object.freeze({ kind: 'plugin' as const, pluginId: params.pluginId, runtimeId: params.runtimeId });
    const assertCurrent = (): void => {
        params.signal?.throwIfAborted();
        if (readPluginGenerationState(params.isCurrent) !== 'current') {
            throw Object.assign(new Error('Execution-run permission interaction target is unavailable'),
                { code: 'execution_run_interaction_unavailable' });
        }
    };
    return Object.freeze({
        async requestDecision(request, options) {
            try {
                assertCurrent();
                const result = await requestNativePermissionDecision({
                    permissionHandler: params.permissionHandler, owner, request,
                    signal: combineSignals(params.signal, options?.signal),
                    permissionContext: readActiveTurnPermissionContext(params),
                    acknowledgeDecisionApplication: options?.acknowledgeDecisionApplication,
                    buildNativeChoices: options?.buildNativeChoices,
                });
                assertCurrent();
                return result;
            } catch (error) {
                if (error !== null && typeof error === 'object' && 'code' in error
                    && error.code === 'execution_run_interaction_unavailable') params.onUnavailable?.();
                throw error;
            }
        },
        async settleObservedDecision(request) {
            assertCurrent();
            const result = await params.permissionHandler.settleObservedDecision({
                ...readNativeObservedPermissionDecision(request), owner,
            });
            assertCurrent();
            return result;
        },
        getMode() {
            assertCurrent();
            return params.readPermissionMode();
        },
    } satisfies SessionPermissionsService);
}

/** Native Session custody owns live capabilities; invocation services retain external operations. */
export function bindNativeAgentSessionServices(operationServices: PluginServices, sessionServices: PluginServices): PluginServices {
    const sessions = Object.freeze({
        ...sessionServices.sessions,
        external: operationServices.sessions.external,
    });
    const subagentObservation = readPluginSessionsSubagentObservation(sessionServices.sessions);
    if (subagentObservation) bindPluginSessionsSubagentObservation(sessions, subagentObservation);
    return Object.freeze({
        ...operationServices,
        availability: (serviceId: PluginServiceId) => serviceId === 'sessions'
            ? sessionServices.availability('sessions')
            : operationServices.availability(serviceId),
        sessions,
    });
}

export function createNativeAgentSessionServices(params: NativeAgentSessionInteractionParams): PluginServices {
    const base = createUnavailablePluginServices();
    const permissionHandler = readPermissionHandler(params);
    const currentSessionUi = params.currentSessionUi
        ?? createNativeAgentCurrentSessionUiServices({ ...params, permissionHandler });
    const interactions = createPluginInteractionsService({
        currentSession: currentSessionUi,
        signal: params.signal ?? new AbortController().signal,
        isOccurrenceCurrent: () => readPluginGenerationState(params.isCurrent) === 'current',
        ...(params.readActiveTurnAdmissionWitness
            ? { readActiveTurnAdmissionWitness: params.readActiveTurnAdmissionWitness }
            : {}),
        requester: Object.freeze({
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            occurrenceId: params.occurrenceId,
            invocationId: params.runtimeId,
        }),
    });
    const readSessionAvailability = () => {
        if (!params.credentials) return base.availability('sessions');
        const generationState = readPluginGenerationState(params.isCurrent);
        if (generationState === 'retired') {
            return Object.freeze({ status: 'unavailable' as const, code: 'plugin_generation_retired' });
        }
        return generationState === 'unverifiable'
            ? Object.freeze({ status: 'unavailable' as const, code: 'plugin_generation_unverifiable' })
            : Object.freeze({ status: 'available' as const });
    };
    const liveScopeId = Symbol(`native-session:${params.sessionId}`);
    const messageActionExecutor = params.credentials
        ? createCliActionExecutorFromCredentials({
            credentials: params.credentials,
            ...(params.readCredentials ? { readCredentials: params.readCredentials } : {}),
            ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
        })
        : null;
    const sourceCustody = params.sourceCustody;
    const inventory = params.credentials && params.isCurrent && sourceCustody
        ? createPluginSessionsInventory({
            executeMessageAction: async ({ sessionId, request, signal }) => (
                await executePluginSessionMessageAction({
                    execute: async (actionId, input, context) => (
                        await messageActionExecutor!.execute(actionId, input, context)
                    ),
                    pluginId: params.pluginId,
                    contributionLocalId: params.contributionId,
                    occurrenceId: params.occurrenceId,
                    sourceCustody,
                    ...(params.resolveCallerMaterialization
                        ? { resolveCallerMaterialization: params.resolveCallerMaterialization }
                        : {}),
                    sessionId,
                    request,
                    signal,
                })
            ),
            credentials: params.credentials,
            signal: params.signal ?? new AbortController().signal,
            ...(params.readCredentials ? { readCredentials: params.readCredentials } : {}),
            ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
            currentSessionId: params.sessionId,
            sessionScopes: Object.freeze([Object.freeze({
                access: Object.freeze(['read', 'write', 'control'] as const),
                sessionIds: Object.freeze([params.sessionId]),
            })]),
            isCurrent: params.isCurrent,
            external: base.sessions.external,
            createHandleCapabilities: ({ sessionId, readSummary }) => (
                        createPluginSessionHandleCapabilitiesFactory({
                            credentials: params.credentials!,
                            ...(params.readCredentials ? { readCredentials: params.readCredentials } : {}),
                            caller: {
                                pluginId: params.pluginId,
                                contributionId: params.contributionId,
                                sourceCustody,
                                runtimeId: params.runtimeId,
                            },
                            signal: params.signal ?? new AbortController().signal,
                            isCurrent: params.isCurrent!,
                            readAgentId: async (_boundSessionId, signal) => (
                                sessionId === params.sessionId
                                    ? params.runtimeId
                                    : (await readSummary({ signal })).agentId ?? null
                            ),
                            resolveLiveCapabilities: (boundSessionId) => (
                                boundSessionId === params.sessionId
                                    ? Object.freeze({
                                        scopeId: liveScopeId,
                                        ...(permissionHandler ? { permissionHandler } : {}),
                                        interactions,
                                        readPermissionMode: params.readPermissionMode ?? (() => 'unavailable'),
                                        ...(params.applyPermissionModeIntent ? { applyPermissionModeIntent: params.applyPermissionModeIntent } : {}),
                                        ...(params.readActiveTurnAdmissionWitness
                                            ? { readActiveTurnAdmissionWitness: params.readActiveTurnAdmissionWitness }
                                            : {}),
                                        ...(params.media ? { media: params.media } : {}),
                                        ...(params.signal ? { signal: params.signal } : {}),
                                        isCurrent: params.isCurrent!,
                                    })
                                    : null
                            ),
                        })(sessionId)
                    ),
        })
        : base.sessions;
    return Object.freeze({
        ...base,
        availability: (serviceId: PluginServiceId) => {
            if (serviceId === 'sessions') return readSessionAvailability();
            if (serviceId === 'interactions') {
                return canPresentCurrentSessionInteraction(params)
                    && !params.signal!.aborted
                    && readPluginGenerationState(params.isCurrent) === 'current'
                    ? Object.freeze({ status: 'available' as const })
                    : base.availability('interactions');
            }
            return base.availability(serviceId);
        },
        sessions: inventory,
        interactions,
    });
}
