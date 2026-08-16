import type { ClaudeScreenState } from './screenState';

export type ClaudeUnifiedRecognizedDialogId =
  | 'switch_model'
  | 'usage_limit'
  | 'resume_choice'
  | 'safeguard_pause'
  | 'effort_change'
  | 'trust_folder';

export type ClaudeUnifiedDialogId = ClaudeUnifiedRecognizedDialogId | 'unrecognized_confirmation';

export type ClaudeUnifiedDialogBlockedReason =
  | 'switch_model_dialog'
  | 'usage_limit_dialog'
  | 'resume_choice_dialog'
  | 'safeguard_pause_dialog'
  | 'effort_change_dialog'
  | 'trust_folder_prompt'
  | 'unrecognized_confirmation_dialog';

export type ClaudeUnifiedDialogDetectorStateKey =
  | 'switchModelDialogVisible'
  | 'usageLimitDialogVisible'
  | 'resumeChoiceDialogVisible'
  | 'safeguardPauseDialogVisible'
  | 'effortChangeDialogVisible'
  | 'trustFolderPromptVisible';

export type ClaudeUnifiedDialogOwner = 'slash_controls' | 'resume_startup';

export type ClaudeUnifiedDialogOwnerRegistration = Readonly<{
  kind: ClaudeUnifiedDialogOwner;
  controlKeys: readonly ('model' | 'reasoningEffort' | 'launchOption')[];
}>;

export type ClaudeUnifiedDialogSettingMutation =
  | Readonly<{
    settingId: 'claudeUnifiedTerminalWorkspaceTrust';
    value: 'always_trust_happier_workspaces' | 'always_reject_happier_workspaces';
  }>
  | Readonly<{
    settingId: 'claudeUnifiedTerminalResumeChoice';
    value: 'resume_from_summary' | 'resume_full_session';
  }>;

export type ClaudeUnifiedDialogOption = Readonly<{
  choice: string;
  label: string;
  description: string;
  answer: Readonly<{ kind: 'literal'; text: string }>;
  settingMutation?: ClaudeUnifiedDialogSettingMutation | undefined;
}>;

export type ClaudeUnifiedRecognizedDialogRegistryEntry = Readonly<{
  dialogId: ClaudeUnifiedRecognizedDialogId;
  detectorStateKey: ClaudeUnifiedDialogDetectorStateKey;
  owner: ClaudeUnifiedDialogOwnerRegistration | null;
  questionId: string;
  requestReason: string;
  header: string;
  question: string;
  options: (state: ClaudeScreenState) => readonly ClaudeUnifiedDialogOption[];
}>;

export type ClaudeUnifiedVisibleRecognizedDialog = Readonly<{
  kind: 'recognized';
  dialogId: ClaudeUnifiedRecognizedDialogId;
  detectorStateKey: ClaudeUnifiedDialogDetectorStateKey;
  owner: ClaudeUnifiedDialogOwnerRegistration | null;
  questionId: string;
  requestReason: string;
  header: string;
  question: string;
  options: readonly ClaudeUnifiedDialogOption[];
}>;

type ClaudeUnifiedVisibleUnrecognizedDialogBase = Readonly<{
  kind: 'unrecognized';
  dialogId: 'unrecognized_confirmation';
  owner: null;
  questionId: string;
  requestReason: string;
  header: string;
  question: string;
  context: readonly string[];
  options: readonly ClaudeUnifiedDialogOption[];
}>;

export type ClaudeUnifiedVisibleUnrecognizedDialog =
  | (ClaudeUnifiedVisibleUnrecognizedDialogBase & Readonly<{ mode: 'generic'; signature: string }>)
  | (ClaudeUnifiedVisibleUnrecognizedDialogBase & Readonly<{ mode: 'notice' }>);

export type ClaudeUnifiedVisibleDialog =
  | ClaudeUnifiedVisibleRecognizedDialog
  | ClaudeUnifiedVisibleUnrecognizedDialog;

function option(
  choice: string,
  label: string,
  description: string,
  text: string,
  settingMutation?: ClaudeUnifiedDialogOption['settingMutation'],
): ClaudeUnifiedDialogOption {
  return {
    choice,
    label,
    description,
    answer: { kind: 'literal', text },
    ...(settingMutation ? { settingMutation } : {}),
  };
}

const CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE = Object.freeze({
  kind: 'unrecognized' as const,
  mode: 'notice' as const,
  dialogId: 'unrecognized_confirmation' as const,
  owner: null,
  questionId: 'claudeUnifiedTerminalUnrecognizedDialog',
  requestReason: 'claude_unified_terminal_unrecognized_dialog',
  header: 'Claude needs attention',
  question: 'Claude is showing a dialog Happier does not recognize.',
  context: Object.freeze([]),
  options: Object.freeze([]),
});

export const CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY: readonly ClaudeUnifiedRecognizedDialogRegistryEntry[] = Object.freeze([
  {
    dialogId: 'switch_model',
    detectorStateKey: 'switchModelDialogVisible',
    owner: { kind: 'slash_controls', controlKeys: ['model'] },
    questionId: 'claudeUnifiedTerminalSwitchModel',
    requestReason: 'claude_unified_terminal_switch_model',
    header: 'Claude model',
    question: 'Claude is asking whether to switch models.',
    options: () => [
      option('confirm', 'Switch model', 'Confirm Claude\'s model switch.', '1'),
      option('cancel', 'Keep current model', 'Dismiss the model switch.', '2'),
    ],
  },
  {
    dialogId: 'usage_limit',
    detectorStateKey: 'usageLimitDialogVisible',
    owner: null,
    questionId: 'claudeUnifiedTerminalUsageLimit',
    requestReason: 'claude_unified_terminal_usage_limit',
    header: 'Claude usage limit',
    question: 'Claude reached a usage limit. What should it do?',
    options: (state) => state.visibleNumberedDialog?.options.map((dialogOption) => option(
      dialogOption.choice,
      dialogOption.label,
      'Send this exact visible choice to Claude.',
      dialogOption.choice,
    )) ?? [],
  },
  {
    dialogId: 'resume_choice',
    // resume_choice is a startup-only dialog owned exclusively by the startup resume resolver (its
    // shared dialog broker through the startup resolver). The runtime screen probe must never
    // publish it too, or startup double-publishes one dialog into two
    // needs-attention requests. The probe treats this `resume_startup` owner as always-owned so it
    // defers rather than publishing.
    detectorStateKey: 'resumeChoiceDialogVisible',
    owner: { kind: 'resume_startup', controlKeys: [] },
    questionId: 'claudeUnifiedTerminalResumeChoice',
    requestReason: 'claude_unified_terminal_resume_choice',
    header: 'Claude resume',
    question: 'How should Claude resume this session?',
    options: () => [
      option('resume_from_summary', 'Resume from summary', 'Resume faster from Claude\'s saved summary.', '1'),
      option(
        'always_resume_from_summary',
        'Always resume from summary',
        'Resume from Claude\'s saved summary now and remember this choice.',
        '1',
        {
          settingId: 'claudeUnifiedTerminalResumeChoice',
          value: 'resume_from_summary',
        },
      ),
      option('resume_full_session', 'Resume full session', 'Load the full session context.', '2'),
      option(
        'always_resume_full_session',
        'Always resume full session',
        'Load the full session context now and remember this choice.',
        '2',
        {
          settingId: 'claudeUnifiedTerminalResumeChoice',
          value: 'resume_full_session',
        },
      ),
    ],
  },
  {
    dialogId: 'safeguard_pause',
    detectorStateKey: 'safeguardPauseDialogVisible',
    owner: null,
    questionId: 'claudeUnifiedTerminalSafeguardChoice',
    requestReason: 'claude_unified_terminal_safeguard_choice',
    header: 'Claude paused',
    question: 'How should Claude continue?',
    options: (state) => state.safeguardPauseDialogOptions.map((dialogOption, index) => option(
      dialogOption.choice,
      dialogOption.label,
      dialogOption.choice === 'switch_model'
        ? 'Send Claude the chooser option to switch models and continue.'
        : 'Send Claude the chooser option to edit the prompt and retry.',
      String(index + 1),
    )),
  },
  {
    dialogId: 'effort_change',
    detectorStateKey: 'effortChangeDialogVisible',
    owner: { kind: 'slash_controls', controlKeys: ['reasoningEffort', 'launchOption'] },
    questionId: 'claudeUnifiedTerminalEffortChange',
    requestReason: 'claude_unified_terminal_effort_change',
    header: 'Claude effort',
    question: 'Claude is asking whether to change the effort level.',
    options: (state) => {
      const target = state.effortChangeDialogTarget;
      return [
        option(
          'confirm',
          target ? `Switch to ${target}` : 'Change effort',
          'Apply the effort-level change in Claude.',
          '1',
        ),
        option('cancel', 'Keep current effort', 'Dismiss the effort-level change.', '2'),
      ];
    },
  },
  {
    // Claude suppresses every hook source until workspace trust is accepted, so the normal
    // PermissionRequest bridge cannot bootstrap this provider-owned prompt. Keep this narrow trust
    // decision in the canonical terminal dialog broker and require an explicit user choice; never
    // infer or auto-accept workspace trust.
    dialogId: 'trust_folder',
    detectorStateKey: 'trustFolderPromptVisible',
    owner: null,
    questionId: 'claudeUnifiedTerminalTrustFolder',
    requestReason: 'claude_unified_terminal_trust_folder',
    header: 'Trust this folder',
    question: 'Claude needs your permission to trust and run code from this folder.',
    options: () => [
      option('trust_once', 'Trust and proceed', 'Trust this workspace for this prompt.', '1'),
      option(
        'always_trust_happier_workspaces',
        'Always trust Happier workspaces',
        'Trust this prompt and remember the choice for future Claude workspaces opened by Happier.',
        '1',
        { settingId: 'claudeUnifiedTerminalWorkspaceTrust', value: 'always_trust_happier_workspaces' },
      ),
      option('reject_once', 'Do not trust', 'Reject this workspace for this prompt.', '2'),
      option(
        'always_reject_happier_workspaces',
        'Always reject Happier workspaces',
        'Reject this prompt and remember the choice for future Claude workspaces opened by Happier.',
        '2',
        { settingId: 'claudeUnifiedTerminalWorkspaceTrust', value: 'always_reject_happier_workspaces' },
      ),
    ],
  },
]);

const ENTRY_BY_ID = new Map(
  CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY.map((entry) => [entry.dialogId, entry] as const),
);

const BLOCKED_REASON_BY_DIALOG_ID: Readonly<Record<ClaudeUnifiedDialogId, ClaudeUnifiedDialogBlockedReason>> = {
  switch_model: 'switch_model_dialog',
  usage_limit: 'usage_limit_dialog',
  resume_choice: 'resume_choice_dialog',
  safeguard_pause: 'safeguard_pause_dialog',
  effort_change: 'effort_change_dialog',
  trust_folder: 'trust_folder_prompt',
  unrecognized_confirmation: 'unrecognized_confirmation_dialog',
};

const DIALOG_BLOCKED_REASONS = new Set<ClaudeUnifiedDialogBlockedReason>(
  Object.values(BLOCKED_REASON_BY_DIALOG_ID),
);

export function getClaudeUnifiedRecognizedDialogRegistryEntry(
  dialogId: ClaudeUnifiedRecognizedDialogId,
): ClaudeUnifiedRecognizedDialogRegistryEntry {
  const entry = ENTRY_BY_ID.get(dialogId);
  if (!entry) throw new Error(`unknown_claude_unified_dialog:${dialogId}`);
  return entry;
}

export function isClaudeUnifiedRegisteredDialogVisible(
  state: ClaudeScreenState,
  entry: ClaudeUnifiedRecognizedDialogRegistryEntry,
): boolean {
  return state[entry.detectorStateKey] === true;
}

export function resolveClaudeUnifiedRegisteredDialogOption(
  state: ClaudeScreenState,
  entry: ClaudeUnifiedRecognizedDialogRegistryEntry,
  choice: string,
): ClaudeUnifiedDialogOption | null {
  return entry.options(state).find((candidate) => candidate.choice === choice) ?? null;
}

export function resolveClaudeUnifiedVisibleDialog(state: ClaudeScreenState): ClaudeUnifiedVisibleDialog | null {
  for (const entry of CLAUDE_UNIFIED_RECOGNIZED_DIALOG_REGISTRY) {
    if (!isClaudeUnifiedRegisteredDialogVisible(state, entry)) continue;
    return {
      kind: 'recognized',
      dialogId: entry.dialogId,
      detectorStateKey: entry.detectorStateKey,
      owner: entry.owner,
      questionId: entry.questionId,
      requestReason: entry.requestReason,
      header: entry.header,
      question: entry.question,
      options: entry.options(state),
    };
  }
  if (state.unrecognizedConfirmationDialogVisible) {
    const generic = state.unrecognizedConfirmationDialog;
    if (generic) {
      return {
        kind: 'unrecognized',
        mode: 'generic',
        signature: generic.signature,
        dialogId: 'unrecognized_confirmation',
        owner: null,
        questionId: 'claudeUnifiedTerminalGenericDialog',
        requestReason: 'claude_unified_terminal_generic_dialog',
        header: 'Claude needs attention',
        question: generic.context.join('\n'),
        context: generic.context,
        options: generic.options.map(({ choice, label }) => option(
          choice,
          label,
          'Send this exact visible choice to Claude.',
          choice,
        )),
      };
    }
    return CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE;
  }
  return null;
}

export function hasClaudeUnifiedVisibleDialog(state: ClaudeScreenState): boolean {
  return resolveClaudeUnifiedVisibleDialog(state) !== null;
}

export function resolveClaudeUnifiedDialogBlockedReason(
  state: ClaudeScreenState,
): ClaudeUnifiedDialogBlockedReason | null {
  const dialog = resolveClaudeUnifiedVisibleDialog(state);
  return dialog ? BLOCKED_REASON_BY_DIALOG_ID[dialog.dialogId] : null;
}

export function isClaudeUnifiedDialogBlockedReason(
  value: unknown,
): value is ClaudeUnifiedDialogBlockedReason {
  return typeof value === 'string' && DIALOG_BLOCKED_REASONS.has(value as ClaudeUnifiedDialogBlockedReason);
}

function normalizeChoiceToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

export function buildClaudeUnifiedDialogQuestionInput(
  dialog: ClaudeUnifiedVisibleDialog,
): Readonly<Record<string, unknown>> {
  const options = dialog.options.map((entryOption) => ({
    choice: entryOption.choice,
    label: entryOption.label,
    description: entryOption.description,
    ...(entryOption.settingMutation ? { settingMutation: entryOption.settingMutation } : {}),
  }));
  return {
    happierDialog: dialog.kind === 'unrecognized'
      ? dialog.mode === 'generic'
        ? {
          kind: 'unrecognized',
          mode: 'generic',
          dialogId: dialog.dialogId,
          signature: dialog.signature,
          secondaryAction: 'open_terminal',
        }
        : { kind: 'unrecognized', mode: 'notice', dialogId: dialog.dialogId, action: 'open_terminal' }
      : { kind: 'recognized', dialogId: dialog.dialogId, secondaryAction: 'open_terminal' },
    questions: [{
      id: dialog.questionId,
      header: dialog.header,
      question: dialog.question,
      multiSelect: false,
      options,
    }],
  };
}

/** Full visible identity used for request replacement and the final pre-byte recapture guard. */
export function getClaudeUnifiedDialogIdentity(dialog: ClaudeUnifiedVisibleDialog): string {
  return JSON.stringify({
    dialogId: dialog.dialogId,
    kind: dialog.kind,
    mode: dialog.kind === 'unrecognized' ? dialog.mode : 'recognized',
    context: dialog.kind === 'unrecognized' ? dialog.context : [dialog.header, dialog.question],
    signature: dialog.kind === 'unrecognized' && dialog.mode === 'generic' ? dialog.signature : null,
    options: dialog.options.map((candidate) => ({
      choice: candidate.choice,
      label: candidate.label,
      answer: candidate.answer.text,
      settingMutation: candidate.settingMutation ?? null,
    })),
  });
}

export function resolveClaudeUnifiedDialogSelectedOption<
  TOption extends Readonly<{ choice: string; label: string }>,
>(
  answers: Readonly<Record<string, unknown>> | null | undefined,
  options: readonly TOption[],
): TOption | null {
  if (!answers) return null;
  for (const value of Object.values(answers)) {
    const answer = typeof value === 'string'
      ? value
      : Array.isArray(value) && value.length === 1 && typeof value[0] === 'string'
        ? value[0]
        : null;
    if (answer === null) continue;
    const normalized = normalizeChoiceToken(answer);
    const match = options.find((candidate) => (
      normalizeChoiceToken(candidate.choice) === normalized
      || normalizeChoiceToken(candidate.label) === normalized
    ));
    if (match) return match;
  }
  return null;
}
