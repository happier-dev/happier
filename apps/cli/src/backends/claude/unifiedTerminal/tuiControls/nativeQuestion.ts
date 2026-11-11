import { normalizeStructuredQuestionDescriptors, type StructuredQuestionAnswersV1, type StructuredQuestionLike } from '@happier-dev/protocol';
import { normalizeStructuredQuestionAnswersV1 } from '@/agent/questions/normalizeStructuredQuestionAnswersV1';
import { hasMultilinePayload, wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';
import type { TerminalControlPort, TerminalSpecialKey } from '@/integrations/terminalHost/controlTypes';
import { deepEqual } from '@/utils/deterministicJson';
import { normalizeClaudeAskUserQuestionInputForPublication } from '../../utils/normalizeClaudeAskUserQuestionInput';
import { buildNativeAskUserQuestionAnswersForClaude } from '../../utils/askUserQuestionAnswersForClaude';
import { captureScreenState, doesClaudeOwnedTextMatchCapture, hasUnsupportedClaudeNativeTextControls, sendResultToFailure } from './controlRuntime';
import { resolveClaudeNativeQuestionScreen, matchesClaudeNativeQuestionText, type ClaudeNativeQuestionPresentation } from './nativeQuestionScreen';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './types';

export { matchesClaudeNativeQuestionScreen, parseClaudeNativeQuestionScreen, type ClaudeNativeQuestionPresentation } from './nativeQuestionScreen';

export type ClaudeNativeQuestionAnswerResult =
  | Readonly<{ status: 'answered' | 'not_visible' | 'submitted' }>
  | Readonly<{ status: 'failed'; reason: string }>;

/** Lives with the hook-correlated prompt, so retry can resume our unchanged draft. */
export type ClaudeNativeQuestionAnswerState = {
  drafts: Map<number, string>;
  questionIndex: number;
  submittedAnswers?: StructuredQuestionAnswersV1;
};

export function resolveClaudeNativeQuestionWithAnswerState(
  presentation: ClaudeNativeQuestionPresentation,
  questions: readonly StructuredQuestionLike[],
  state?: ClaudeNativeQuestionAnswerState,
): ReturnType<typeof resolveClaudeNativeQuestionScreen> {
  const draft = state?.drafts.get(state.questionIndex);
  // The hook identifies this occurrence. Its sole question has one page even
  // when the viewport hides the heading; options and drafts still need to match.
  const index = questions.length === 1 ? 0
    : draft !== undefined && presentation.freeformIndex !== null
      && doesClaudeOwnedTextMatchCapture(draft, presentation.options[presentation.freeformIndex]!.label)
      ? state?.questionIndex : undefined;
  return resolveClaudeNativeQuestionScreen(presentation, questions, index);
}

/** Structural evidence only: never include terminal text, questions, choices or answers. */
export type ClaudeNativeQuestionFailure = Readonly<{
  reason: string;
  questionIndex: number;
  questionCount: number;
  lastInput: TerminalSpecialKey | 'text' | null;
  ownedDraftLength: number | null;
  screen: Readonly<{
    kind: ClaudeNativeQuestionPresentation['kind'];
    answeredTabs: readonly boolean[] | null;
    questionVisible: boolean;
    notes: ClaudeNativeQuestionPresentation['notes'];
    nextFocused: boolean;
    options: readonly Readonly<{ focused: boolean; checked: boolean | null }>[];
    freeform: Readonly<{ length: number; lines: number }> | null;
    reviewAnswers: readonly Readonly<{ length: number; lines: number }>[];
  }> | null;
}>;

export async function answerClaudeNativeQuestion(params: Readonly<{
  port: TerminalControlPort;
  questions: readonly StructuredQuestionLike[];
  answers: StructuredQuestionAnswersV1;
  state?: ClaudeNativeQuestionAnswerState | undefined;
  isCurrent: () => boolean;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
  verifyPollIntervalMs?: number | undefined;
  verifyPollTimeoutMs?: number | undefined;
  verifyApplied?: (() => 'pending' | 'matched' | 'mismatched') | undefined;
  onFailure?: ((failure: ClaudeNativeQuestionFailure) => void) | undefined;
}>): Promise<ClaudeNativeQuestionAnswerResult> {
  let presentation: ClaudeNativeQuestionPresentation | null = null;
  const state = params.state ?? { drafts: new Map<number, string>(), questionIndex: -1 };
  let questionIndex = state.questionIndex;
  let lastInput: ClaudeNativeQuestionFailure['lastInput'] = null;
  const ownDrafts = state.drafts;
  const textShape = (text: string) => ({ length: text.length, lines: text.split('\n').length });
  const failed = (reason: string): ClaudeNativeQuestionAnswerResult => {
    if (params.onFailure) {
      const draft = presentation?.freeformIndex == null ? null : presentation.options[presentation.freeformIndex];
      params.onFailure({ reason, questionIndex, questionCount: params.questions.length, lastInput,
        ownedDraftLength: ownDrafts.get(questionIndex)?.length ?? null,
        screen: presentation ? {
          kind: presentation.kind, answeredTabs: presentation.tabs?.map((tab) => tab.answered) ?? null,
          questionVisible: presentation.question !== null, notes: presentation.notes, nextFocused: presentation.nextFocused,
          options: presentation.options.map(({ focused, checked }) => ({ focused, checked })),
          freeform: draft ? textShape(draft.label) : null,
          reviewAnswers: presentation.reviewAnswers.map((answer) => textShape(answer.answer)),
        } : null,
      });
    }
    return { status: 'failed', reason };
  };
  let answers: StructuredQuestionAnswersV1;
  try {
    const publication = normalizeClaudeAskUserQuestionInputForPublication('AskUserQuestion', { questions: params.questions }, { native: true }) as { questions: readonly StructuredQuestionLike[] };
    answers = normalizeStructuredQuestionAnswersV1(params.answers, publication.questions);
  } catch {
    return failed('invalid_question_answers');
  }
  const normalized = normalizeStructuredQuestionDescriptors(params.questions);
  if (!normalized.ok) return failed('invalid_questions');
  const questions = normalized.questions;
  const providerAnswers = buildNativeAskUserQuestionAnswersForClaude(params.questions, answers);
  const desired = questions.map((question) => {
    const values = question.keys.flatMap((key) => answers[key] ? [answers[key]!] : [])[0] ?? [];
    const selected = question.options.flatMap((option, index) => values.includes(option.answerValue) ? [index] : []);
    const freeform = values.filter((value) => !question.options.some((option) => option.answerValue === value));
    return { selected, freeform, rendered: providerAnswers[question.responseKey]! };
  });
  // Inline native text entry has one row. A placeholder-shaped value cannot be distinguished
  // from that empty row in a plain capture, and Enter on the empty row declines the whole tool.
  const unrepresentable = desired.some((answer) => answer.freeform.length > 1 || answer.freeform.some((text) => (
    !text.trim() || /^Type something\.?$/u.test(text) || hasUnsupportedClaudeNativeTextControls(text)
  )));
  if (unrepresentable) return failed('native_freeform_unrepresentable');

  const interval = Math.max(1, params.verifyPollIntervalMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollIntervalMs);
  const timeout = Math.max(interval, params.verifyPollTimeoutMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollTimeoutMs);
  const verifySubmission = async (): Promise<ClaudeNativeQuestionAnswerResult> => {
    for (let poll = 0; poll < Math.ceil(timeout / interval); poll += 1) {
      await params.wait(poll === 0 ? params.settleMs : interval);
      const applied = params.verifyApplied!();
      if (applied === 'matched') return { status: 'answered' };
      if (applied === 'mismatched') return failed('native_answer_mismatch');
    }
    // The existing hook/transcript observer still owns eventual settlement. A retry
    // checks that result again; it must never send a second set of answers.
    return { status: 'submitted' };
  };
  if (state.submittedAnswers) {
    if (!deepEqual(state.submittedAnswers, answers)) return failed('native_question_already_submitted');
    return params.verifyApplied ? verifySubmission() : { status: 'submitted' };
  }

  // Native rendering makes logical newlines and visual wraps indistinguishable. Only an exact
  // payload written by this operation may use a display comparison across those boundaries.
  const draftMatches = (index: number, actual: string, expected: string): boolean => (
    ownDrafts.get(index) === expected
      ? doesClaudeOwnedTextMatchCapture(expected, actual)
      : !actual.includes('\n') && actual === expected
  );

  let completionVisible = false;
  let captureReason: string | null = null;
  const capture = async (): Promise<boolean> => {
    if (!params.isCurrent()) { captureReason = 'request_retired'; return false; }
    const result = await captureScreenState(params.port);
    if (result.kind !== 'state') {
      captureReason = result.kind === 'host_dead' ? `host_dead:${result.recoverable ? 'recoverable' : 'unrecoverable'}` : result.reason;
      return false;
    }
    presentation = result.state.nativeQuestionPresentation;
    const match = presentation ? resolveClaudeNativeQuestionWithAnswerState(presentation, params.questions, state) : null;
    questionIndex = match?.kind === 'question' ? match.questionIndex : -1;
    if (questionIndex >= 0) state.questionIndex = questionIndex;
    completionVisible = result.state.inputBoxInteractive || result.state.generating;
    if (presentation && !match) {
      captureReason = 'native_question_changed'; return false;
    }
    // Notes belong to the terminal user, including an empty active editor.
    // Check before navigation as well as submission: arrow/tab keys can edit them.
    if (presentation && presentation.notes !== 'none') {
      captureReason = presentation.notes === 'editing' ? 'local_notes_editor_active' : 'local_notes_draft_present'; return false;
    }
    return true;
  };
  const send = async (key: TerminalSpecialKey | { text: string }): Promise<boolean> => {
    if (!params.isCurrent()) { captureReason = 'request_retired'; return false; }
    const result = typeof key === 'string'
      ? await params.port.sendSpecialKey(key)
      : hasMultilinePayload(key.text) || key.text.includes('\t')
        ? await params.port.sendRawSequence(wrapBracketedPaste(key.text))
        : await params.port.sendLiteralText(key.text);
    const failure = sendResultToFailure(result);
    if (failure) { captureReason = ('reason' in failure ? failure.reason : undefined) ?? failure.kind; return false; }
    lastInput = typeof key === 'string' ? key : 'text';
    return true;
  };
  const refresh = async (ready: () => boolean = () => true, reason = 'native_question_disappeared_during_edit'): Promise<boolean> => {
    // Terminal writes acknowledge delivery, not the next rendered frame. Reuse the
    // control owner's verification window without replaying the write.
    for (let poll = 0; poll < Math.ceil(timeout / interval); poll += 1) {
      await params.wait(poll === 0 ? params.settleMs : interval);
      if (!await capture()) return false;
      if (presentation && ready()) return true;
    }
    captureReason = reason;
    return false;
  };
  if (!await capture()) return failed(captureReason!);
  if (!presentation && !await refresh()) return failed(captureReason!);
  const read = (): ClaudeNativeQuestionPresentation => presentation!;
  const reviewMatches = (screen: ClaudeNativeQuestionPresentation): boolean => (
    screen.kind === 'review'
    && (screen.reviewClipped ? seenPages.size === questions.length : screen.reviewAnswers.length === questions.length)
    && screen.reviewAnswers.every((answer, visibleIndex) => {
      const index = questions.length - screen.reviewAnswers.length + visibleIndex;
      return ownDrafts.has(index)
        ? doesClaudeOwnedTextMatchCapture(desired[index]!.rendered, answer.answer)
        : desired[index]!.freeform.length === 0
          ? matchesClaudeNativeQuestionText(answer.answer, desired[index]!.rendered)
          : answer.answer === desired[index]!.rendered;
    })
  );
  const conflict = (index: number): string | null => {
    const screen = read();
    const target = desired[index]!;
    const question = questions[index]!;
    const draft = screen.freeformIndex === null ? null : screen.options[screen.freeformIndex]!;
    const draftText = !draft || /^Type something\.?$/u.test(draft.label) ? '' : draft.label;
    if (screen.options.slice(0, question.options.length).some((option, optionIndex) => option.checked === true && !target.selected.includes(optionIndex))) return 'local_selection_conflict';
    return draftText && !draftMatches(index, draftText, target.freeform[0] ?? '') ? 'local_freeform_conflict' : null;
  };
  const moveTo = async (target: number, index: number): Promise<boolean> => {
    // The bound is the exact visible row count, including native multi-select's Next row.
    const steps = read().options.length + Number(read().multiSelect);
    for (let step = 0; step <= steps; step += 1) {
      if (read().kind !== 'question' || questionIndex !== index) { captureReason = 'native_question_navigation_changed'; return false; }
      const reason = conflict(index);
      if (reason) { captureReason = reason; return false; }
      const current = read().nextFocused ? read().options.length : read().options.findIndex((option) => option.focused);
      if (current === target) return true;
      if (!await send(target > current ? 'ArrowDown' : 'ArrowUp') || !await refresh(() =>
        read().nextFocused ? current !== read().options.length : read().options.findIndex((option) => option.focused) !== current,
      'selection_did_not_move')) return false;
    }
    captureReason = 'selection_target_unreachable'; return false;
  };
  // Native tabs retain independent drafts. Inspect from the first page even when the human
  // has browsed ahead or opened Submit, so every answer is matched against its real options.
  if (read().kind === 'review') {
    if (!await send('ShiftTab') || !await refresh(() => read().kind === 'question', 'native_question_navigation_stalled')) return failed(captureReason!);
    if (read().kind !== 'question' || questionIndex !== questions.length - 1) return failed('native_question_navigation_stalled');
  }
  for (let index = questionIndex; index > 0; index -= 1) {
    if (!await send('ShiftTab') || !await refresh(() => questionIndex === index - 1, 'native_question_navigation_stalled')) return failed(captureReason!);
    if (read().kind !== 'question' || questionIndex !== index - 1) return failed('native_question_navigation_stalled');
  }
  const seenPages = new Set<number>();
  let submitted = false;
  while (!submitted) {
    const screen = read();
    if (screen.kind === 'review') {
      if (!reviewMatches(screen)) return failed('native_review_answers_mismatch');
      if (!screen.options[0]!.focused) {
        if (!await send('ArrowUp') || !await refresh(() => read().options[0]!.focused, 'native_review_changed')) return failed(captureReason!);
        if (!read().options[0]!.focused || !reviewMatches(read())) return failed('native_review_changed');
      }
      if (!await send('Enter')) return failed(captureReason!);
      submitted = true;
      continue;
    }
    const index = questionIndex;
    if (index < 0 || seenPages.has(index)) return failed('native_question_navigation_stalled');
    seenPages.add(index);
    const reason = conflict(index);
    if (reason) return failed(reason);
    const question = questions[index]!;
    const target = desired[index]!;
    for (const optionIndex of target.selected) {
      if (read().options[optionIndex]!.checked === true) continue;
      if (!await moveTo(optionIndex, index)) return failed(captureReason!);
      const before = read();
      if (!await send('Enter')) return failed(captureReason!);
      if (!question.multiSelect && questions.length === 1) { submitted = true; break; }
      if (!await refresh(() => question.multiSelect ? read().options[optionIndex]?.checked === true
        : !deepEqual(read(), before), 'native_selection_not_applied')) return failed(captureReason!);
      if (!question.multiSelect) break;
      if (read().options[optionIndex]?.checked !== true) return failed('native_selection_not_applied');
    }
    if (submitted) continue;
    if (target.freeform.length > 0) {
      const freeformIndex = question.options.length;
      if (!await moveTo(freeformIndex, index)) return failed(captureReason!);
      const freeformText = target.freeform[0]!;
      if (!draftMatches(index, read().options[freeformIndex]!.label, freeformText)) {
        if (!await send({ text: freeformText })) return failed(captureReason!);
        ownDrafts.set(index, freeformText);
        if (!await refresh(() => questionIndex === index
          && draftMatches(index, read().options[freeformIndex]?.label ?? '', freeformText), 'native_freeform_not_applied')) return failed(captureReason!);
        if (questionIndex !== index || conflict(index) || !draftMatches(index, read().options[freeformIndex]?.label ?? '', freeformText)) return failed('native_freeform_not_applied');
      }
      if (!question.multiSelect || read().options[freeformIndex]!.checked !== true) {
        const before = read();
        if (!await send('Enter')) return failed(captureReason!);
        if (!question.multiSelect && questions.length === 1) { submitted = true; continue; }
        if (!await refresh(() => question.multiSelect ? read().options[freeformIndex]?.checked === true
          : !deepEqual(read(), before), 'native_selection_not_applied')) return failed(captureReason!);
        if (question.multiSelect && read().options[freeformIndex]?.checked !== true) return failed('native_selection_not_applied');
      }
    }
    if (question.multiSelect || read().kind === 'question' && questionIndex === index) {
      if (!await send('Tab') || !await refresh(() => read().kind === 'review' || questionIndex !== index || read().nextFocused, 'native_question_navigation_stalled')) return failed(captureReason!);
      // In Claude's multiline editor Tab first leaves text entry for the same page's Next row.
      if (read().kind === 'question' && questionIndex === index && read().nextFocused) {
        const reason = conflict(index);
        if (reason) return failed(reason);
        if (!await send('Enter') || !await refresh(() => read().kind === 'review' || questionIndex !== index, 'native_question_navigation_stalled')) return failed(captureReason!);
      }
    }
  }
  state.submittedAnswers = answers;
  if (params.verifyApplied) return verifySubmission();
  for (let poll = 0; poll < Math.ceil(timeout / interval); poll += 1) {
    await params.wait(poll === 0 ? params.settleMs : interval);
    // A hook may retire the exact occurrence immediately after native submission.
    if (!params.isCurrent()) return { status: 'answered' };
    if (!await capture()) return failed(captureReason!);
    if (!presentation && completionVisible) return { status: 'answered' };
    if (!presentation) continue;
    if (read().kind !== 'review' && questions.length > 1) return failed('native_question_changed_after_submit');
  }
  return failed(presentation ? 'native_question_still_visible' : 'native_question_completion_unverified');
}
