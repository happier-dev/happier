import { normalizeStructuredQuestionDescriptors, type StructuredQuestionAnswersV1, type StructuredQuestionLike } from '@happier-dev/protocol';

/**
 * Projects Happier's canonical lossless arrays to Claude Code's scalar
 * `AskUserQuestion.updatedInput.answers` contract. Claude historically encodes
 * multi-select answers by joining the exact values with `, `; Happier keeps the
 * arrays internally and performs that lossy provider-specific projection only
 * at the hook wire boundaries.
 */
export function buildAskUserQuestionAnswersForClaude(
    answers: StructuredQuestionAnswersV1,
): Readonly<Record<string, string>> {
    const projected = Object.create(null) as Record<string, string>;
    for (const [question, values] of Object.entries(answers)) {
        projected[question] = values.join(', ');
    }
    return Object.freeze(projected);
}

/** Native Claude emits option-ordered, JSON-quoted checkbox values, keyed by provider text. */
export function buildNativeAskUserQuestionAnswersForClaude(
    questions: readonly StructuredQuestionLike[],
    answers: StructuredQuestionAnswersV1,
): Readonly<Record<string, string>> {
    const descriptors = normalizeStructuredQuestionDescriptors(questions);
    if (!descriptors.ok) throw new Error('invalid_native_question_descriptors');
    const projected = Object.create(null) as Record<string, string>;
    for (const question of descriptors.questions) {
        const selected = question.keys.flatMap((key) => answers[key] ? [answers[key]!] : [])[0] ?? [];
        const values = [
            ...question.options.filter((option) => selected.includes(option.answerValue)).map((option) => option.label),
            ...selected.filter((value) => !question.options.some((option) => option.answerValue === value)),
        ];
        // Claude Code 2.1.316 uses this encoding in both its review and tool result.
        projected[question.responseKey] = question.multiSelect
            ? values.map((value) => value.includes(', ') || value.includes('"') ? JSON.stringify(value) : value).join(', ')
            : values.join(', ');
    }
    return Object.freeze(projected);
}
