/**
 * Claude Code's `AskUserQuestion` tool schema carries structured options but NO
 * explicit freeform field. Claude's native terminal UI always offers an implicit
 * "Other / type something" escape to let the user answer with arbitrary text —
 * the tool itself accepts `answers: Record<string, string>` with no label
 * validation, so any string is a valid answer.
 *
 * Happier's mobile UI renders a freeform `<TextInput>` only when each question
 * carries a truthy `freeform` field. Since Claude never emits that field, we
 * inject a default one here on the agent-state side so the UI surfaces the
 * same escape hatch the terminal offers. The mobile UI provides its own
 * localized placeholder string when we pass an empty object.
 *
 * Applied only to the copy of `toolInput` that's published to agent state.
 * The hook-response path keeps the original `toolInput` intact so we never
 * echo the synthesized field back to Claude.
 */

const ASK_USER_QUESTION_TOOL_NAMES = new Set<string>([
    'AskUserQuestion',
    'ask_user_question',
]);

export function isAskUserQuestionToolName(toolName: string): boolean {
    return ASK_USER_QUESTION_TOOL_NAMES.has(toolName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a new `toolInput` with `question.freeform = {}` injected on every
 * question that lacks an existing `freeform` field. For non-AskUserQuestion
 * tools, or when the shape is unexpected, returns the input unchanged.
 * Respects any `freeform` value the tool input already carries (e.g. a future
 * Claude schema change that starts emitting its own placeholder text).
 */
export function withAskUserQuestionUiFreeformDefault(toolName: string, toolInput: unknown): unknown {
    if (!isAskUserQuestionToolName(toolName)) return toolInput;
    if (!isPlainObject(toolInput)) return toolInput;

    const questionsRaw = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(questionsRaw)) return toolInput;

    let mutated = false;
    const questions = questionsRaw.map((question) => {
        if (!isPlainObject(question)) return question;
        if ('freeform' in question && typeof question.freeform !== 'undefined') {
            return question;
        }
        mutated = true;
        return { ...question, freeform: {} };
    });

    if (!mutated) return toolInput;

    return { ...(toolInput as Record<string, unknown>), questions };
}
