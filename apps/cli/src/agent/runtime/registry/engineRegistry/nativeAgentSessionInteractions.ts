import type { PluginDiagnosticData, JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginServiceId, PluginSessionMediaService } from '@happier-dev/plugin-sdk/runtime';
import type {
    HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
    HostCurrentSessionUiServices,
    HostPluginServices,
    HostSessionApprovalRequest as PluginSessionApprovalRequest,
    HostSessionApprovalResult as PluginSessionApprovalResult,
    HostSessionChoiceAnswer as PluginSessionChoiceAnswer,
    HostSessionConfirmationRequest as PluginSessionConfirmationRequest,
    HostSessionConfirmationResult as PluginSessionConfirmationResult,
    HostSessionInteractionRequest as PluginSessionInteractionRequest,
    HostSessionInteractionOptions,
    HostSessionQuestion as PluginSessionQuestion,
    HostSessionQuestionAnswer as PluginSessionQuestionAnswer,
    HostSessionQuestionsRequest as PluginSessionQuestionsRequest,
    HostSessionQuestionsResult as PluginSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import {
    createUnavailableHostExternalSessionsService,
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import type { Credentials } from '@/persistence';
import { createPluginSessionsInventory } from '@/session/services/pluginSessionsInventory';
import { hostSubagentStore } from '@/session/subagents/hostSubagentStore';
import { createPluginSubagentsService } from '@/session/subagents/pluginSubagentsService';
import { createServerPluginSubagentDurableCustody } from '@/session/subagents/serverPluginSubagentDurableCustody';
import { createPluginExternalSessionsAdapter } from '@/session/external/pluginExternalSessionsAdapter';
import type { HostExternalSessionsService } from '@/session/external/privateContract';

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    if (typeof signal.reason === 'string' && signal.reason.trim().length > 0) {
        throw new Error(signal.reason.trim());
    }
    throw new Error('Agent session interaction canceled');
}

function combineInteractionSignal(
    sessionSignal: AbortSignal | undefined,
    callerSignal: AbortSignal | undefined,
): AbortSignal | undefined {
    if (!sessionSignal) return callerSignal;
    if (!callerSignal || callerSignal === sessionSignal) return sessionSignal;
    return AbortSignal.any([sessionSignal, callerSignal]);
}

type InteractionResult =
    | PluginSessionApprovalResult
    | PluginSessionQuestionsResult
    | PluginSessionConfirmationResult;

type QuestionAnswerWireValue = string | readonly string[];
type QuestionAnswersWire = Readonly<Record<string, QuestionAnswerWireValue>>;

const unavailableDiagnostic = (
    message: string,
    code = 'agent_session_interaction_unavailable',
): PluginDiagnosticData => Object.freeze({
    code,
    severity: 'error',
    message,
});

function unavailable(
    request: { kind: InteractionResult['kind'] },
    message: string,
    code?: string,
): InteractionResult {
    return Object.freeze({
        kind: request.kind,
        status: 'unavailable',
        diagnostic: unavailableDiagnostic(message, code),
    }) as InteractionResult;
}

function readAnswer(
    answers: QuestionAnswersWire,
    question: PluginSessionQuestion,
    questions: readonly PluginSessionQuestion[],
): QuestionAnswerWireValue | undefined {
    if (Object.prototype.hasOwnProperty.call(answers, question.id)) return answers[question.id];
    if (questions.filter((candidate) => candidate.prompt === question.prompt).length !== 1) return undefined;
    return answers[question.prompt];
}

function resolveChoice(
    raw: string,
    question: Extract<PluginSessionQuestion, { selection: 'single' | 'multiple' }>,
): PluginSessionChoiceAnswer | null {
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

function resolveDeclaredChoice(
    raw: string,
    question: Extract<PluginSessionQuestion, { selection: 'single' | 'multiple' }>,
): PluginSessionChoiceAnswer | null {
    const value = raw.trim();
    const byId = question.choices.find((choice) => choice.id === value);
    if (byId) return Object.freeze({ kind: 'choice', choiceId: byId.id });
    const byLabel = question.choices.filter((choice) => choice.label === value);
    return byLabel.length === 1
        ? Object.freeze({ kind: 'choice', choiceId: byLabel[0]!.id })
        : null;
}

function normalizeQuestionAnswers(
    request: PluginSessionQuestionsRequest,
    rawAnswers: QuestionAnswersWire,
): readonly PluginSessionQuestionAnswer[] | null {
    const promptCounts = new Map<string, number>();
    for (const question of request.questions) {
        promptCounts.set(question.prompt, (promptCounts.get(question.prompt) ?? 0) + 1);
    }
    const ownersByAnswerKey = new Map<string, Set<string>>();
    const addOwner = (key: string, questionId: string) => {
        const owners = ownersByAnswerKey.get(key) ?? new Set<string>();
        owners.add(questionId);
        ownersByAnswerKey.set(key, owners);
    };
    for (const question of request.questions) {
        addOwner(question.id, question.id);
        if (promptCounts.get(question.prompt) === 1) addOwner(question.prompt, question.id);
    }
    for (const key of Object.keys(rawAnswers)) {
        if (ownersByAnswerKey.get(key)?.size !== 1) return null;
    }
    for (const question of request.questions) {
        if (
            question.id !== question.prompt
            && Object.prototype.hasOwnProperty.call(rawAnswers, question.id)
            && Object.prototype.hasOwnProperty.call(rawAnswers, question.prompt)
        ) return null;
    }
    const output: PluginSessionQuestionAnswer[] = [];
    for (const question of request.questions) {
        const rawAnswer = readAnswer(rawAnswers, question, request.questions);
        if (rawAnswer === undefined) {
            if (question.required) return null;
            continue;
        }
        const canonicalValues = Array.isArray(rawAnswer) ? rawAnswer : null;
        if (question.selection === 'text') {
            if (canonicalValues && canonicalValues.length !== 1) return null;
            const raw = canonicalValues ? canonicalValues[0]! : rawAnswer as string;
            const value = question.presentation.whitespace === 'trim' ? raw.trim() : raw;
            if (!question.presentation.allowEmpty && value.length === 0) return null;
            output.push(Object.freeze({ questionId: question.id, selection: 'text', value }));
            continue;
        }
        if (question.selection === 'single') {
            if (canonicalValues && canonicalValues.length !== 1) return null;
            const raw = canonicalValues ? canonicalValues[0]! : rawAnswer as string;
            const answer = resolveChoice(raw, question);
            if (!answer) return null;
            output.push(Object.freeze({ questionId: question.id, selection: 'single', answer }));
            continue;
        }
        let values: readonly string[];
        if (canonicalValues) {
            values = canonicalValues;
        } else {
            const legacyRaw = rawAnswer as string;
            const wholeChoice = resolveDeclaredChoice(legacyRaw, question);
            values = wholeChoice
                ? [legacyRaw]
                : legacyRaw.split(',').map((value) => value.trim()).filter(Boolean);
        }
        const choices = values.map((value) => resolveChoice(value, question));
        if (choices.length === 0 || choices.some((choice) => choice === null)) return null;
        const dedupeKeys = choices.map((choice) => choice!.kind === 'choice'
            ? `choice:${choice!.choiceId}`
            : `custom:${choice!.value}`);
        if (new Set(dedupeKeys).size !== dedupeKeys.length) return null;
        output.push(Object.freeze({
            questionId: question.id,
            selection: 'multiple',
            answers: choices as [PluginSessionChoiceAnswer, ...PluginSessionChoiceAnswer[]],
        }));
    }
    return Object.freeze(output);
}

function toPermissionInput(request: PluginSessionApprovalRequest | PluginSessionQuestionsRequest | PluginSessionConfirmationRequest): unknown {
    if (request.kind === 'approval') {
        return Object.freeze({
            title: request.title,
            ...(request.description ? { description: request.description } : {}),
            subject: request.subject,
            ...(request.allowedPersistenceScopes
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
                ...(question.required === undefined ? {} : { required: question.required }),
                ...(question.selection === 'text'
                    ? { selection: question.selection, presentation: question.presentation }
                    : {
                        selection: question.selection,
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
    return Object.freeze({ title: request.title, message: request.message });
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isExactNonEmptyString(value: unknown): value is string {
    return isNonEmptyString(value) && value === value.trim();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    try {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    } catch {
        return false;
    }
}

function readKnownInteractionKind(value: unknown): InteractionResult['kind'] | null {
    try {
        if (!isRecord(value)) return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
        if (!descriptor || !('value' in descriptor)) return null;
        return descriptor.value === 'approval' || descriptor.value === 'questions' || descriptor.value === 'confirmation'
            ? descriptor.value
            : null;
    } catch {
        return null;
    }
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(record).every((key) => allowedKeys.has(key));
}

function readOptionalString(record: Readonly<Record<string, unknown>>, key: string): string | undefined | null {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    return typeof record[key] === 'string' ? record[key] : null;
}

function normalizeQuestion(value: unknown): PluginSessionQuestion | null {
    if (!isRecord(value)) return null;
    if (!isExactNonEmptyString(value.id) || !isNonEmptyString(value.prompt)) return null;
    if (value.required !== undefined && typeof value.required !== 'boolean') return null;
    if (value.selection === 'text') {
        if (!hasOnlyKeys(value, ['id', 'prompt', 'selection', 'required', 'presentation'])) return null;
        if (!isRecord(value.presentation) || !hasOnlyKeys(
            value.presentation,
            ['inputMode', 'placeholder', 'initialValue', 'whitespace', 'allowEmpty'],
        )) return null;
        if (value.presentation.inputMode !== 'singleLine' && value.presentation.inputMode !== 'multiLine') return null;
        if (value.presentation.whitespace !== 'preserve' && value.presentation.whitespace !== 'trim') return null;
        if (typeof value.presentation.allowEmpty !== 'boolean') return null;
        const placeholder = readOptionalString(value.presentation, 'placeholder');
        const initialValue = readOptionalString(value.presentation, 'initialValue');
        if (placeholder === null || initialValue === null) return null;
        return Object.freeze({
            id: value.id,
            prompt: value.prompt,
            selection: 'text',
            required: value.required ?? false,
            presentation: Object.freeze({
                inputMode: value.presentation.inputMode,
                whitespace: value.presentation.whitespace,
                allowEmpty: value.presentation.allowEmpty,
                ...(placeholder === undefined ? {} : { placeholder }),
                ...(initialValue === undefined ? {} : { initialValue }),
            }),
        });
    }
    if (value.selection !== 'single' && value.selection !== 'multiple') return null;
    if (!hasOnlyKeys(value, ['id', 'prompt', 'selection', 'required', 'choices', 'allowCustom'])) return null;
    if (value.allowCustom !== undefined && typeof value.allowCustom !== 'boolean') return null;
    if (!Array.isArray(value.choices) || value.choices.length === 0) return null;
    const ids = new Set<string>();
    const choices: Array<{ id: string; label: string; description?: string }> = [];
    for (const choice of value.choices) {
        if (!isRecord(choice) || !hasOnlyKeys(choice, ['id', 'label', 'description'])) return null;
        if (!isExactNonEmptyString(choice.id) || !isNonEmptyString(choice.label) || ids.has(choice.id)) return null;
        const description = readOptionalString(choice, 'description');
        if (description === null) return null;
        ids.add(choice.id);
        choices.push(Object.freeze({
            id: choice.id,
            label: choice.label,
            ...(description === undefined ? {} : { description }),
        }));
    }
    return Object.freeze({
        id: value.id,
        prompt: value.prompt,
        selection: value.selection,
        required: value.required ?? false,
        choices: choices as [{ id: string; label: string; description?: string }, ...{ id: string; label: string; description?: string }[]],
        allowCustom: value.allowCustom ?? false,
    });
}

function normalizeInteractionRequest(raw: unknown): PluginSessionInteractionRequest | null {
    const parsed = AgentRuntimeJsonValueV1Schema.safeParse(raw);
    if (!parsed.success || !isRecord(parsed.data)) return null;
    const value = parsed.data;
    if (!isExactNonEmptyString(value.requestId)) return null;
    if (value.kind === 'approval') {
        if (!hasOnlyKeys(value, ['kind', 'requestId', 'title', 'description', 'subject', 'allowedPersistenceScopes'])) return null;
        if (!isNonEmptyString(value.title) || !isRecord(value.subject)) return null;
        const description = readOptionalString(value, 'description');
        if (description === null) return null;
        let subject: PluginSessionApprovalRequest['subject'];
        if (value.subject.kind === 'tool') {
            if (
                !hasOnlyKeys(value.subject, ['kind', 'name', 'input'])
                || !isExactNonEmptyString(value.subject.name)
                || !Object.prototype.hasOwnProperty.call(value.subject, 'input')
            ) return null;
            subject = Object.freeze({ kind: 'tool', name: value.subject.name, input: value.subject.input as JsonValue });
        } else if (value.subject.kind === 'operation') {
            if (!hasOnlyKeys(value.subject, ['kind', 'label', 'input']) || !isNonEmptyString(value.subject.label)) return null;
            subject = Object.freeze({
                kind: 'operation',
                label: value.subject.label,
                ...(value.subject.input === undefined ? {} : { input: value.subject.input as JsonValue }),
            });
        } else {
            return null;
        }
        let allowedPersistenceScopes: PluginSessionApprovalRequest['allowedPersistenceScopes'];
        if (value.allowedPersistenceScopes !== undefined) {
            if (!Array.isArray(value.allowedPersistenceScopes) || value.allowedPersistenceScopes.length === 0) return null;
            const scopes = [...value.allowedPersistenceScopes].sort();
            if (scopes.some((scope) => scope !== 'session' && scope !== 'workspace' && scope !== 'account')) return null;
            if (new Set(scopes).size !== scopes.length) return null;
            allowedPersistenceScopes = scopes as unknown as PluginSessionApprovalRequest['allowedPersistenceScopes'];
        }
        return Object.freeze({
            kind: 'approval',
            requestId: value.requestId,
            title: value.title,
            subject,
            ...(description === undefined ? {} : { description }),
            ...(allowedPersistenceScopes === undefined ? {} : { allowedPersistenceScopes }),
        });
    }
    if (value.kind === 'confirmation') {
        if (!hasOnlyKeys(value, ['kind', 'requestId', 'title', 'message'])) return null;
        return isNonEmptyString(value.title) && isNonEmptyString(value.message)
            ? Object.freeze({
                kind: 'confirmation', requestId: value.requestId, title: value.title, message: value.message,
            })
            : null;
    }
    if (value.kind !== 'questions') return null;
    if (!hasOnlyKeys(value, ['kind', 'requestId', 'title', 'questions'])) return null;
    const title = readOptionalString(value, 'title');
    if (title === null || !Array.isArray(value.questions) || value.questions.length === 0) return null;
    const questions = value.questions.map(normalizeQuestion);
    if (questions.some((question) => question === null)) return null;
    const ids = questions.map((question) => question!.id);
    if (new Set(ids).size !== ids.length) return null;
    return Object.freeze({
        kind: 'questions',
        requestId: value.requestId,
        ...(title === undefined ? {} : { title }),
        questions: questions as [PluginSessionQuestion, ...PluginSessionQuestion[]],
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
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    credentials?: Credentials;
    externalSessions?: HostExternalSessionsService;
    media?: PluginSessionMediaService;
    presentation?: HostCurrentSessionUiServices['presentation'];
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

class NativeAgentSessionInteractions implements PluginCurrentSessionInteractionsService {
    constructor(private readonly params: NativeAgentSessionInteractionParams) {}

    request(request: PluginSessionApprovalRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionApprovalResult>;
    request(request: PluginSessionQuestionsRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionQuestionsResult>;
    request(request: PluginSessionConfirmationRequest, options?: HostSessionInteractionOptions): Promise<PluginSessionConfirmationResult>;
    async request(
        rawRequest: PluginSessionApprovalRequest | PluginSessionQuestionsRequest | PluginSessionConfirmationRequest,
        options?: HostSessionInteractionOptions,
    ): Promise<InteractionResult> {
        const requestKind = readKnownInteractionKind(rawRequest);
        const request = normalizeInteractionRequest(rawRequest);
        if (!request) {
            return unavailable(
                { kind: requestKind ?? 'approval' },
                'The Agent supplied a malformed current-session interaction request',
            );
        }
        const initialGenerationState = readPluginGenerationState(this.params.isCurrent);
        if (initialGenerationState === 'retired') {
            return unavailable(request, 'The Agent runtime generation is no longer current');
        }
        if (initialGenerationState === 'unverifiable') {
            return unavailable(request, 'The Agent runtime generation cannot be verified');
        }
        if (!this.params.permissionHandler) {
            return unavailable(request, 'The current host session cannot present Agent interactions');
        }
        const signal = combineInteractionSignal(this.params.signal, options?.signal);
        throwIfSignalAborted(signal);
        return await this.invokeBoundRequest(request, signal, options?.permissionContext);
    }

    private async invokeBoundRequest(
        request: PluginSessionInteractionRequest,
        signal?: AbortSignal,
        permissionContext?: HostSessionInteractionOptions['permissionContext'],
    ): Promise<InteractionResult> {
        const permissionHandler = this.params.permissionHandler;
        if (!permissionHandler) {
            return unavailable(request, 'The current host session cannot present Agent interactions');
        }
        const dispatchGenerationState = readPluginGenerationState(this.params.isCurrent);
        if (dispatchGenerationState === 'retired') {
            return unavailable(request, 'The Agent runtime generation retired before interaction presentation');
        }
        if (dispatchGenerationState === 'unverifiable') {
            return unavailable(request, 'The Agent runtime generation cannot be verified');
        }
        const toolName = request.kind === 'approval'
            ? request.subject.kind === 'tool' ? request.subject.name : 'AgentOperationApproval'
            : request.kind === 'questions' ? 'AskUserQuestion' : 'AgentConfirmation';
        let result: Awaited<ReturnType<ProviderEnforcedPermissionHandler['handleToolCall']>>;
        try {
            result = await permissionHandler.handleToolCall(
                request.requestId,
                toolName,
                toPermissionInput(request),
                {
                    ...(permissionContext ?? {}),
                    owner: { kind: 'plugin', pluginId: this.params.pluginId, runtimeId: this.params.runtimeId },
                    signal,
                },
            );
        } catch {
            if (signal?.aborted) {
                return Object.freeze({ kind: request.kind, status: 'cancelled' }) as InteractionResult;
            }
            return unavailable(request, 'The current host session interaction failed');
        }
        const completedGenerationState = readPluginGenerationState(this.params.isCurrent);
        if (completedGenerationState === 'retired') {
            return unavailable(request, 'The Agent runtime generation retired before the interaction completed');
        }
        if (completedGenerationState === 'unverifiable') {
            return unavailable(request, 'The Agent runtime generation cannot be verified');
        }
        const parsedResult = AgentRuntimeJsonValueV1Schema.safeParse(result);
        if (!parsedResult.success || !isRecord(parsedResult.data) || typeof parsedResult.data.decision !== 'string') {
            return unavailable(request, 'The host returned a malformed interaction decision');
        }
        if (parsedResult.data.execPolicyAmendment !== undefined) {
            return unavailable(request, 'The host interaction includes an exec-policy effect that has no public SVC10 mapping');
        }
        const decision = parsedResult.data.decision;
        if (request.kind === 'approval') {
            if (decision === 'abort') return Object.freeze({ kind: 'approval', status: 'cancelled' });
            if (decision === 'denied') {
                const rationale = readOptionalString(parsedResult.data, 'rationale');
                if (rationale === null) {
                    return unavailable(request, 'The host returned a malformed approval rationale') as PluginSessionApprovalResult;
                }
                return Object.freeze({
                    kind: 'approval',
                    status: 'denied',
                    ...(rationale === undefined ? {} : { rationale }),
                });
            }
            if (decision !== 'approved' && decision !== 'approved_for_session' && decision !== 'approved_execpolicy_amendment') {
                return unavailable(request, 'The host returned an invalid approval decision') as PluginSessionApprovalResult;
            }
            if (decision === 'approved_execpolicy_amendment') {
                return unavailable(request, 'The host approval includes effects that have no public SVC10 mapping') as PluginSessionApprovalResult;
            }
            const toolNameForPersistence = request.subject.kind === 'tool' ? request.subject.name : undefined;
            const canPersistSession = decision === 'approved_for_session'
                && request.allowedPersistenceScopes?.includes('session');
            if (decision === 'approved_for_session' && !canPersistSession) {
                return unavailable(request, 'The host approved persistence outside the request allowed scopes') as PluginSessionApprovalResult;
            }
            return Object.freeze({
                kind: 'approval',
                status: 'approved',
                ...(canPersistSession
                    ? {
                        effects: Object.freeze({
                            persistApprovals: [Object.freeze({
                                scope: 'session' as const,
                                ...(toolNameForPersistence ? { toolName: toolNameForPersistence } : {}),
                            })] as const,
                        }),
                    }
                    : {}),
            });
        }
        if (request.kind === 'questions') {
            if (decision === 'abort' || decision === 'denied') {
                return Object.freeze({ kind: 'questions', status: 'cancelled' });
            }
            if (decision !== 'approved' || !isRecord(parsedResult.data.answers)) {
                return unavailable(request, 'The host did not return structured answers') as PluginSessionQuestionsResult;
            }
            const answerEntries = Object.entries(parsedResult.data.answers);
            const allLegacyScalars = answerEntries.every((entry) => typeof entry[1] === 'string');
            const allStructuredArrays = answerEntries.every((entry) => (
                Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string')
            ));
            if (!allLegacyScalars && !allStructuredArrays) {
                return unavailable(request, 'The host returned malformed structured answers') as PluginSessionQuestionsResult;
            }
            const answers = normalizeQuestionAnswers(
                request,
                Object.fromEntries(answerEntries) as Record<string, QuestionAnswerWireValue>,
            );
            return answers
                ? Object.freeze({ kind: 'questions', status: 'answered', answers })
                : unavailable(request, 'The host returned malformed structured answers') as PluginSessionQuestionsResult;
        }
        if (decision === 'abort') return Object.freeze({ kind: 'confirmation', status: 'cancelled' });
        if (decision !== 'approved' && decision !== 'denied') {
            return unavailable(request, 'The host returned effects for an effect-free confirmation') as PluginSessionConfirmationResult;
        }
        return Object.freeze({
            kind: 'confirmation',
            status: 'answered',
            confirmed: decision === 'approved',
        });
    }
}

export function createNativeAgentCurrentSessionUiServices(
    params: NativeAgentSessionInteractionParams,
): HostCurrentSessionUiServices {
    return Object.freeze({
        interactions: Object.freeze(new NativeAgentSessionInteractions(params)),
        ...(params.presentation ? { presentation: params.presentation } : {}),
    });
}

export function createNativeAgentSessionServices(params: NativeAgentSessionInteractionParams): HostPluginServices {
    const base = createUnavailablePluginServices();
    const permissionHandler = params.permissionHandler
        && typeof params.permissionHandler.handleToolCall === 'function'
        ? params.permissionHandler
        : null;
    const currentSessionUi = createNativeAgentCurrentSessionUiServices({ ...params, permissionHandler });
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
    const inventory = params.credentials && params.isCurrent
        ? createPluginSessionsInventory({
            credentials: params.credentials,
            currentSessionId: params.sessionId,
            isCurrent: params.isCurrent,
        })
        : base.sessions;
    const current = Object.freeze({
        ...inventory.current,
        availability: readSessionAvailability,
        ...(params.media ? { media: params.media } : {}),
        ...currentSessionUi,
    });
    const subagents = params.isCurrent
        ? createPluginSubagentsService({
            store: hostSubagentStore,
            identity: {
                pluginId: params.pluginId,
                contributionId: params.contributionId,
                immutableGenerationId: params.immutableGenerationId ?? params.generationId,
                parentSessionId: params.sessionId,
            },
            isCurrent: params.isCurrent,
            ...(params.credentials && params.immutableGenerationId ? {
                durableCustody: createServerPluginSubagentDurableCustody({
                    credentials: params.credentials,
                    identity: {
                        pluginId: params.pluginId,
                        contributionId: params.contributionId,
                        immutableGenerationId: params.immutableGenerationId,
                        parentSessionId: params.sessionId,
                    },
                }),
            } : {}),
        })
        : base.sessions.subagents;
    const external = params.externalSessions ?? (params.isCurrent
        ? createPluginExternalSessionsAdapter({
            isCurrent: params.isCurrent,
            sources: [],
            resolveProviderOps: async () => null,
        })
        : createUnavailableHostExternalSessionsService());
    const sessions = Object.freeze({ ...inventory, current, subagents, external });
    return Object.freeze({
        ...base,
        availability: (serviceId: PluginServiceId) => serviceId === 'sessions'
            ? readSessionAvailability()
            : base.availability(serviceId),
        sessions,
    });
}
