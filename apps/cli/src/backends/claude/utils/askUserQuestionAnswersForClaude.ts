import { normalizeStructuredQuestionDescriptors, type StructuredQuestionAnswersV1, type StructuredQuestionLike } from '@happier-dev/protocol';

/**
 * Projects Happier's canonical lossless arrays to Claude Code's scalar
 * `AskUserQuestion.updatedInput.answers` contract. Claude historically encodes
 * multi-select answers by joining the exact values with `, `; Happier keeps the
 * arrays internally and performs that lossy provider-specific projection only
 * at the two Claude wire boundaries.
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

/** Native Claude emits checkbox values in option order and keys answers by provider text. */
export function buildNativeAskUserQuestionAnswersForClaude(
    questions: readonly StructuredQuestionLike[],
    answers: StructuredQuestionAnswersV1,
): Readonly<Record<string, string>> {
    const descriptors = normalizeStructuredQuestionDescriptors(questions);
    if (!descriptors.ok) throw new Error('invalid_native_question_descriptors');
    const ordered = Object.create(null) as Record<string, readonly string[]>;
    for (const question of descriptors.questions) {
        const selected = question.keys.flatMap((key) => answers[key] ? [answers[key]!] : [])[0] ?? [];
        ordered[question.responseKey] = [
            ...question.options.filter((option) => selected.includes(option.answerValue)).map((option) => option.label),
            ...selected.filter((value) => !question.options.some((option) => option.answerValue === value)),
        ];
    }
    return buildAskUserQuestionAnswersForClaude(ordered);
}
