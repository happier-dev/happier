import { buildAgentRequestSemanticSummary } from '@happier-dev/protocol';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

type DirectPermissionDecision = 'allow' | 'deny';

const ALLOW_OPTION_PATTERNS = [
    /\byes\b/i,
    /\bapprove\b/i,
    /\ballow\b/i,
    /\bgrant\b/i,
    /\bcreate\b/i,
    /\bcontinue\b/i,
    /\bproceed\b/i,
    /\bok\b/i,
];

const DENY_OPTION_PATTERNS = [
    /\bno\b/i,
    /\bdeny\b/i,
    /\breject\b/i,
    /\bdecline\b/i,
    /\bskip\b/i,
    /\bcancel\b/i,
    /\bstop\b/i,
    /\bdon't\b/i,
    /\bdo not\b/i,
    /\brequest changes\b/i,
];

function pickOptionLabel(options: readonly string[], decision: DirectPermissionDecision): string | null {
    const patterns = decision === 'allow' ? ALLOW_OPTION_PATTERNS : DENY_OPTION_PATTERNS;
    for (const option of options) {
        if (patterns.some((pattern) => pattern.test(option))) {
            return option;
        }
    }

    if (options.length === 2) {
        return decision === 'allow' ? options[0] ?? null : options[1] ?? null;
    }

    return null;
}

export function resolveAskUserQuestionDecisionAnswers(
    request: PendingPermissionRequest | null | undefined,
    decision: DirectPermissionDecision,
): ReadonlyArray<Readonly<{ question: string; values: readonly string[] }>> | null {
    if (!request || typeof request.tool !== 'string') return null;
    const questions = buildAgentRequestSemanticSummary({
        kind: 'user_action',
        toolName: request.tool,
        toolInput: request.arguments,
    }).questions;
    if (questions.length === 0) return null;

    const answers: Array<Readonly<{ question: string; values: readonly string[] }>> = [];
    for (const questionSummary of questions) {
        const question = questionSummary.question;
        const options = questionSummary.choices.map((choice) => choice.label);
        if (!question || options.length === 0) return null;

        const answer = pickOptionLabel(options, decision);
        if (!answer) return null;
        answers.push({ question, values: [answer] });
    }

    return answers.length > 0 ? answers : null;
}
