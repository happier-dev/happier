import type { PluginServiceId, PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
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
    type InteractionTransientQuestionAnswerV1,
    type InteractionTransientQuestionV1,
    type InteractionTransientRequestV1,
    type InteractionTransientRequesterV1,
    type InteractionTransientResultV1,
    type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { StoredCredentials } from '@/persistence';
import { createPluginSessionsInventory } from '@/session/services/pluginSessionsInventory';
import { createPluginSessionHandleCapabilitiesFactory } from '@/session/services/pluginSessionHandleCapabilities';
import { executePluginSessionMessageAction } from '@/session/services/executePluginSessionMessageAction';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    CURRENT_SESSION_INTERACTION_DEADLINE_MS,
    createCurrentSessionInteractionOwner,
    createUnavailableCurrentSessionInteractionOwner,
    isCurrentSessionInteractionDeadlineMs,
    type CurrentSessionInteractionOwner,
} from '@/session/presentation/currentSessionInteractionOwner';

type InteractionResult =
    | PluginSessionApprovalResult
    | PluginSessionQuestionsResult
    | PluginSessionConfirmationResult;

type QuestionAnswerWireValue = string | readonly string[];
type QuestionAnswersWire = Readonly<Record<string, QuestionAnswerWireValue>>;

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

function resolveChoiceSelection(
    raw: string,
    question: Extract<InteractionTransientQuestionV1, { type: 'singleChoice' | 'multipleChoice' }>,
) {
    const value = raw.trim();
    const byId = question.choices.find((choice) => choice.id === value);
    if (byId) return Object.freeze({ kind: 'choice', choiceId: byId.id });
    const byLabel = question.choices.filter((choice) => choice.label === value);
    if (byLabel.length === 1) return Object.freeze({ kind: 'choice', choiceId: byLabel[0]!.id });
    if (byLabel.length > 1) return null;
    return question.allowCustom && value.length > 0
        ? Object.freeze({ kind: 'custom', value })
        : null;
}

function normalizeQuestionAnswers(
    questions: readonly InteractionTransientQuestionV1[],
    rawAnswers: QuestionAnswersWire,
): Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null {
    const byId = new Map(questions.map((question) => [question.id, question]));
    if (Object.keys(rawAnswers).some((questionId) => !byId.has(questionId))) return null;
    const output = Object.create(null) as Record<string, InteractionTransientQuestionAnswerV1>;
    for (const question of questions) {
        const rawAnswer = rawAnswers[question.id];
        if (rawAnswer === undefined) {
            if (question.required) return null;
            continue;
        }
        const values = Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer];
        if (question.type === 'text') {
            if (values.length !== 1) return null;
            output[question.id] = Object.freeze({ kind: 'text', value: values[0]! });
            continue;
        }
        if (question.type === 'singleChoice') {
            if (values.length !== 1) return null;
            const answer = resolveChoiceSelection(values[0]!, question);
            if (!answer) return null;
            output[question.id] = Object.freeze({ kind: 'singleChoice', answer });
            continue;
        }
        const choices = values.map((value) => resolveChoiceSelection(value, question));
        if (choices.length === 0 || choices.some((choice) => choice === null)) return null;
        const dedupeKeys = choices.map((choice) => choice!.kind === 'choice'
            ? `choice:${choice!.choiceId}`
            : `custom:${choice!.value}`);
        if (new Set(dedupeKeys).size !== dedupeKeys.length) return null;
        output[question.id] = Object.freeze({
            kind: 'multipleChoice',
            answers: choices as [NonNullable<typeof choices[number]>, ...NonNullable<typeof choices[number]>[]],
        });
    }
    return Object.freeze(output);
}

function toPermissionInput(request: InteractionTransientRequestV1): unknown {
    if (request.kind === 'approval') {
        return Object.freeze({
            title: request.title,
            ...(request.description ? { description: request.description } : {}),
            subject: request.subject,
            ...(request.allowedPersistenceScopes?.includes('session')
                ? { allowedPersistenceScopes: request.allowedPersistenceScopes }
                : {}),
        });
    }
    if (request.kind === 'questions') {
        return Object.freeze({
            ...(request.title ? { title: request.title } : {}),
            questions: request.questions.map((question) => Object.freeze({
                id: question.id,
                question: question.prompt,
                ...(question.required ? { required: true } : {}),
                ...(question.type === 'text'
                    ? { selection: 'text' as const }
                    : {
                        selection: question.type === 'singleChoice' ? 'single' as const : 'multiple' as const,
                        options: question.choices.map((choice) => Object.freeze({
                            id: choice.id,
                            label: choice.label,
                            ...(choice.description ? { description: choice.description } : {}),
                        })),
                        ...(question.allowCustom ? { allowCustom: true } : {}),
                    }),
            })),
        });
    }
    return Object.freeze({
        title: request.title === 'Confirmation' ? undefined : request.title,
        message: request.message,
    });
}

export type NativeAgentSessionInteractionParams = Readonly<{
    permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'> | null | undefined;
    pluginId: string;
    contributionId: string;
    runtimeId: string;
    sessionId: string;
    generationId: string;
    immutableGenerationId?: string;
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
    readPermissionMode?: () => string;
    media?: SessionMediaService;
    presentation?: HostCurrentSessionUiServices['presentation'];
    currentSessionUi?: HostCurrentSessionUiServices;
    resolveCallerMaterialization?(): PluginMachineMaterializationRefV1 | null;
    readActiveTurnAdmissionWitness?(): AgentInvocationTurnAdmissionWitness | null;
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
    permissionContext: NonNullable<HostSessionInteractionOptions['permissionContext']>;
}>;

function defaultRequester(params: NativeAgentSessionInteractionParams): InteractionTransientRequesterV1 {
    return Object.freeze({
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        generationId: params.immutableGenerationId ?? params.generationId,
        invocationId: params.runtimeId,
    });
}

function readPermissionHandler(
    params: NativeAgentSessionInteractionParams,
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
    params: NativeAgentSessionInteractionParams,
): CurrentSessionInteractionDeadlineResolution {
    if (params.interactionDeadlineMs === undefined) {
        return Object.freeze({ ok: true, deadlineMs: CURRENT_SESSION_INTERACTION_DEADLINE_MS });
    }
    return isCurrentSessionInteractionDeadlineMs(params.interactionDeadlineMs)
        ? Object.freeze({ ok: true, deadlineMs: params.interactionDeadlineMs })
        : Object.freeze({ ok: false });
}

function canPresentCurrentSessionInteraction(params: NativeAgentSessionInteractionParams): boolean {
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
        : request.kind === 'questions' ? 'AskUserQuestion' : 'AgentConfirmation';
    let result: Awaited<ReturnType<ProviderEnforcedPermissionHandler['handleToolCall']>>;
    try {
        result = await params.permissionHandler.handleToolCall(
            request.requestId,
            toolName,
            toPermissionInput(request),
            {
                ...(permissionContext?.origin ? { origin: permissionContext.origin } : {}),
                ...(hasTurnId && permissionContext
                    ? { turnId: permissionContext.turnId }
                    : {}),
                ...(hasCausalPermissionAuthority && permissionContext
                    ? { causalPermissionAuthority: permissionContext.causalPermissionAuthority }
                    : {}),
                owner: permissionContext?.owner ?? {
                    kind: 'plugin',
                    pluginId: request.requester.pluginId,
                    runtimeId: request.requester.invocationId,
                },
                signal: params.signal,
            },
        );
    } catch {
        return unavailable(request, request.requestId);
    }
    if (!result || typeof result !== 'object' || typeof result.decision !== 'string') {
        return unavailable(request, request.requestId);
    }
    if (result.execPolicyAmendment !== undefined) return unavailable(request, request.requestId);
    const decision = result.decision;
    if (request.kind === 'approval') {
        if (decision === 'abort') return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'userCancelled' });
        if (decision === 'denied') return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'declined' });
        if (decision !== 'approved' && decision !== 'approved_for_session') {
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
        });
    }
    if (request.kind === 'questions') {
        if (decision === 'abort' || decision === 'denied') {
            return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'userCancelled' });
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
            request.questions,
            Object.fromEntries(answerEntries) as Record<string, QuestionAnswerWireValue>,
        );
        return answers
            ? Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'answered', answers })
            : unavailable(request, request.requestId);
    }
    if (decision === 'abort') return Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: 'userCancelled' });
    if (decision !== 'approved' && decision !== 'denied') {
        return unavailable(request, request.requestId);
    }
    return Object.freeze({
        requestId: request.requestId,
        kind: 'confirmation',
        status: decision === 'approved' ? 'approved' : 'declined',
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
        isGenerationCurrent: isCurrent,
        deadlineMs: deadline.deadlineMs,
        present: async (request, options) => await presentBoundPermissionRequest({
            permissionHandler,
            request,
            signal: options.signal,
            ...(options.presentationContext === undefined
                ? {}
                : {
                    permissionContext: (
                        options.presentationContext as NativePermissionPresentationContext
                    ).permissionContext,
                }),
        }),
    });
}

/** Thin adapter only: canonical normalization, currentness, timing, and settlement stay above it. */
class NativeAgentCurrentSessionInteractionAdapter implements PluginCurrentSessionInteractionsService {
    private readonly owner: CurrentSessionInteractionOwner;
    private readonly requester: InteractionTransientRequesterV1;

    constructor(params: NativeAgentSessionInteractionParams) {
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
        return await this.owner.request(request, {
            requester: options?.requester ?? this.requester,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.permissionContext === undefined
                ? {}
                : { presentationContext: Object.freeze({ permissionContext: options.permissionContext }) }),
        }) as InteractionResult;
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

export function createNativeAgentSessionServices(params: NativeAgentSessionInteractionParams): PluginServices {
    const base = createUnavailablePluginServices();
    const permissionHandler = readPermissionHandler(params);
    const currentSessionUi = params.currentSessionUi
        ?? createNativeAgentCurrentSessionUiServices({ ...params, permissionHandler });
    const interactions = createPluginInteractionsService({
        currentSession: currentSessionUi,
        signal: params.signal ?? new AbortController().signal,
        isGenerationCurrent: () => readPluginGenerationState(params.isCurrent) === 'current',
        ...(params.readActiveTurnAdmissionWitness
            ? { readActiveTurnAdmissionWitness: params.readActiveTurnAdmissionWitness }
            : {}),
        requester: Object.freeze({
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            generationId: params.immutableGenerationId ?? params.generationId,
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
        })
        : null;
    const inventory = params.credentials && params.isCurrent
        ? createPluginSessionsInventory({
            executeMessageAction: async ({ sessionId, request, signal }) => (
                await executePluginSessionMessageAction({
                    execute: async (actionId, input, context) => (
                        await messageActionExecutor!.execute(actionId, input, context)
                    ),
                    pluginId: params.pluginId,
                    contributionLocalId: params.contributionId,
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
                        immutableGenerationId: params.immutableGenerationId ?? params.generationId,
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
    const sessions = Object.freeze({ ...inventory });
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
        sessions,
        interactions,
    });
}
