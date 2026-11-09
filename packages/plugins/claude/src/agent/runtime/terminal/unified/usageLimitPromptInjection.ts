import type { TerminalControlPort } from '@happier-dev/plugin-sdk/agents/runtime';

import { captureScreenState } from './tuiControls/controlRuntime.js';

/** Called only inside the input arbiter's serialized injection, before prompt bytes. */
export async function releaseUsageLimitDialogBeforePromptInjection(input: Readonly<{
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  settleMs: number;
}>): Promise<void> {
  const before = await captureScreenState(input.port);
  if (before.kind !== 'state') throw new Error('claude_usage_dialog_capture_unavailable');
  if (!before.state.usageLimitDialogVisible) return;
  const sent = await input.port.sendSpecialKey('Escape');
  if (sent.status !== 'sent') throw new Error(`claude_usage_dialog_escape_${sent.status}`);
  await input.wait(input.settleMs);
  const after = await captureScreenState(input.port);
  if (after.kind !== 'state' || after.state.usageLimitDialogVisible) {
    throw new Error('claude_usage_dialog_not_released');
  }
}
