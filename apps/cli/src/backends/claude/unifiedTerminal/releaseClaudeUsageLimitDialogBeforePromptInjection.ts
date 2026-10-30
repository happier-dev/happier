import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import { captureScreenState, sendResultToFailure } from './tuiControls/controlRuntime';

const DEFAULT_RELEASE_SETTLE_MS = 250;

export type ClaudeUsageLimitDialogReleaseResult =
  | Readonly<{ status: 'released' }>
  | Readonly<{ status: 'not_visible' }>
  | Readonly<{ status: 'failed'; reason: string }>;

/**
 * Releases only Claude's freshly observed usage-limit dialog inside serialized prompt injection.
 * One Escape dismisses the overlay and a fresh capture verifies closure before any input is written.
 */
export async function releaseClaudeUsageLimitDialogBeforePromptInjection(input: Readonly<{
  port: TerminalControlPort;
  wait?: (ms: number) => Promise<void>;
  settleMs?: number;
}>): Promise<ClaudeUsageLimitDialogReleaseResult> {
  const initial = await captureScreenState(input.port);
  if (initial.kind !== 'state') {
    return { status: 'failed', reason: initial.kind === 'host_dead' ? 'host_dead' : initial.reason };
  }
  if (!initial.state.usageLimitDialogVisible) return { status: 'not_visible' };

  const sendFailure = sendResultToFailure(await input.port.sendSpecialKey('Escape'));
  if (sendFailure) return { status: 'failed', reason: sendFailure.kind };

  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  await wait(Math.max(0, Math.trunc(input.settleMs ?? DEFAULT_RELEASE_SETTLE_MS)));

  const recaptured = await captureScreenState(input.port);
  if (recaptured.kind !== 'state') {
    return { status: 'failed', reason: recaptured.kind === 'host_dead' ? 'host_dead' : recaptured.reason };
  }
  return recaptured.state.usageLimitDialogVisible
    ? { status: 'failed', reason: 'usage_limit_dialog_still_visible' }
    : { status: 'released' };
}
