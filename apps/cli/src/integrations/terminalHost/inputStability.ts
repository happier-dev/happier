import type { TerminalInputState } from '@happier-dev/agents';

/** How long a host's screen must hold still before its input counts as settled. */
export const TERMINAL_INPUT_STABILITY_DELAY_MS = 50;

type TerminalCursor = Readonly<{ x: number; y: number }>;

export type TerminalInputSample = Readonly<{
  text: string;
  /** Present only on hosts that can report the cursor (tmux, the holder PTY). */
  cursor?: TerminalCursor | null;
}>;

function sameCursor(left: TerminalCursor | null, right: TerminalCursor | null): boolean {
  if (left === null || right === null) return left === right;
  return left.x === right.x && left.y === right.y;
}

/**
 * The one "is the user typing" rule for every terminal host: sample the screen, wait, sample
 * again. Input is stable only when the text and, when the host reports one, the cursor are
 * unchanged. Hosts without a cursor (zellij, herdr) compare text alone.
 */
export async function captureTerminalInputState(params: Readonly<{
  sample: () => Promise<TerminalInputSample>;
  wait: (delayMs: number) => Promise<void>;
  now: () => number;
  delayMs?: number;
}>): Promise<TerminalInputState> {
  const before = await params.sample();
  await params.wait(params.delayMs ?? TERMINAL_INPUT_STABILITY_DELAY_MS);
  const after = await params.sample();
  return {
    stable: before.text === after.text && sameCursor(before.cursor ?? null, after.cursor ?? null),
    currentInput: after.text,
    ...(after.cursor ? { cursor: after.cursor } : {}),
    observedAt: params.now(),
  };
}
