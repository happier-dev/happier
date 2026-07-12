import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';

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
