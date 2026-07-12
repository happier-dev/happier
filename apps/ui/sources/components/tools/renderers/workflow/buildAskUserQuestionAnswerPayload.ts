import {
    STRUCTURED_QUESTION_LIMITS,
    StructuredQuestionAnswersV1Schema,
    buildStructuredQuestionAnswerPayload,
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
    question?: unknown;
    header?: unknown;
    options?: ReadonlyArray<AskUserQuestionPayloadOption>;
    multiSelect: boolean;
    freeform?: Readonly<{ placeholder?: string; description?: string }>;
}>;

export type NormalizeAskUserQuestionRenderQuestionsResult =
    | Readonly<{ ok: true; questions: ReadonlyArray<AskUserQuestionPayloadQuestion> }>
    | Readonly<{ ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts possibly stale persisted tool input into a bounded render model.
 * This UI boundary is deliberately non-throwing: malformed/oversized historical
 * payloads render an unavailable state instead of being dereferenced by React.
 */
export function normalizeAskUserQuestionRenderQuestions(
    input: unknown,
): NormalizeAskUserQuestionRenderQuestionsResult {
    try {
        if (!isRecord(input) || !Array.isArray(input.questions)) return { ok: false };
        if (input.questions.length === 0 || input.questions.length > STRUCTURED_QUESTION_LIMITS.maxQuestions) {
            return { ok: false };
        }

        let totalStringLength = 0;
        const accountString = (value: unknown, optional = false): string | undefined => {
            if (value === undefined && optional) return undefined;
            if (typeof value !== 'string' || value.length > STRUCTURED_QUESTION_LIMITS.maxStringLength) {
                throw new Error('invalid structured-question string');
            }
            totalStringLength += value.length;
            if (totalStringLength > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) {
                throw new Error('structured-question render model exceeds bounds');
            }
            return value;
        };

        const seenKeys = new Set<string>();
        const questions = input.questions.map((rawQuestion): AskUserQuestionPayloadQuestion => {
            if (!isRecord(rawQuestion)) throw new Error('invalid structured question');
            const question = accountString(rawQuestion.question, true);
            const header = accountString(rawQuestion.header, true);
            const responseKey = question && question.trim().length > 0
                ? question
                : header && header.trim().length > 0
                    ? header
                    : null;
            if (!responseKey) throw new Error('missing structured-question key');

            const id = accountString(rawQuestion.id, true);
            for (const key of new Set([id, responseKey])) {
                if (!key || key.trim().length === 0) continue;
                if (seenKeys.has(key)) throw new Error('duplicate structured-question key');
                seenKeys.add(key);
            }

            const rawOptions = rawQuestion.options === undefined ? [] : rawQuestion.options;
            if (!Array.isArray(rawOptions) || rawOptions.length > STRUCTURED_QUESTION_LIMITS.maxOptionsPerQuestion) {
                throw new Error('invalid structured-question options');
            }
            const seenOptionValues = new Set<string>();
            const options = rawOptions.map((rawOption): AskUserQuestionPayloadOption => {
                if (typeof rawOption === 'string') {
                    const label = accountString(rawOption)!;
                    if (!label.trim() || seenOptionValues.has(label)) throw new Error('invalid structured-question option');
                    seenOptionValues.add(label);
                    return { label };
                }
                if (!isRecord(rawOption)) throw new Error('invalid structured-question option');
                const value = accountString(rawOption.value, true);
                const choice = accountString(rawOption.choice, true);
                const label = accountString(rawOption.label, true);
                const description = accountString(rawOption.description, true);
                const answerValue = resolveStructuredQuestionOptionAnswerValue({ value, choice, label });
                const displayLabel = label && label.trim().length > 0 ? label : answerValue;
                if (!answerValue || !displayLabel || seenOptionValues.has(answerValue)) {
                    throw new Error('invalid structured-question option');
                }
                seenOptionValues.add(answerValue);
                return {
                    label: displayLabel,
                    ...(value !== undefined ? { value } : {}),
                    ...(choice !== undefined ? { choice } : {}),
                    ...(description !== undefined ? { description } : {}),
                };
            });

            let freeform: AskUserQuestionPayloadQuestion['freeform'];
            if (rawQuestion.freeform === true) {
                freeform = {};
            } else if (rawQuestion.freeform !== undefined && rawQuestion.freeform !== false && rawQuestion.freeform !== null) {
                if (!isRecord(rawQuestion.freeform)) throw new Error('invalid structured-question freeform descriptor');
                const placeholder = accountString(rawQuestion.freeform.placeholder, true);
                const description = accountString(rawQuestion.freeform.description, true);
                freeform = {
                    ...(placeholder !== undefined ? { placeholder } : {}),
                    ...(description !== undefined ? { description } : {}),
                };
            }

            return {
                ...(question !== undefined ? { question } : {}),
                ...(header !== undefined ? { header } : {}),
                options,
                multiSelect: rawQuestion.multiSelect === true || rawQuestion.multiple === true,
                ...(freeform !== undefined ? { freeform } : {}),
            };
        });
        return { ok: true, questions };
    } catch {
        return { ok: false };
    }
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
        const key = exactQuestion ?? exactHeader ?? '';
        const typed = params.freeformAnswers.get(questionIndex);
        if (typeof typed === 'string' && typed.trim().length > 0) {
            rawAnswers[key] = [typed];
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
