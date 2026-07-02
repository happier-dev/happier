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

export function normalizeAskUserQuestionAnswers(value: unknown): Record<string, string> | null {
    if (!isPlainObject(value)) return null;

    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(value)) {
        if (question && typeof answer === 'string') {
            answers[question] = answer;
        }
    }

    return Object.keys(answers).length > 0 ? answers : null;
}

export function withAskUserQuestionUiFreeformDefault(toolName: string, toolInput: unknown): unknown {
    if (!isAskUserQuestionToolName(toolName)) return toolInput;
    if (!isPlainObject(toolInput)) return toolInput;

    const questionsRaw = toolInput.questions;
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

    return { ...toolInput, questions };
}
