import type { TerminalHostKind } from './inputInjection.js';

/**
 * Provider-agnostic terminal-control contract.
 *
 * This is intentionally SEPARATE from {@link TerminalInputInjectionV1}. `injectUserPrompt`
 * is semantically tied to user-message delivery and prompt acceptance; runtime controls
 * (model/effort/permission-mode cycling) must never be routed through it. The control port
 * exposes raw send/capture primitives that a provider-owned controller composes into verified
 * control sequences. `sendLiteralText` does NOT submit — the controller sends Enter separately
 * with a bounded delay so the slash-picker can resolve before submit.
 */

export type TerminalSpecialKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'ShiftTab'
  | 'CtrlC'
  | 'Backspace';

export const TERMINAL_SPECIAL_KEYS: readonly TerminalSpecialKey[] = Object.freeze([
  'Enter',
  'Escape',
  'Tab',
  'ShiftTab',
  'CtrlC',
  'Backspace',
]);

/**
 * Raw terminal sequence for Shift+Tab (ESC [ Z, CSI Z / "back-tab").
 *
 * A live tmux probe proved tmux's named `S-Tab` key does NOTHING, so the ShiftTab control
 * MUST emit these literal bytes. Terminal control ports must never send a named `S-Tab`.
 */
export const TERMINAL_SHIFT_TAB_SEQUENCE = '\u001b[Z';

export type TerminalControlCapture = Readonly<{
  /** Canonical screen text with ANSI/control sequences stripped. */
  text: string;
  /**
   * Raw capture with SGR styling preserved, when the host can produce one. Style-aware parsers
   * (e.g. Claude Unified's dim-placeholder composer detection) prefer this over `text`.
   */
  styledText?: string;
  /** Zero-based terminal cursor position when the host can report it. */
  cursor?: Readonly<{ x: number; y: number }>;
  capturedAtMs: number;
  hostKind: TerminalHostKind;
}>;

export type TerminalControlSendFailureReason = 'host_unreachable' | 'timeout';

/**
 * Why a control operation could not be attempted at all. `no_target` covers a zellij port with
 * no resolved pane id; `capture_unsupported`/`special_key_unsupported` cover host adapters that
 * cannot perform a given primitive. These are typed results, never best-effort writes.
 */
export type TerminalControlUnsupportedReason =
  | 'no_target'
  | 'capture_unsupported'
  | 'special_key_unsupported';

export type TerminalControlSendResult =
  | Readonly<{ status: 'sent'; at: number }>
  | Readonly<{ status: 'unsupported'; reason: TerminalControlUnsupportedReason }>
  | Readonly<{ status: 'host_dead'; recoverable: boolean }>
  | Readonly<{ status: 'failed'; reason: TerminalControlSendFailureReason; detail?: string }>;

export type TerminalControlCaptureResult =
  | Readonly<{ status: 'captured'; capture: TerminalControlCapture }>
  | Readonly<{ status: 'unsupported'; reason: TerminalControlUnsupportedReason }>
  | Readonly<{ status: 'host_dead'; recoverable: boolean }>
  | Readonly<{ status: 'failed'; reason: TerminalControlSendFailureReason; detail?: string }>;

export type TerminalControlPort = Readonly<{
  hostKind: TerminalHostKind;
  /** Type literal text WITHOUT submitting. The controller submits via {@link sendSpecialKey}. */
  sendLiteralText(text: string): Promise<TerminalControlSendResult>;
  /** Send literal escape bytes (e.g. {@link TERMINAL_SHIFT_TAB_SEQUENCE}) without submitting. */
  sendRawSequence(sequence: string): Promise<TerminalControlSendResult>;
  sendSpecialKey(key: TerminalSpecialKey): Promise<TerminalControlSendResult>;
  /** Capture the FULL pane (multi-line), normalized by the shared capture owner. */
  captureScreen(): Promise<TerminalControlCaptureResult>;
}>;
