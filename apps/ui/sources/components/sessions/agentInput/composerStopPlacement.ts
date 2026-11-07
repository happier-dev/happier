/**
 * Where the composer's one Stop renders while the turn can be stopped (calm-shell P3 §3.3, lab C2run).
 *
 * - `trailing`: the send disc becomes Stop. This is the empty composer, the common case.
 * - `rail`: the disc has something else to do (send or queue the draft, an armed switch, Dictation),
 *   so Stop is the separate chip at the end of the chip rail.
 *
 * Exactly one of the two renders; the composer never shows two equivalent Stops.
 */
export type ComposerStopPlacement = 'trailing' | 'rail' | null;

export function resolveComposerStopPlacement(
  input: Readonly<{
    /** The host offers Stop now (`onAbort` and `showAbortButton`). */
    canStop: boolean;
    /** The send disc is mounted and may act (not controls-only, submit enabled). */
    trailingAvailable: boolean;
    /** The disc would send: text, attachments, or an armed switch. */
    hasSendIntent: boolean;
    /** The disc carries the microphone, or a Dictation is in flight. */
    dictationHoldsTrailing: boolean;
  }>,
): ComposerStopPlacement {
  if (!input.canStop) return null;
  return input.trailingAvailable &&
    !input.hasSendIntent &&
    !input.dictationHoldsTrailing
    ? 'trailing'
    : 'rail';
}
