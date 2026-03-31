import chalk from 'chalk';

export type HelpRow = Readonly<{
  label: string;
  description: string;
  detail?: string;
}>;

export type HelpRenderOptions = Readonly<{
  indent?: string;
  labelWidth?: number;
}>;

type ChalkLike = typeof chalk;

function normalizeText(value: unknown): string {
  return String(value ?? '');
}

function hasColor(chalkLike: ChalkLike): boolean {
  return chalkLike.level > 0;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, '');
}

function resolveLabelWidth(rows: readonly HelpRow[], explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return rows.reduce((max, row) => Math.max(max, stripAnsi(normalizeText(row.label)).length), 0);
}

export function createHelpFormatter(chalkLike: ChalkLike = chalk) {
  const color = hasColor(chalkLike);
  const styleLabel = (value: string) => (color ? chalkLike.cyan(value) : value);
  const styleDesc = (value: string) => (color ? chalkLike.dim(value) : value);

  const renderRows = (rows: readonly HelpRow[], options: HelpRenderOptions = {}): string => {
    const indent = normalizeText(options.indent ?? '  ');
    const labelWidth = resolveLabelWidth(rows, options.labelWidth);
    const blocks: string[] = [];
    for (const row of rows) {
      const label = normalizeText(row.label);
      const description = normalizeText(row.description);
      const detail = normalizeText(row.detail ?? '');
      if (!label && !description && !detail) continue;
      const labelCell = labelWidth > 0 ? label.padEnd(labelWidth) : label;
      const first = `${indent}${styleLabel(labelCell)}  ${styleDesc(description)}`.trimEnd();
      blocks.push(first);
      if (detail) {
        const spacer = labelWidth > 0 ? ' '.repeat(labelWidth) : '';
        blocks.push(`${indent}${spacer}  ${styleDesc(detail)}`.trimEnd());
      }
    }
    return blocks.join('\n');
  };

  return { renderRows } as const;
}

export const helpFormatter = createHelpFormatter();

