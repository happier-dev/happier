import { randomUUID } from 'node:crypto';

import { PluginError, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { type PluginInvocationUi, type PluginUiApprovalRequest, type PluginUiApprovalResult, type PluginUiChoiceAnswer, type PluginUiQuestion, type PluginUiQuestionAnswer, type PluginUiQuestionsResult, type PluginUiSeverity, type PluginUiWidget } from '@happier-dev/plugin-sdk/runtime';
import type {
    HostCurrentSessionUiServices as CurrentSessionUiServices,
    HostSessionApprovalResult,
    HostSessionQuestion,
    HostSessionQuestionAnswer,
    HostSessionPresentationOneShotResult,
    HostSessionPresentationStatefulResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

type PresentationResult = HostSessionPresentationOneShotResult | HostSessionPresentationStatefulResult;
type CurrentSessionUiBinding = Readonly<{
    interactions?: CurrentSessionUiServices['interactions'];
    presentation?: CurrentSessionUiServices['presentation'];
}>;

function throwUiError(
    code: string,
    message: string,
    diagnostic?: PluginDiagnosticData,
): never {
    throw new PluginError({
        code,
        message: diagnostic?.message ?? message,
        ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    });
}

function assertPresentationApplied(result: PresentationResult): void {
    if (result.status === 'applied' || result.status === 'unchanged') return;
    if (result.status === 'outcomeUnknown') {
        throwUiError(
            'plugin_ui_outcome_unknown',
            'The host may have applied the UI request without returning a conclusive acknowledgement',
            result.diagnostic,
        );
    }
    if (result.status === 'conflict') {
        throwUiError('plugin_ui_conflict', 'The host rejected the UI request because its target changed', result.diagnostic);
    }
    throwUiError(
        'plugin_ui_unavailable',
        'The requested UI operation is unavailable',
        'diagnostic' in result ? result.diagnostic : undefined,
    );
}

function createUnavailableUi(): PluginInvocationUi {
    const fail = async (): Promise<never> => throwUiError(
        'plugin_ui_unavailable',
        'Plugin UI requires a bound current session with available host UI services',
    );
    return Object.freeze({
        requestApproval: async () => Object.freeze({
            status: 'unavailable' as const,
            diagnostic: Object.freeze({
                code: 'plugin_ui_unavailable',
                severity: 'error' as const,
                message: 'Plugin UI requires a bound current session with available host UI services',
            }),
        }),
        askQuestions: async () => Object.freeze({
            status: 'unavailable' as const,
            diagnostic: Object.freeze({
                code: 'plugin_ui_unavailable',
                severity: 'error' as const,
                message: 'Plugin UI requires a bound current session with available host UI services',
            }),
        }),
        confirm: fail,
        notify: fail,
        status: Object.freeze({ set: fail }),
        widget: Object.freeze({ set: fail }),
        title: Object.freeze({ set: fail }),
        composer: Object.freeze({ replace: fail }),
    });
}

function approvalUnavailable(message: string): PluginUiApprovalResult {
    return Object.freeze({
        status: 'unavailable',
        diagnostic: Object.freeze({
            code: 'plugin_ui_approval_unavailable',
            severity: 'error',
            message,
        }),
    });
}

function questionsUnavailable(message: string): PluginUiQuestionsResult {
    return Object.freeze({
        status: 'unavailable',
        diagnostic: Object.freeze({
            code: 'plugin_ui_questions_unavailable',
            severity: 'error',
            message,
        }),
    });
}

function toPublicApprovalResult(
    request: PluginUiApprovalRequest,
    result: HostSessionApprovalResult,
): PluginUiApprovalResult {
    if (result.status === 'denied') {
        return Object.freeze({
            status: 'denied',
            ...(result.rationale === undefined ? {} : { rationale: result.rationale }),
        });
    }
    if (result.status === 'cancelled') {
        return Object.freeze({
            status: 'cancelled',
            ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
        });
    }
    if (result.status === 'unavailable') {
        return Object.freeze({ status: 'unavailable', diagnostic: result.diagnostic });
    }
    if (result.effects === undefined) {
        return Object.freeze({ status: 'approved', persistence: 'once' });
    }
    const effectKeys = Object.keys(result.effects);
    const persistence = result.effects.persistApprovals;
    if (
        request.allowSessionPersistence !== true
        || effectKeys.length !== 1
        || effectKeys[0] !== 'persistApprovals'
        || !Array.isArray(persistence)
        || persistence.length !== 1
        || persistence[0]?.scope !== 'session'
        || persistence[0].toolName !== request.subject.name
    ) {
        return approvalUnavailable('The host returned approval effects outside the requested tool session scope');
    }
    return Object.freeze({ status: 'approved', persistence: 'session' });
}

function toHostQuestion(question: PluginUiQuestion): HostSessionQuestion {
    if (question.type === 'text') {
        return Object.freeze({
            id: question.id,
            prompt: question.prompt,
            selection: 'text',
            ...(question.required === undefined ? {} : { required: question.required }),
            presentation: Object.freeze({
                inputMode: 'singleLine' as const,
                whitespace: 'preserve' as const,
                allowEmpty: false,
            }),
        });
    }
    return Object.freeze({
        id: question.id,
        prompt: question.prompt,
        selection: question.type,
        ...(question.required === undefined ? {} : { required: question.required }),
        choices: question.choices.map((choice) => Object.freeze({
            id: choice.id,
            label: choice.label ?? choice.id,
            ...(choice.description === undefined ? {} : { description: choice.description }),
        })) as [
            { id: string; label: string; description?: string },
            ...{ id: string; label: string; description?: string }[],
        ],
        ...(question.allowCustom === undefined ? {} : { allowCustom: question.allowCustom }),
    });
}

function toPublicChoiceAnswer(
    answer: Extract<HostSessionQuestionAnswer, { selection: 'single' }>['answer'],
): PluginUiChoiceAnswer {
    return answer.kind === 'choice'
        ? Object.freeze({ type: 'choice', choiceId: answer.choiceId })
        : Object.freeze({ type: 'custom', value: answer.value });
}

function toPublicQuestionAnswer(answer: HostSessionQuestionAnswer): PluginUiQuestionAnswer {
    if (answer.selection === 'text') {
        return Object.freeze({ type: 'text', value: answer.value });
    }
    if (answer.selection === 'single') {
        return Object.freeze({ type: 'single', answer: toPublicChoiceAnswer(answer.answer) });
    }
    return Object.freeze({
        type: 'multiple',
        answers: answer.answers.map(toPublicChoiceAnswer) as [PluginUiChoiceAnswer, ...PluginUiChoiceAnswer[]],
    });
}

export function createPluginInvocationUi(params: Readonly<{
    currentSession: CurrentSessionUiBinding | null;
    signal: AbortSignal;
    isGenerationCurrent: () => boolean;
    createOperationId?: () => string;
}>): PluginInvocationUi {
    if (!params.currentSession) return createUnavailableUi();

    const createOperationId = params.createOperationId ?? randomUUID;
    const options = Object.freeze({ signal: params.signal });
    const currentSession = params.currentSession;
    const assertCurrent = (): void => {
        let current = false;
        try {
            current = !params.signal.aborted && params.isGenerationCurrent();
        } catch {
            current = false;
        }
        if (!current) {
            throwUiError(
                'plugin_ui_generation_retired',
                'The plugin generation is no longer current',
            );
        }
    };

    return Object.freeze({
        async requestApproval(request: PluginUiApprovalRequest): Promise<PluginUiApprovalResult> {
            if (!currentSession.interactions) {
                return approvalUnavailable('The requested UI approval interaction is unavailable');
            }
            let result: HostSessionApprovalResult;
            try {
                assertCurrent();
                result = await currentSession.interactions.request({
                    kind: 'approval',
                    requestId: createOperationId(),
                    title: request.title,
                    ...(request.description === undefined ? {} : { description: request.description }),
                    subject: request.subject,
                    ...(request.allowSessionPersistence === true
                        ? { allowedPersistenceScopes: ['session'] as const }
                        : {}),
                }, options);
            } catch {
                if (params.signal.aborted) {
                    return Object.freeze({ status: 'cancelled' });
                }
                return approvalUnavailable('The requested UI approval interaction failed');
            }
            return toPublicApprovalResult(request, result);
        },
        async askQuestions(
            questions: readonly [PluginUiQuestion, ...PluginUiQuestion[]],
            questionOptions?: Readonly<{ title?: string }>,
        ): Promise<PluginUiQuestionsResult> {
            if (!currentSession.interactions) {
                return questionsUnavailable('The requested UI questions interaction is unavailable');
            }
            let result;
            try {
                assertCurrent();
                result = await currentSession.interactions.request({
                    kind: 'questions',
                    requestId: createOperationId(),
                    ...(questionOptions?.title === undefined ? {} : { title: questionOptions.title }),
                    questions: questions.map(toHostQuestion) as [HostSessionQuestion, ...HostSessionQuestion[]],
                }, options);
            } catch {
                return params.signal.aborted
                    ? Object.freeze({ status: 'cancelled' })
                    : questionsUnavailable('The requested UI questions interaction failed');
            }
            if (result.status === 'cancelled') {
                return Object.freeze({
                    status: 'cancelled',
                    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
                });
            }
            if (result.status === 'unavailable') {
                return Object.freeze({ status: 'unavailable', diagnostic: result.diagnostic });
            }
            const answers = Object.create(null) as Record<string, PluginUiQuestionAnswer>;
            for (const answer of result.answers) {
                answers[answer.questionId] = toPublicQuestionAnswer(answer);
            }
            return Object.freeze({ status: 'answered', answers: Object.freeze(answers) });
        },
        async confirm(message: string, confirmOptions?: Readonly<{ title?: string }>) {
            assertCurrent();
            if (!currentSession.interactions) {
                throwUiError('plugin_ui_unavailable', 'The requested UI interaction is unavailable');
            }
            const result = await currentSession.interactions.request({
                kind: 'confirmation',
                requestId: createOperationId(),
                title: confirmOptions?.title ?? 'Confirmation',
                message,
            }, options);
            if (result.status === 'answered') return result.confirmed;
            if (result.status === 'cancelled') {
                throwUiError('plugin_ui_cancelled', 'The present user cancelled the UI request', result.diagnostic);
            }
            throwUiError('plugin_ui_unavailable', 'The requested UI interaction is unavailable', result.diagnostic);
        },
        async notify(message: string, notifyOptions?: Readonly<{ severity?: PluginUiSeverity }>) {
            assertCurrent();
            if (!currentSession.presentation) {
                throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
            }
            assertPresentationApplied(await currentSession.presentation.notify({
                operationId: createOperationId(),
                message,
                severity: notifyOptions?.severity ?? 'info',
            }, options));
        },
        status: Object.freeze({
            async set(key: string, text: string | null) {
                assertCurrent();
                if (!currentSession.presentation) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                assertPresentationApplied(await currentSession.presentation.setStatus({
                    operationId: createOperationId(),
                    key,
                    text,
                }, options));
            },
        }),
        widget: Object.freeze({
            async set(key: string, widget: PluginUiWidget | null) {
                assertCurrent();
                if (!currentSession.presentation) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                assertPresentationApplied(await currentSession.presentation.setWidget({
                    operationId: createOperationId(),
                    key,
                    placement: widget?.placement ?? 'beforeComposer',
                    lines: widget?.lines ?? null,
                }, options));
            },
        }),
        title: Object.freeze({
            async set(title: string | null) {
                assertCurrent();
                if (!currentSession.presentation) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                assertPresentationApplied(await currentSession.presentation.setSurfaceTitle({
                    operationId: createOperationId(),
                    title,
                }, options));
            },
        }),
        composer: Object.freeze({
            async replace(text: string) {
                assertCurrent();
                if (!currentSession.presentation) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                assertPresentationApplied(await currentSession.presentation.replaceComposerText({
                    operationId: createOperationId(),
                    text,
                }, options));
            },
        }),
    });
}
