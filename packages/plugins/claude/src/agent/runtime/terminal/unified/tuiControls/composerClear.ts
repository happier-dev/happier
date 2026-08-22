import type { TerminalControlPort } from '@happier-dev/plugin-sdk/agents/runtime';
import { sleep } from '@happier-dev/plugin-sdk/async';

import type { ClaudeScreenState } from '../screenState.js';
import {
  captureScreenState,
  sendResultToFailure,
  type CaptureFailure,
} from './controlRuntime.js';

export type ClaudeComposerClearRefusalReason =
  | 'generating'
  | 'queued_message_banner'
  | 'permission_prompt'
  | 'permission_editor'
  | 'trust_prompt'
  | 'switch_model_dialog'
  | 'resume_choice_dialog'
  | 'effort_change_dialog'
  | 'unrecognized_confirmation_dialog'
  | 'slash_picker'
  | 'selection_list'
  | 'no_interactive_composer';

export type ClaudeUserAuthorizedComposerClearResult = Readonly<
  | { status: 'cleared'; attempts: number }
  | { status: 'already_empty' }
  | { status: 'refused'; reason: ClaudeComposerClearRefusalReason }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }
>;

export type ClaudeUserAuthorizedComposerClearOptions = Readonly<{
  port: TerminalControlPort;
  wait?: ((ms: number) => Promise<void>) | undefined;
  settleMs?: number | undefined;
  maxAttempts?: number | undefined;
}>;

const DEFAULT_CLEAR_SETTLE_MS = 150;
const DEFAULT_CLEAR_ATTEMPTS = 2;

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function optionalReason(value: string | undefined, fallback: string): string {
  const reason = String(value ?? '').trim();
  return reason || fallback;
}

function mapCaptureFailure(capture: CaptureFailure): ClaudeUserAuthorizedComposerClearResult {
  if (capture.kind === 'host_dead') {
    return { status: 'failed', reason: `host_dead:${capture.recoverable ? 'recoverable' : 'unrecoverable'}` };
  }
  return { status: 'failed', reason: capture.reason };
}

function resolveUnsafeRefusal(state: ClaudeScreenState): ClaudeComposerClearRefusalReason | null {
  if (state.queuedMessageBannerVisible) return 'queued_message_banner';
  if (state.generating) return 'generating';
  if (state.permissionPromptVisible) return 'permission_prompt';
  if (state.permissionEditorOpen) return 'permission_editor';
  if (state.trustFolderPromptVisible) return 'trust_prompt';
  if (state.switchModelDialogVisible) return 'switch_model_dialog';
  if (state.resumeChoiceDialogVisible) return 'resume_choice_dialog';
  if (state.effortChangeDialogVisible) return 'effort_change_dialog';
  if (state.unrecognizedConfirmationDialogVisible) return 'unrecognized_confirmation_dialog';
  if (state.slashPickerOpen) return 'slash_picker';
  if (state.selectionListVisible) return 'selection_list';
  if (!state.inputBoxInteractive || state.composerContent === null) return 'no_interactive_composer';
  return null;
}

function classifyClearableState(state: ClaudeScreenState): ClaudeUserAuthorizedComposerClearResult | 'clearable' {
  const refusal = resolveUnsafeRefusal(state);
  if (refusal) return { status: 'refused', reason: refusal };
  if ((state.composerContent ?? '').length === 0) return { status: 'already_empty' };
  return 'clearable';
}

async function captureClearableState(
  port: TerminalControlPort,
): Promise<ClaudeUserAuthorizedComposerClearResult | 'clearable'> {
  const capture = await captureScreenState(port);
  if (capture.kind !== 'state') return mapCaptureFailure(capture);
  return classifyClearableState(capture.state);
}

export async function clearUserAuthorizedClaudeComposerDraft(
  options: ClaudeUserAuthorizedComposerClearOptions,
): Promise<ClaudeUserAuthorizedComposerClearResult> {
  const wait = options.wait ?? sleep;
  const settleMs = nonNegativeInteger(options.settleMs, DEFAULT_CLEAR_SETTLE_MS);
  const maxAttempts = Math.max(1, nonNegativeInteger(options.maxAttempts, DEFAULT_CLEAR_ATTEMPTS));

  const initial = await captureClearableState(options.port);
  if (initial !== 'clearable') return initial;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const send = await options.port.sendSpecialKey('Escape');
    const failure = sendResultToFailure(send);
    if (failure) {
      return failure.kind === 'unsupported'
        ? { status: 'unsupported', reason: optionalReason(failure.reason, 'send_unsupported') }
        : { status: 'failed', reason: failure.reason };
    }

    await wait(settleMs);
    const after = await captureClearableState(options.port);
    if (after === 'clearable') continue;
    if (after.status === 'already_empty') return { status: 'cleared', attempts: attempt };
    return after;
  }

  return { status: 'failed', reason: 'clear_failed' };
}
