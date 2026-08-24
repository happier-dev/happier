import {
    StructuredQuestionAnswersV1Schema,
    buildStructuredQuestionAnswerPayload,
    normalizeStructuredQuestionDescriptors,
    resolveStructuredQuestionOptionAnswerValue,
    type BuiltAskUserQuestionAnswerPayload,
} from '@happier-dev/protocol';

export type AskUserQuestionPayloadOption = Readonly<{
    label: string;
    value?: string;
    choice?: string;
    description?: string;
}>;

export type AskUserQuestionPayloadQuestion = Readonly<{
    id?: string;
    question?: unknown;
    header?: unknown;
    responseKey?: string;
    options?: ReadonlyArray<AskUserQuestionPayloadOption>;
    multiSelect: boolean;
    freeform?: Readonly<{
        placeholder?: string;
        description?: string;
        initialValue?: string;
        multiline?: boolean;
        allowEmpty?: boolean;
    }>;
}>;

export type NormalizeAskUserQuestionRenderQuestionsResult =
    | Readonly<{ ok: true; questions: ReadonlyArray<AskUserQuestionPayloadQuestion> }>
    | Readonly<{ ok: false }>;

/**
 * Converts possibly stale persisted tool input into a bounded render model.
 * This UI boundary is deliberately non-throwing: malformed/oversized historical
 * payloads render an unavailable state instead of being dereferenced by React.
 */
export function normalizeAskUserQuestionRenderQuestions(
    input: unknown,
): NormalizeAskUserQuestionRenderQuestionsResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
    const normalized = normalizeStructuredQuestionDescriptors((input as Record<string, unknown>).questions);
    if (!normalized.ok) return normalized;
    return {
        ok: true,
        questions: normalized.questions.map((question) => ({
            ...(question.id !== undefined ? { id: question.id } : {}),
            ...(question.question !== undefined ? { question: question.question } : {}),
            ...(question.header !== undefined ? { header: question.header } : {}),
            responseKey: question.responseKey,
            options: question.options.map(({ answerValue: _answerValue, ...option }) => option),
            multiSelect: question.multiSelect,
            ...(question.freeform !== undefined ? { freeform: question.freeform } : {}),
        })),
    };
}

export function buildAskUserQuestionAnswerPayload(params: Readonly<{
    questions: ReadonlyArray<AskUserQuestionPayloadQuestion>;
    selections: ReadonlyMap<number, ReadonlySet<number>>;
    freeformAnswers: ReadonlyMap<number, string>;
    structuredQuestionAnswersV1Supported: boolean;
}>): BuiltAskUserQuestionAnswerPayload {
    const rawAnswers = Object.create(null) as Record<string, readonly string[]>;
    for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex += 1) {
        const question = params.questions[questionIndex]!;
        const exactQuestion = typeof question.question === 'string' && question.question.trim().length > 0
            ? question.question
            : null;
        const exactHeader = typeof question.header === 'string' && question.header.trim().length > 0
            ? question.header
            : null;
        const key = question.responseKey ?? exactQuestion ?? exactHeader ?? '';
        const typed = params.freeformAnswers.get(questionIndex);
        if (question.freeform?.allowEmpty === true || (typeof typed === 'string' && typed.trim().length > 0)) {
            rawAnswers[key] = [typed ?? ''];
            continue;
        }
        const selected = params.selections.get(questionIndex);
        const options = Array.isArray(question.options) ? question.options : [];
        rawAnswers[key] = selected
            ? [...selected]
                .map((optionIndex) => resolveStructuredQuestionOptionAnswerValue(options[optionIndex]))
                .filter((value): value is string => value !== null)
            : [];
    }

    const structuredAnswersV1 = StructuredQuestionAnswersV1Schema.parse(rawAnswers);
    return buildStructuredQuestionAnswerPayload(
        structuredAnswersV1,
        params.structuredQuestionAnswersV1Supported,
    );
}

export type TryBuildAskUserQuestionAnswerPayloadResult =
    | Readonly<{ ok: true; payload: BuiltAskUserQuestionAnswerPayload }>
    | Readonly<{ ok: false }>;

/** Render-time validation must never throw; submission keeps the throwing builder as its typed boundary. */
export function tryBuildAskUserQuestionAnswerPayload(
    params: Parameters<typeof buildAskUserQuestionAnswerPayload>[0],
): TryBuildAskUserQuestionAnswerPayloadResult {
    try {
        return { ok: true, payload: buildAskUserQuestionAnswerPayload(params) };
    } catch {
        return { ok: false };
    }
}
