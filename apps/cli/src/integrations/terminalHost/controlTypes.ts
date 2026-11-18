import { TERMINAL_SHIFT_TAB_SEQUENCE } from '@happier-dev/agents';
import type { TerminalSpecialKey } from '@happier-dev/agents';

export { TERMINAL_SHIFT_TAB_SEQUENCE, TERMINAL_SPECIAL_KEYS } from '@happier-dev/agents';

export type {
  TerminalControlCapture,
  TerminalControlCaptureResult,
  TerminalControlPort,
  TerminalControlSendFailureReason,
  TerminalControlSendResult,
  TerminalControlUnsupportedReason,
  TerminalSpecialKey,
} from '@happier-dev/agents';

/**
 * The one raw byte sequence for each {@link TerminalSpecialKey}. The holder PTY writes these
 * bytes for every key. zellij uses them where it has no named action (Tab/ShiftTab/CtrlC/
 * Backspace/arrows) and tmux only for ShiftTab (its named `S-Tab` is a proven no-op); both keep
 * their named Enter/Escape paths.
 */
export const TERMINAL_SPECIAL_KEY_RAW_SEQUENCES: Readonly<Record<TerminalSpecialKey, string>> = Object.freeze({
  Enter: '\r',
  Escape: '\u001b',
  Tab: '\t',
  ArrowUp: '\u001b[A',
  ArrowDown: '\u001b[B',
  ShiftTab: TERMINAL_SHIFT_TAB_SEQUENCE,
  CtrlC: '\u0003',
  Backspace: '\u007f',
});
