import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

type DirectPermissionDecision = 'allow' | 'deny';

type AskUserQuestionOptionLike = Readonly<{
    label?: unknown;
}>;

type AskUserQuestionLike = Readonly<{
    question?: unknown;
    options?: unknown;
}>;

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

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

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
): ReadonlyArray<Readonly<{ question: string; answer: string }>> | null {
    if (!request || request.tool !== 'AskUserQuestion') return null;

    const questions = Array.isArray((request.arguments as { questions?: unknown })?.questions)
        ? ((request.arguments as { questions: readonly AskUserQuestionLike[] }).questions ?? [])
        : [];
    if (questions.length === 0) return null;

    const answers: Array<Readonly<{ question: string; answer: string }>> = [];
    for (const rawQuestion of questions) {
        const question = normalizeText(rawQuestion?.question);
        const options = Array.isArray(rawQuestion?.options)
            ? (rawQuestion.options as readonly AskUserQuestionOptionLike[])
                  .map((option) => normalizeText(option?.label))
                  .filter((label) => label.length > 0)
            : [];
        if (!question || options.length === 0) return null;

        const answer = pickOptionLabel(options, decision);
        if (!answer) return null;
        answers.push({ question, answer });
    }

    return answers.length > 0 ? answers : null;
}
