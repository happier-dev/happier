import { summarizeAgentRequestQuestions } from '@happier-dev/plugin-sdk/sessions';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '@happier-dev/plugin-sdk/sessions';

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

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function normalizeAskUserQuestionAnswers(value: unknown): Record<string, string> | null {
    if (!isPlainObject(value)) return null;

    const answers = Object.create(null) as Record<string, string>;
    for (const [question, answer] of Object.entries(value)) {
        if (question && isStringArray(answer)) {
            answers[question] = answer.join(', ');
        }
    }

    return Object.keys(answers).length > 0 ? answers : null;
}

/** Native single-select previews replace the inline freeform row with choice annotations. */
export function isClaudeNativePreviewQuestion(question: unknown): boolean {
    return isPlainObject(question) && question.multiSelect !== true && question.multiple !== true
        && Array.isArray(question.options) && question.options.some((option: unknown) => (
            isPlainObject(option) && typeof option.preview === 'string' && option.preview.trim().length > 0
        ));
}

export function normalizeAskUserQuestionInputForPublication(
    toolName: string,
    toolInput: unknown,
    context?: Readonly<{ native: boolean }>,
): unknown {
    if (!isAskUserQuestionToolName(toolName)) return toolInput;
    if (!isPlainObject(toolInput)) return toolInput;

    const questionsRaw = toolInput.questions;
    if (!Array.isArray(questionsRaw)) return toolInput;

    let mutated = false;
    const questions = questionsRaw.map((question) => {
        if (!isPlainObject(question)) return question;
        if (context?.native && isClaudeNativePreviewQuestion(question)) {
            if (question.freeform === false) return question;
            mutated = true;
            return { ...question, freeform: false };
        }
        if ('freeform' in question && typeof question.freeform !== 'undefined') {
            return question;
        }
        mutated = true;
        return { ...question, freeform: {} };
    });

    if (!mutated) return toolInput;

    return { ...toolInput, questions };
}

/** Map canonical answers to provider text/order, then encode for the Claude delivery boundary. */
export function buildAskUserQuestionAnswersForClaude(
    questions: readonly unknown[],
    answers: StructuredQuestionAnswersV1,
    format: 'native' | 'hook',
): Readonly<Record<string, string>> {
    const summary = summarizeAgentRequestQuestions(questions);
    const projected = Object.create(null) as Record<string, string>;
    for (const question of summary) {
        const selected = answers[question.answerKey] ?? [];
        const values = [
            ...question.choices.filter((choice) => selected.includes(choice.value)).map((choice) => choice.label),
            ...selected.filter((value) => !question.choices.some((choice) => choice.value === value)),
        ];
        // Claude Code 2.1.316 uses this encoding in both its review and tool result.
        projected[question.question] = format === 'native' && question.selection === 'multiple'
            ? values.map((value) => value.includes(', ') || value.includes('"') ? JSON.stringify(value) : value).join(', ')
            : values.join(', ');
    }
    return Object.freeze(projected);
}



/** Decode Claude's checkbox scalar: only delimiter- or quote-bearing values are JSON strings. */
function decodeNativeCheckboxAnswers(value: string): readonly string[] | null {
    const values: string[] = [];
    let remaining = value;
    while (remaining.length) {
        if (remaining.startsWith('"')) {
            const quoted = remaining.match(/^"(?:[^"\\]|\\.)*"/s)?.[0];
            if (!quoted) return null;
            try {
                const decoded: unknown = JSON.parse(quoted);
                if (typeof decoded !== 'string') return null;
                values.push(decoded);
            } catch {
                return null;
            }
            remaining = remaining.slice(quoted.length);
        } else {
            const separator = remaining.indexOf(', ');
            const label = separator < 0 ? remaining : remaining.slice(0, separator);
            if (!label.length || label.includes('"')) return null;
            values.push(label);
            remaining = remaining.slice(label.length);
        }
        if (!remaining.length) return values;
        if (!remaining.startsWith(', ') || remaining.length === 2) return null;
        remaining = remaining.slice(2);
    }
    return null;
}

/** Recover canonical answer arrays from observed native review/tool-result scalars. */
export function normalizeNativeAskUserQuestionAnswers(
    questions: readonly unknown[],
    providerAnswers: unknown,
): StructuredQuestionAnswersV1 | null {
    if (!isPlainObject(providerAnswers)) return null;
    const publication = normalizeAskUserQuestionInputForPublication('AskUserQuestion', { questions }, { native: true });
    const summary = summarizeAgentRequestQuestions(isPlainObject(publication) && Array.isArray(publication.questions) ? publication.questions : []);
    if (!summary.length || summary.length !== questions.length
        || new Set(summary.map(question => question.answerKey)).size !== questions.length
        || new Set(summary.map(question => question.question)).size !== questions.length
        || Object.keys(providerAnswers).length !== questions.length) return null;
    const answers = Object.create(null) as Record<string, readonly string[]>;
    for (const question of summary) {
        const value = Object.hasOwn(providerAnswers, question.question) ? providerAnswers[question.question] : undefined;
        if (typeof value !== 'string' || !value.length) return null;
        const values = question.selection === 'multiple' ? decodeNativeCheckboxAnswers(value) : [value];
        if (!values) return null;
        const selected: string[] = [];
        for (const label of values) {
            const matches = question.selection === 'text' ? [] : question.choices.filter(choice => choice.label === label);
            if (matches.length > 1 || (matches.length === 0 && !question.allowCustom)) return null;
            selected.push(matches[0]?.value ?? label);
        }
        answers[question.answerKey] = selected;
    }
    const parsed = StructuredQuestionAnswersV1Schema.safeParse(answers);
    return parsed.success ? parsed.data : null;
}
