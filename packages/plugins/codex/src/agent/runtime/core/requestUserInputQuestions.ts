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

function splitCommaSeparatedLabels(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function looksLikeFreeformQuestionHintLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('type') || normalized.includes('enter') || normalized.includes('your own answer');
}

function readQuestionOptions(question: RecordLike): ReadonlyArray<RecordLike> {
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  return rawOptions
    .map((option) => asRecord(option))
    .filter((option): option is RecordLike => Boolean(option));
}

const CODEX_APPROVAL_QUESTION_ID_PREFIX = 'mcp_tool_call_approval_';
const POSITIVE_CHOICE_LABEL = /\bapprove\b|\ballow\b|\baccept\b/i;
const NEGATIVE_CHOICE_LABEL = /\bdeny\b|\breject\b|\bdecline\b/i;
const CANCELLATION_CHOICE_LABEL = /\bcancel\b|\babort\b|\bstop\b/i;
const SESSION_SCOPED_CHOICE_LABEL = /\bsession\b|\balways\b/i;

/**
 * Detection and selection share one rule for "which question carries the
 * permission decision". Approval wording is never pooled across questions: a
 * genuine multi-question form whose separate questions happen to use approving
 * and denying words stays a form, and is asked, instead of being answered as a
 * permission decision the user never made.
 */
export function looksLikeCodexApprovalRequestUserInput(params: Readonly<{
  toolName: string;
  questions: unknown;
}>): boolean {
  const normalizedToolName = params.toolName.trim().toLowerCase();
  if (normalizedToolName.includes('request_user_input') || normalizedToolName.includes('askuserquestion')) {
    return false;
  }
  return hasCodexApprovalQuestionId(params.questions)
    || findApprovalQuestion(params.questions) !== null;
}

function hasCodexApprovalQuestionId(questions: unknown): boolean {
  return Array.isArray(questions)
    && questions.some((question) => (
      normalizeString(asRecord(question)?.id).startsWith(CODEX_APPROVAL_QUESTION_ID_PREFIX)
    ));
}

/** The permission outcome a Codex approval question has to carry. */
export type CodexApprovalOutcome =
  | 'approve_once'
  | 'approve_for_session'
  | 'deny'
  | 'cancel';

export type CodexApprovalChoice = Readonly<{
  questionId: string;
  label: string;
}>;

type ApprovalQuestionCandidate = Readonly<{
  id: string;
  labels: readonly string[];
}>;

function readApprovalQuestionCandidate(question: RecordLike): ApprovalQuestionCandidate | null {
  const id = normalizeString(question.id);
  if (!id) return null;
  const labels = readQuestionOptions(question)
    .map((option) => normalizeString(option.label))
    .filter((label) => label.length > 0);
  return labels.length > 0 ? { id, labels } : null;
}

/**
 * Locates the one question whose options can carry a permission decision.
 * Codex stamps that question with the `mcp_tool_call_approval_` id; otherwise
 * only a question offering both an explicit positive and an explicit negative
 * option is answerable. Options are never pooled across questions, so one
 * question's choice can never become another question's answer.
 */
function findApprovalQuestion(questions: unknown): ApprovalQuestionCandidate | null {
  if (!Array.isArray(questions)) return null;
  const candidates = questions
    .map((question) => asRecord(question))
    .filter((question): question is RecordLike => Boolean(question))
    .map((question) => readApprovalQuestionCandidate(question))
    .filter((candidate): candidate is ApprovalQuestionCandidate => Boolean(candidate));
  return candidates.find((candidate) => candidate.id.startsWith(CODEX_APPROVAL_QUESTION_ID_PREFIX))
    ?? candidates.find((candidate) => (
      candidate.labels.some((label) => POSITIVE_CHOICE_LABEL.test(label))
      && candidate.labels.some((label) => NEGATIVE_CHOICE_LABEL.test(label))
    ))
    ?? null;
}

/**
 * Canonical semantic mapping from a settled permission outcome to the exact
 * Codex approval option that expresses it. Approval requires an explicit
 * positive option; every decline, cancellation, timeout and unavailability
 * requires an explicit negative option. When the question offers no option
 * that can truthfully carry the outcome the approval is left unanswered
 * rather than answered with a choice the user did not make.
 */
export function resolveCodexApprovalQuestionChoice(params: Readonly<{
  questions: unknown;
  outcome: CodexApprovalOutcome;
}>): CodexApprovalChoice | null {
  const question = findApprovalQuestion(params.questions);
  if (!question) return null;
  const pick = (predicate: (label: string) => boolean): string | null =>
    question.labels.find((label) => predicate(label)) ?? null;
  const positive = (label: string): boolean => POSITIVE_CHOICE_LABEL.test(label);
  const negative = (label: string): boolean => NEGATIVE_CHOICE_LABEL.test(label);
  const cancellation = (label: string): boolean => CANCELLATION_CHOICE_LABEL.test(label);
  const sessionScoped = (label: string): boolean => SESSION_SCOPED_CHOICE_LABEL.test(label);
  const label = ((): string | null => {
    switch (params.outcome) {
      case 'approve_for_session':
        // A narrower once-scoped grant is a safe downgrade when the question
        // offers no session-scoped option.
        return pick((entry) => positive(entry) && sessionScoped(entry))
          ?? pick((entry) => positive(entry) && !sessionScoped(entry));
      case 'approve_once':
        // Never widen a once-scoped grant while a once-scoped option exists.
        return pick((entry) => positive(entry) && !sessionScoped(entry))
          ?? pick(positive);
      case 'deny':
        return pick(negative) ?? pick(cancellation);
      case 'cancel':
        return pick(cancellation) ?? pick(negative);
    }
  })();
  return label ? { questionId: question.id, label } : null;
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

function resolveAnswerText(params: Readonly<{
  question: RecordLike;
  answersByKey: Record<string, string>;
}>): string {
  const questionId = normalizeString(params.question.id);
  const questionText = normalizeString(params.question.question);
  const header = normalizeString(params.question.header);

  if (questionId && typeof params.answersByKey[questionId] === 'string') {
    return params.answersByKey[questionId]!.trim();
  }
  if (questionText && typeof params.answersByKey[questionText] === 'string') {
    return params.answersByKey[questionText]!.trim();
  }
  if (header && typeof params.answersByKey[header] === 'string') {
    return params.answersByKey[header]!.trim();
  }
  return '';
}

export function buildCodexRequestUserInputAnswers(params: Readonly<{
  questions: unknown;
  answersByKey: Record<string, string>;
}>): Record<string, { answers: string[] }> {
  if (!Array.isArray(params.questions)) return {};

  const answers: Record<string, { answers: string[] }> = {};
  for (const rawQuestion of params.questions) {
    const question = asRecord(rawQuestion);
    if (!question) continue;
    const questionId = normalizeString(question.id);
    if (!questionId) continue;

    const answerText = resolveAnswerText({ question, answersByKey: params.answersByKey });
    if (!answerText) continue;

    const multiSelect = question.multiSelect === true || question.multiple === true;
    answers[questionId] = {
      answers: multiSelect ? splitCommaSeparatedLabels(answerText) : [answerText],
    };
  }

  return answers;
}
