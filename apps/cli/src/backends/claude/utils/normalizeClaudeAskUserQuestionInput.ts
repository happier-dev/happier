import { isAskUserQuestionToolName } from '@happier-dev/protocol';

import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';

/**
 * Produces the bounded AskUserQuestion snapshot published to Happier and adds
 * Claude Code's implicit freeform answer. Claude's terminal always offers this
 * escape hatch, but its tool input does not encode it explicitly.
 *
 * This is a publication-only transformation. Callers must retain the original
 * provider input for the eventual response sent back to Claude.
 */
export function normalizeClaudeAskUserQuestionInputForPublication(
    toolName: string,
    toolInput: unknown,
): unknown {
    const normalized = normalizeAskUserQuestionInputForPublication(toolName, toolInput);
    if (!isAskUserQuestionToolName(toolName)) return normalized;

    const input = normalized as Record<string, unknown>;
    const questions = (input.questions as Record<string, unknown>[]).map((question) => (
        typeof question.freeform === 'undefined'
            ? { ...question, freeform: {} }
            : question
    ));
    return { ...input, questions };
}
