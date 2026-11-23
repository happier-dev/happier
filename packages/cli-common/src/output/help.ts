import chalk from 'chalk';

import { ACCENT_HEX } from './presentation.js';
import { stripAnsi } from './stripAnsi.js';

export type HelpRow = Readonly<{
  label: string;
  description: string;
  detail?: string;
}>;

export type HelpRenderOptions = Readonly<{
  indent?: string;
  labelWidth?: number;
  /** Terminal width to fit rows into; defaults to stdout's width on a terminal, and no wrapping otherwise. */
  columns?: number;
}>;

type ChalkLike = typeof chalk;

function normalizeText(value: unknown): string {
  return String(value ?? '');
}

function hasColor(chalkLike: ChalkLike): boolean {
  return chalkLike.level > 0;
}

function resolveLabelWidth(rows: readonly HelpRow[], explicit?: number, columns?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  // A label wider than half the terminal stands on its own line instead of pushing every description right.
  const fits = (length: number) => columns === undefined || length <= Math.floor(columns / 2);
  return rows.reduce((max, row) => {
    const length = stripAnsi(normalizeText(row.label)).length;
    return fits(length) ? Math.max(max, length) : max;
  }, 0);
}

function resolveColumns(options: HelpRenderOptions): number | undefined {
  const columns = 'columns' in options ? options.columns : (process.stdout.isTTY ? process.stdout.columns : undefined);
  return typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : undefined;
}

function wrapWords(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/u).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function createHelpFormatter(chalkLike: ChalkLike = chalk) {
  const color = hasColor(chalkLike);
  const styleLabel = (value: string) => (color ? chalkLike.hex(ACCENT_HEX)(value) : value);
  const styleDesc = (value: string) => (color ? chalkLike.dim(value) : value);

  const renderRows = (rows: readonly HelpRow[], options: HelpRenderOptions = {}): string => {
    const indent = normalizeText(options.indent ?? '  ');
    const columns = resolveColumns(options);
    const labelWidth = resolveLabelWidth(rows, options.labelWidth, columns);
    // A terminal too narrow for a 20-column description column stacks each description under its label.
    const stacked = columns !== undefined && columns - (indent.length + labelWidth + 2) < 20;
    const column = ' '.repeat(stacked ? indent.length + 2 : indent.length + labelWidth + 2);
    // Descriptions wrap under their own column so no row runs past the terminal edge.
    const describe = (text: string): string[] => (columns === undefined || !text
      ? [text]
      : wrapWords(text, Math.max(1, columns - column.length)));
    const blocks: string[] = [];
    for (const row of rows) {
      const label = normalizeText(row.label);
      const description = normalizeText(row.description);
      const detail = normalizeText(row.detail ?? '');
      if (!label && !description && !detail) continue;
      const described = describe(description);
      if (stacked || (stripAnsi(label).length > labelWidth && columns !== undefined)) {
        blocks.push(`${indent}${styleLabel(label)}`);
        for (const line of described) if (line) blocks.push(`${column}${styleDesc(line)}`);
      } else {
        const labelCell = labelWidth > 0 ? label.padEnd(labelWidth) : label;
        blocks.push(`${indent}${styleLabel(labelCell)}  ${styleDesc(described[0] ?? '')}`.trimEnd());
        for (const line of described.slice(1)) blocks.push(`${column}${styleDesc(line)}`);
      }
      for (const line of detail ? describe(detail) : []) blocks.push(`${column}${styleDesc(line)}`.trimEnd());
    }
    return blocks.join('\n');
  };

  return { renderRows } as const;
}

export const helpFormatter = createHelpFormatter();

