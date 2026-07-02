import type { TerminalControlCapture, TerminalHostKind } from '@happier-dev/agents';

/**
 * Single shared owner of terminal capture stripping + normalization.
 *
 * Both the Claude Unified readiness bridge and the TUI runtime-control controller must parse the
 * same normalized screen text, so ANSI/control-sequence stripping lives here once instead of being
 * duplicated per call site. This is for control verification and readiness only — never for
 * screen-derived permission approval.
 */

// Operator Command (OSC): ESC ] ... terminated by BEL (0x07) or String Terminator (ESC backslash).
const OSC_SEQUENCE = new RegExp('\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', 'g');
// Control Sequence Introducer (CSI): ESC [ params intermediates final.
const CSI_SEQUENCE = new RegExp('\\u001b\\[[0-?]*[ -\\/]*[@-~]', 'g');
// Remaining Fe / charset-designation / single-shift escapes: ESC <intermediates> <final>.
const OTHER_ESCAPE_SEQUENCE = new RegExp('\\u001b[ -\\/]*[0-~]', 'g');
// Stray C0 control chars and DEL, excluding TAB (0x09), LF (0x0a), and CR (0x0d).
const STRAY_CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(OTHER_ESCAPE_SEQUENCE, '')
    .replace(STRAY_CONTROL_CHARS, '');
}

/**
 * Strip control sequences, normalize line endings to LF, trim trailing whitespace per line, and
 * drop trailing blank lines (capture-pane right-pads the visible region). Interior blank lines and
 * the full multi-line structure are preserved so the controller can verify multi-line screens.
 */
export function normalizeCapturedScreen(text: string): string {
  const stripped = stripTerminalControlSequences(text);
  const lines = stripped.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

export function buildTerminalControlCapture(params: Readonly<{
  rawText: string;
  hostKind: TerminalHostKind;
  capturedAtMs: number;
}>): TerminalControlCapture {
  return {
    text: normalizeCapturedScreen(params.rawText),
    // Raw capture with styling preserved (when the host produced any): SGR dim is the only honest
    // discriminator between Claude Code's empty-composer suggestion placeholder and a typed draft
    // (ported S-8 / QA-B F6). Parsers normalize internally; `text` stays the canonical stripped form.
    ...(params.rawText.includes('\u001b[') ? { styledText: params.rawText } : {}),
    capturedAtMs: params.capturedAtMs,
    hostKind: params.hostKind,
  };
}
