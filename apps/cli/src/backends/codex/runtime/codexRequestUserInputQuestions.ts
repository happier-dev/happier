import { looksLikeFreeformQuestionHintLabel } from '@/agent/questions/structuredQuestionAnswerText';

type RecordLike = Record<string, unknown>;

type AskUserQuestionOption = Readonly<{
    label: string;
    description: string;
}>;

type AskUserQuestionEntry = Readonly<{
    header: string;
    question: string;
    options: ReadonlyArray<AskUserQuestionOption>;
    multiSelect: boolean;
    freeform?: Readonly<{
        placeholder?: string;
        description?: string;
    }>;
}>;

function asRecord(value: unknown): RecordLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RecordLike;
}

function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readQuestionOptions(question: RecordLike): ReadonlyArray<RecordLike> {
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    return rawOptions
        .map((option) => asRecord(option))
        .filter((option): option is RecordLike => Boolean(option));
}

function readApprovalLabels(questions: unknown): string[] {
    if (!Array.isArray(questions)) return [];
    return questions
        .map((question) => asRecord(question))
        .filter((question): question is RecordLike => Boolean(question))
        .flatMap((question) => readQuestionOptions(question))
        .map((option) => normalizeString(option.label))
        .filter((label) => label.length > 0);
}

export function looksLikeCodexApprovalRequestUserInput(params: Readonly<{
    toolName: string;
    questions: unknown;
}>): boolean {
    const normalizedToolName = params.toolName.trim().toLowerCase();
    if (normalizedToolName.includes('request_user_input') || normalizedToolName.includes('askuserquestion')) {
        return false;
    }

    if (!Array.isArray(params.questions) || params.questions.length === 0) return false;
    if (params.questions.some((question) => normalizeString(asRecord(question)?.id).startsWith('mcp_tool_call_approval_'))) {
        return true;
    }

    const labels = readApprovalLabels(params.questions);
    const hasApproval = labels.some((label) => /\bapprove\b|\ballow\b|\baccept\b/i.test(label));
    const hasDeny = labels.some((label) => /\bdeny\b|\breject\b|\bdecline\b/i.test(label));
    return hasApproval && hasDeny;
}

function normalizeAskUserQuestionEntry(question: unknown): AskUserQuestionEntry | null {
    const record = asRecord(question);
    if (!record) return null;

    const header = normalizeString(record.header);
    const prompt = normalizeString(record.question);
    if (!header && !prompt) return null;

    const multiSelect = record.multiSelect === true || record.multiple === true;
    const parsedOptions = readQuestionOptions(record)
        .map((option) => ({
            label: normalizeString(option.label),
            description: normalizeString(option.description),
            isOther: option.isOther === true,
        }))
        .filter((option) => option.label.length > 0);

    const explicitOptions = parsedOptions
        .filter((option) => !option.isOther)
        .map((option) => ({
            label: option.label,
            description: option.description,
        }));

    const otherOption = parsedOptions.find((option) => option.isOther)
        ?? parsedOptions.find((option) => looksLikeFreeformQuestionHintLabel(option.label))
        ?? null;

    const freeform = otherOption
        ? {
            ...(otherOption.label ? { placeholder: otherOption.label } : null),
            ...(otherOption.description ? { description: otherOption.description } : null),
        }
        : undefined;

    return {
        header,
        question: prompt || header,
        options: explicitOptions,
        multiSelect,
        ...(freeform && (!multiSelect || explicitOptions.length === 0) ? { freeform } : null),
    };
}

export function normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput(questions: unknown): Readonly<{
    questions: ReadonlyArray<AskUserQuestionEntry>;
}> {
    const normalizedQuestions = Array.isArray(questions)
        ? questions
            .map((question) => normalizeAskUserQuestionEntry(question))
            .filter((question): question is AskUserQuestionEntry => Boolean(question))
        : [];

    return { questions: normalizedQuestions };
}

function resolveAnswerValues(params: Readonly<{
    question: RecordLike;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>): readonly string[] {
    const questionId = normalizeString(params.question.id);
    const questionText = normalizeString(params.question.question);
    const header = normalizeString(params.question.header);

    if (questionId && Array.isArray(params.answersByKey[questionId])) return params.answersByKey[questionId]!;
    if (questionText && Array.isArray(params.answersByKey[questionText])) return params.answersByKey[questionText]!;
    if (header && Array.isArray(params.answersByKey[header])) return params.answersByKey[header]!;
    return [];
}

export function buildCodexRequestUserInputAnswers(params: Readonly<{
    questions: unknown;
    answersByKey: Readonly<Record<string, readonly string[]>>;
}>): Record<string, { answers: string[] }> {
    if (!Array.isArray(params.questions)) return Object.create(null) as Record<string, { answers: string[] }>;

    const answers = Object.create(null) as Record<string, { answers: string[] }>;
    for (const rawQuestion of params.questions) {
        const question = asRecord(rawQuestion);
        if (!question) continue;
        const questionId = normalizeString(question.id);
        if (!questionId) continue;

        const answerValues = resolveAnswerValues({ question, answersByKey: params.answersByKey });
        if (answerValues.length === 0) continue;
        answers[questionId] = { answers: [...answerValues] };
    }

    return answers;
}
