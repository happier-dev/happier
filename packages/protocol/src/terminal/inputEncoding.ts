import type { TerminalInputEvent } from './input.js';

export const TERMINAL_BRACKETED_PASTE_START = '\u001b[200~';
export const TERMINAL_BRACKETED_PASTE_END = '\u001b[201~';

export type TerminalInputPtyAction =
  | Readonly<{ kind: 'write'; data: string }>
  | Readonly<{ kind: 'resize'; cols: number; rows: number }>
  | Readonly<{ kind: 'noop' }>
  | Readonly<{ kind: 'unsupported'; code: 'terminal_input_unsupported'; message: string }>;

const NAMED_KEY_BYTES = new Map<string, string>([
  ['Enter', '\r'],
  ['Return', '\r'],
  ['Escape', '\u001b'],
  ['Esc', '\u001b'],
  ['Backspace', '\u007f'],
  ['Tab', '\t'],
  ['ArrowUp', '\u001b[A'],
  ['ArrowDown', '\u001b[B'],
  ['ArrowRight', '\u001b[C'],
  ['ArrowLeft', '\u001b[D'],
  ['Home', '\u001b[H'],
  ['End', '\u001b[F'],
  ['Insert', '\u001b[2~'],
  ['Delete', '\u001b[3~'],
  ['PageUp', '\u001b[5~'],
  ['PageDown', '\u001b[6~'],
  ['F1', '\u001bOP'],
  ['F2', '\u001bOQ'],
  ['F3', '\u001bOR'],
  ['F4', '\u001bOS'],
  ['F5', '\u001b[15~'],
  ['F6', '\u001b[17~'],
  ['F7', '\u001b[18~'],
  ['F8', '\u001b[19~'],
  ['F9', '\u001b[20~'],
  ['F10', '\u001b[21~'],
  ['F11', '\u001b[23~'],
  ['F12', '\u001b[24~'],
]);

function hasModifier(event: Extract<TerminalInputEvent, { t: 'key' }>, modifier: 'ctrl' | 'alt' | 'meta'): boolean {
  return event.modifiers.includes(modifier);
}

function normalizePasteText(text: string): string {
  return text.replace(/\r?\n/g, '\r');
}

export function encodeTerminalPasteInput(text: string, bracketed: boolean): string {
  const normalized = normalizePasteText(text);
  return bracketed
    ? `${TERMINAL_BRACKETED_PASTE_START}${normalized}${TERMINAL_BRACKETED_PASTE_END}`
    : normalized;
}

function controlCharacterForKey(key: string): string | null {
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    return String.fromCharCode(code - 64);
  }
  if (key === '?') return '\u007f';
  return null;
}

function encodeTerminalKeyInput(event: Extract<TerminalInputEvent, { t: 'key' }>): string | null {
  let data: string | null = null;
  if (hasModifier(event, 'ctrl')) {
    data = controlCharacterForKey(event.key);
    if (data === null) return null;
  } else if (event.key.length === 1) {
    data = event.key;
  } else {
    data = NAMED_KEY_BYTES.get(event.key) ?? null;
  }
  if (data === null) return null;
  return hasModifier(event, 'alt') || hasModifier(event, 'meta') ? `\u001b${data}` : data;
}

export function terminalInputEventToPtyAction(event: TerminalInputEvent): TerminalInputPtyAction {
  switch (event.t) {
    case 'text':
      return event.text ? { kind: 'write', data: event.text } : { kind: 'noop' };
    case 'paste':
      return event.text ? { kind: 'write', data: encodeTerminalPasteInput(event.text, event.bracketed) } : { kind: 'noop' };
    case 'ime':
      return event.phase === 'commit' && event.text ? { kind: 'write', data: event.text } : { kind: 'noop' };
    case 'key': {
      const data = encodeTerminalKeyInput(event);
      return data === null
        ? { kind: 'unsupported', code: 'terminal_input_unsupported', message: 'terminal_input_unsupported' }
        : { kind: 'write', data };
    }
    case 'resize':
      return { kind: 'resize', cols: event.cols, rows: event.rows };
    case 'mouse':
      return { kind: 'unsupported', code: 'terminal_input_unsupported', message: 'terminal_input_unsupported' };
  }
}
