import type {
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';
import { buildAgentRequestSemanticSummary } from '@happier-dev/protocol/activity/agentRequestSummary';
import { StructuredQuestionAnswersV1Schema, isStructuredQuestionSelectionCountValid, type StructuredQuestionAnswerDetailsV1, type StructuredQuestionAnswersV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';

export type QuestionAnswerWireValue = string | readonly string[];
type QuestionAnswersWire = Readonly<Record<string, QuestionAnswerWireValue>>;

function resolveChoiceSelection(
    raw: string,
    question: Extract<InteractionTransientQuestionV1, { type: 'singleChoice' | 'multipleChoice' }>,
    allowCustom = question.allowCustom,
) {
    const value = raw.trim();
    const byId = question.choices.find((choice) => choice.id === value);
    if (byId) return Object.freeze({ kind: 'choice', choiceId: byId.id });
    const byLabel = question.choices.filter((choice) => choice.label === value);
    if (byLabel.length === 1) return Object.freeze({ kind: 'choice', choiceId: byLabel[0]!.id });
    if (byLabel.length > 1) return null;
    return allowCustom && value.length > 0
        ? Object.freeze({ kind: 'custom', value })
        : null;
}

/** One form-answer owner for native interactions and persisted question responses. */
export function normalizeQuestionAnswers(
    questions: readonly InteractionTransientQuestionV1[],
    rawAnswers: QuestionAnswersWire,
    answerDetails?: StructuredQuestionAnswerDetailsV1,
): Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null {
    const byId = new Map(questions.map((question) => [question.id, question]));
    if (byId.size !== questions.length) return null;
    if (Object.keys(rawAnswers).some((questionId) => !byId.has(questionId))) return null;
    if (answerDetails && Object.keys(answerDetails).some((questionId) => !byId.has(questionId))) return null;
    const output = Object.create(null) as Record<string, InteractionTransientQuestionAnswerV1>;
    for (const question of questions) {
        const rawAnswer = rawAnswers[question.id];
        const detail = answerDetails?.[question.id];
        if (rawAnswer === undefined) {
            if (question.required) return null;
            continue;
        }
        const values = typeof rawAnswer === 'string' ? [rawAnswer] : rawAnswer;
        if (detail?.note !== undefined && !question.allowNote) return null;
        const note = detail?.note === undefined ? {} : { note: detail.note };
        if (question.type === 'text') {
            if (values.length !== 1) return null;
            output[question.id] = Object.freeze({ kind: 'text', value: values[0]!, ...note });
            continue;
        }
        if (detail?.freeText !== undefined && !question.allowCustom) return null;
        const custom = detail?.freeText === undefined ? [] : [{ kind: 'custom' as const, value: detail.freeText }];
        if (question.type === 'singleChoice') {
            if (values.length + custom.length !== 1) return null;
            const answer = custom[0] ?? resolveChoiceSelection(values[0]!, question, detail ? false : question.allowCustom);
            if (!answer) return null;
            if (!isStructuredQuestionSelectionCountValid(question, answer.kind === 'choice' ? 1 : 0)) return null;
            output[question.id] = Object.freeze({ kind: 'singleChoice', answer, ...note });
            continue;
        }
        const choices = [...values.map((value) => resolveChoiceSelection(value, question, detail ? false : question.allowCustom)), ...custom];
        if ((choices.length === 0 && question.minSelections !== 0) || choices.some((choice) => choice === null)) return null;
        if (!isStructuredQuestionSelectionCountValid(question, choices.filter((choice) => choice?.kind === 'choice').length)) return null;
        const dedupeKeys = choices.map((choice) => choice!.kind === 'choice'
            ? `choice:${choice!.choiceId}`
            : `custom:${choice!.value}`);
        if (new Set(dedupeKeys).size !== dedupeKeys.length) return null;
        output[question.id] = Object.freeze({
            kind: 'multipleChoice',
            answers: choices as NonNullable<typeof choices[number]>[],
            ...note,
        });
    }
    return Object.freeze(output);
}

/** Adapt the incumbent persisted/legacy form to the same native answer owner. */
export function normalizeStructuredQuestionPermissionAnswers(input: Readonly<{
    toolName: string;
    toolInput: unknown;
    answers: QuestionAnswersWire;
    answerDetails?: StructuredQuestionAnswerDetailsV1;
}>): StructuredQuestionAnswersV1 | null {
    const questions = readStructuredQuestionPermissionQuestions(input);
    if (questions.length === 0) return null;
    const normalized = normalizeQuestionAnswers(questions, input.answers, input.answerDetails);
    if (!normalized) return null;
    const answers = Object.fromEntries(Object.entries(normalized).map(([id, answer]) => {
        if (answer.kind === 'text') return [id, [answer.value]];
        const selections = answer.kind === 'singleChoice' ? [answer.answer] : answer.answers;
        return [id, selections.flatMap((selection) => selection.kind === 'choice'
            ? [selection.choiceId]
            : input.answerDetails?.[id] ? [] : [selection.value])];
    }));
    const parsed = StructuredQuestionAnswersV1Schema.safeParse(answers);
    return parsed.success ? parsed.data : null;
}

/** The same normalized form drives answers and the manager's question offer. */
export function readStructuredQuestionPermissionQuestions(input: Readonly<{
    toolName: string;
    toolInput: unknown;
}>): InteractionTransientQuestionV1[] {
    const semantic = buildAgentRequestSemanticSummary({ kind: 'user_action', toolName: input.toolName, toolInput: input.toolInput });
    return semantic.questions.map((question) => {
        const common = { id: question.answerKey, prompt: question.question, required: question.required,
            ...(question.allowNote === undefined ? {} : { allowNote: question.allowNote }) };
        return question.selection === 'text' || (question.selection === 'single' && question.choices.length === 0)
            ? { ...common, type: 'text' }
            : { ...common, type: question.selection === 'multiple' ? 'multipleChoice' : 'singleChoice',
                allowCustom: question.allowCustom,
                ...(question.minSelections === undefined ? {} : { minSelections: question.minSelections }),
                ...(question.maxSelections === undefined ? {} : { maxSelections: question.maxSelections }),
                choices: question.choices.map((choice) => ({ id: choice.value, label: choice.label,
                    ...(choice.description ? { description: choice.description } : {}) })) };
    });
}
