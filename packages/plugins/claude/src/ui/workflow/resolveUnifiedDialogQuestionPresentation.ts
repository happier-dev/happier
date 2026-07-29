export type ClaudeUnifiedDialogQuestionInput = Readonly<{
  happierDialog?: unknown;
  questions: readonly Readonly<{
    header: string;
    question: string;
    multiSelect: boolean;
    options: readonly Readonly<{
      choice?: string | undefined;
      label: string;
      description: string;
    }>[];
  }>[];
}>;

type ClaudeUnifiedDialogNoticeTranslationKey =
  | 'tools.askUserQuestion.claudeDialogNotice.header'
  | 'tools.askUserQuestion.claudeDialogNotice.question'
  | 'tools.askUserQuestion.claudeDialogNotice.openTerminal';

function isOpenTerminalNotice(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dialog = value as Record<string, unknown>;
  return dialog.kind === 'unrecognized'
    && dialog.dialogId === 'unrecognized_confirmation'
    && dialog.mode === 'notice'
    && dialog.action === 'open_terminal';
}

export function resolveClaudeUnifiedDialogQuestionPresentation<T extends ClaudeUnifiedDialogQuestionInput>(
  input: T,
  translate: (key: ClaudeUnifiedDialogNoticeTranslationKey) => string,
): ClaudeUnifiedDialogQuestionInput {
  if (!isOpenTerminalNotice(input.happierDialog)) return input;
  const firstQuestion = input.questions[0];
  if (!firstQuestion) return input;
  if (firstQuestion.options.length !== 0) return input;

  return {
    ...input,
    questions: [{
      ...firstQuestion,
      header: translate('tools.askUserQuestion.claudeDialogNotice.header'),
      question: translate('tools.askUserQuestion.claudeDialogNotice.question'),
      options: [],
    }],
  };
}
