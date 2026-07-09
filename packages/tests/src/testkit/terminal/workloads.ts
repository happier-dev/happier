import { concatBytes, utf8Bytes } from './ansi';

export const TERMINAL_WORKLOAD_IDS = [
  'ansi-burst',
  'heavy-tui-redraw',
  'alternate-screen',
  'cursor-style-churn',
  'wide-combining',
  'invalid-utf8-binary',
  'bracketed-paste-echo',
  'link-heavy-output',
  'long-scrollback',
] as const;

export type TerminalWorkloadId = typeof TERMINAL_WORKLOAD_IDS[number];

export type TerminalWorkload = Readonly<{
  id: TerminalWorkloadId;
  description: string;
  bytes: Uint8Array;
  byteLength: number;
}>;

function lines(prefix: string, count: number, render: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${render(index)}\r\n`).join('');
}

function makeWorkload(
  id: TerminalWorkloadId,
  description: string,
  bytes: Uint8Array,
): TerminalWorkload {
  return Object.freeze({
    id,
    description,
    bytes,
    byteLength: bytes.byteLength,
  });
}

function buildHeavyTuiRedraw(): string {
  const frames = Array.from({ length: 48 }, (_, frame) => {
    const rows = Array.from({ length: 18 }, (_, row) => {
      const progress = (frame + row) % 40;
      return `\u001b[${row + 1};1H\u001b[38;5;${(frame + row) % 216}mrow=${row.toString().padStart(2, '0')} ${'█'.repeat(progress)}${' '.repeat(40 - progress)}`;
    }).join('');
    return `\u001b[?1049h\u001b[2J\u001b[Hframe=${frame.toString().padStart(3, '0')}${rows}`;
  }).join('');
  return `${frames}\u001b[?1049l`;
}

function buildCursorStyleChurn(): string {
  return Array.from({ length: 128 }, (_, index) => {
    const row = (index % 24) + 1;
    const col = ((index * 7) % 80) + 1;
    const color = 16 + (index % 200);
    return `\u001b[${row};${col}H\u001b[38;5;${color}mcell-${index}\u001b[0m`;
  }).join('');
}

function buildLinkHeavyOutput(): string {
  return lines('', 64, (index) => {
    const label = `artifact-${index.toString().padStart(2, '0')}`;
    return `\u001b]8;;https://example.invalid/build/${index}\u0007${label}\u001b]8;;\u0007 status=ok`;
  });
}

function buildLongScrollback(): string {
  return lines('', 1_024, (index) => {
    const padded = index.toString().padStart(4, '0');
    return `scrollback line ${padded} :: ${'terminal-output '.repeat(4)}`;
  });
}

const WORKLOADS: readonly TerminalWorkload[] = Object.freeze([
  makeWorkload(
    'ansi-burst',
    'Dense ANSI color and style output without terminal state resets.',
    utf8Bytes(lines('', 256, (index) => `\u001b[3${index % 8}mansi burst ${index.toString().padStart(3, '0')}\u001b[0m`)),
  ),
  makeWorkload(
    'heavy-tui-redraw',
    'Alternate-screen redraw workload with repeated cursor home/paint cycles.',
    utf8Bytes(buildHeavyTuiRedraw()),
  ),
  makeWorkload(
    'alternate-screen',
    'Minimal alternate-screen enter, clear, content, and exit sequence.',
    utf8Bytes('\u001b[?1049h\u001b[2J\u001b[Hinside alternate screen\r\n\u001b[?1049lback to main\r\n'),
  ),
  makeWorkload(
    'cursor-style-churn',
    'Cursor movement and SGR churn across many cells.',
    utf8Bytes(buildCursorStyleChurn()),
  ),
  makeWorkload(
    'wide-combining',
    'Wide glyphs, emoji, and combining characters for renderer width handling.',
    utf8Bytes('wide: 表🙂 e\u0301 a\u0308 Z͑͗͂\r\nbox: ┌─┬─┐\r\n     │✓│⚙│\r\n     └─┴─┘\r\n'),
  ),
  makeWorkload(
    'invalid-utf8-binary',
    'Arbitrary binary bytes that must survive base64 and byte-ring round trips.',
    concatBytes([
      utf8Bytes('binary-prefix\r\n'),
      new Uint8Array([0x00, 0x1b, 0x80, 0xc0, 0xff, 0xfe, 0x7f, 0x9b]),
      utf8Bytes('\r\nbinary-suffix\r\n'),
    ]),
  ),
  makeWorkload(
    'bracketed-paste-echo',
    'Bracketed paste enablement plus echoed paste delimiters.',
    utf8Bytes('\u001b[?2004hready\r\n\u001b[200~line one\nline two\u001b[201~\r\n\u001b[?2004l'),
  ),
  makeWorkload(
    'link-heavy-output',
    'OSC 8 hyperlink-heavy output for link extraction and sanitization.',
    utf8Bytes(buildLinkHeavyOutput()),
  ),
  makeWorkload(
    'long-scrollback',
    'Large scrollback output for bounded replay and truncation validation.',
    utf8Bytes(buildLongScrollback()),
  ),
]);

export function listTerminalWorkloads(): readonly TerminalWorkload[] {
  return WORKLOADS;
}

export function getTerminalWorkload(id: TerminalWorkloadId): TerminalWorkload {
  const workload = WORKLOADS.find((item) => item.id === id);
  if (!workload) {
    throw new Error(`Unknown terminal workload: ${id}`);
  }
  return workload;
}
