import { stripAnsi } from './text.mjs';

function tryConsumeAnsiSequence(s, i) {
  // Best-effort for CSI sequences like: ESC [ 1;31m
  if (s[i] !== '\x1b' || s[i + 1] !== '[') return null;
  let j = i + 2;
  while (j < s.length) {
    const ch = s[j];
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      return { seq: s.slice(i, j + 1), next: j + 1 };
    }
    j += 1;
  }
  return null;
}

export function formatBoxLine({ text, width, allowAnsi }) {
  const w = Math.max(0, Number(width) || 0);
  const raw = String(text ?? '');

  if (!allowAnsi) {
    const clean = stripAnsi(raw);
    if (clean.length >= w) return clean.slice(0, w);
    return clean + ' '.repeat(w - clean.length);
  }

  let out = '';
  let visible = 0;
  for (let i = 0; i < raw.length && visible < w; ) {
    const ansi = tryConsumeAnsiSequence(raw, i);
    if (ansi) {
      out += ansi.seq;
      i = ansi.next;
      continue;
    }
    out += raw[i];
    i += 1;
    visible += 1;
  }

  const hasAnsi = out.includes('\x1b[');
  if (hasAnsi) out += '\x1b[0m';
  if (visible < w) out += ' '.repeat(w - visible);
  return out;
}

