import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import {
    isAskUserQuestionToolName,
    normalizeStructuredQuestionDescriptors,
} from '@happier-dev/protocol';

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

type DecisionOption = Readonly<{
    displayLabel: string;
    answerValue: string;
}>;

function pickOption(options: readonly DecisionOption[], decision: DirectPermissionDecision): DecisionOption | null {
    const patterns = decision === 'allow' ? ALLOW_OPTION_PATTERNS : DENY_OPTION_PATTERNS;
    for (const option of options) {
        if (patterns.some((pattern) => pattern.test(option.displayLabel))) {
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
    if (!request || !isAskUserQuestionToolName(request.tool)) return null;

    const questions = normalizeStructuredQuestionDescriptors(
        (request.arguments as { questions?: unknown })?.questions,
    );
    if (!questions.ok) return null;

    const answers: Array<Readonly<{ question: string; values: readonly string[] }>> = [];
    for (const question of questions.questions) {
        const options = question.options.map((option) => ({
            displayLabel: option.label.trim(),
            answerValue: option.answerValue,
        }));
        if (options.length === 0) return null;

        const answer = pickOption(options, decision);
        if (!answer) return null;
        answers.push({ question: question.responseKey, values: [answer.answerValue] });
    }

    return answers.length > 0 ? answers : null;
}
