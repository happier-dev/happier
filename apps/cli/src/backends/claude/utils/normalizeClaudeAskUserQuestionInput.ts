import { isAskUserQuestionToolName, type StructuredQuestionLike } from '@happier-dev/protocol';

import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';

/** Claude Code 2.1.310 uses choice previews only for single-select questions. */
export function isClaudeNativePreviewQuestion(question: StructuredQuestionLike): boolean {
    return question.multiSelect !== true && question.multiple !== true && Array.isArray(question.options)
        && question.options.some((option: unknown) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
            const preview = (option as Record<string, unknown>).preview;
            return typeof preview === 'string' && preview.trim().length > 0;
        });
}

/**
 * Produces the bounded AskUserQuestion snapshot published to Happier and adds
 * Claude Code's implicit freeform answer, except for native preview choices.
 * Their notes are annotations on a selected choice, not a freeform answer.
 *
 * This is a publication-only transformation. Callers must retain the original
 * provider input for the eventual response sent back to Claude.
 */
export function normalizeClaudeAskUserQuestionInputForPublication(
    toolName: string,
    toolInput: unknown,
    context?: Readonly<{ native: boolean }>,
): unknown {
    const normalized = normalizeAskUserQuestionInputForPublication(toolName, toolInput);
    if (!isAskUserQuestionToolName(toolName)) return normalized;

    const input = normalized as Record<string, unknown>;
    const questions = (input.questions as Record<string, unknown>[]).map((question) => (
        context?.native && isClaudeNativePreviewQuestion(question)
            ? { ...question, freeform: false }
            : typeof question.freeform === 'undefined'
            ? { ...question, freeform: {} }
            : question
    ));
    return { ...input, questions };
}
