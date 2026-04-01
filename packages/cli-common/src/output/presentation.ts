import chalk from 'chalk';

type ChalkLike = typeof chalk;

export type TerminalStyles = Readonly<{
  ansiEnabled: () => boolean;
  bold: (value: unknown) => string;
  dim: (value: unknown) => string;
  gray: (value: unknown) => string;
  red: (value: unknown) => string;
  green: (value: unknown) => string;
  yellow: (value: unknown) => string;
  blue: (value: unknown) => string;
  magenta: (value: unknown) => string;
  cyan: (value: unknown) => string;
}>;

export type BannerOptions = Readonly<{
  subtitle?: string;
  prefix?: string;
  suffix?: string;
}>;

export type DefinitionListRow = Readonly<{
  label: string;
  value: string;
}>;

export type DefinitionListOptions = Readonly<{
  indent?: string;
}>;

export type FrameTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export type FrameOptions = Readonly<{
  indent?: string;
}>;

export type ChecklistState = 'pending' | 'running' | FrameTone;

export type ChecklistItem = Readonly<{
  state: ChecklistState;
  label: string;
  details?: readonly string[];
}>;

export type ChecklistOptions = Readonly<{
  indent?: string;
  detailsIndent?: string;
}>;

function normalizeText(value: unknown): string {
  return String(value ?? '');
}

function hasColor(chalkLike: ChalkLike): boolean {
  return chalkLike.level > 0;
}

function createStyles(chalkLike: ChalkLike): TerminalStyles {
  const wrap = (fn: (value: string) => string) => (value: unknown): string => fn(normalizeText(value));
  return {
    ansiEnabled: () => hasColor(chalkLike),
    bold: wrap((value) => chalkLike.bold(value)),
    dim: wrap((value) => chalkLike.dim(value)),
    gray: wrap((value) => chalkLike.gray(value)),
    red: wrap((value) => chalkLike.red(value)),
    green: wrap((value) => chalkLike.green(value)),
    yellow: wrap((value) => chalkLike.yellow(value)),
    blue: wrap((value) => chalkLike.blue(value)),
    magenta: wrap((value) => chalkLike.magenta(value)),
    cyan: wrap((value) => chalkLike.cyan(value)),
  };
}

function iconFor(chalkLike: ChalkLike, symbol: string): string {
  return hasColor(chalkLike) ? normalizeText(symbol) : '';
}

function normalizeRows(rows: readonly Readonly<{ label: string; value: string }>[]): DefinitionListRow[] {
  return rows
    .map((row) => ({
      label: normalizeText(row.label).trim(),
      value: normalizeText(row.value),
    }))
    .filter((row) => row.label.length > 0);
}

function definitionListImpl(
  chalkLike: ChalkLike,
  rows: readonly Readonly<{ label: string; value: string }>[],
  options: DefinitionListOptions = {},
): string {
  const entries = normalizeRows(rows);
  if (entries.length === 0) return '';

  const indent = normalizeText(options.indent ?? '');
  const width = entries.reduce((maxWidth, entry) => Math.max(maxWidth, `${entry.label}:`.length), 0);

  return entries
    .map((entry) => {
      const label = `${entry.label}:`.padEnd(width);
      return `${indent}${chalkLike.gray(label)} ${entry.value}`;
    })
    .join('\n');
}

function statusSymbolFor(chalkLike: ChalkLike, tone: 'success' | 'warning' | 'error' | 'info' | 'neutral'): string {
  const symbol = tone === 'success'
    ? '✓'
    : tone === 'warning'
      ? '!'
      : tone === 'error'
        ? 'x'
        : '•';
  if (!hasColor(chalkLike)) return symbol;
  if (tone === 'success') return chalkLike.green(symbol);
  if (tone === 'warning') return chalkLike.yellow(symbol);
  if (tone === 'error') return chalkLike.red(symbol);
  if (tone === 'info') return chalkLike.cyan(symbol);
  return chalkLike.gray(symbol);
}

function statusLineImpl(
  chalkLike: ChalkLike,
  tone: FrameTone,
  message?: string,
): string {
  const symbol = statusSymbolFor(chalkLike, tone);
  const text = normalizeText(message ?? '');
  return text ? `${symbol} ${text}` : symbol;
}

function checklistSymbolFor(chalkLike: ChalkLike, state: ChecklistState): string {
  if (state === 'pending' || state === 'running') {
    const symbol = '..';
    if (!hasColor(chalkLike)) return symbol;
    return chalkLike.cyan(symbol);
  }
  return statusSymbolFor(chalkLike, state);
}

function frameImpl(
  chalkLike: ChalkLike,
  tone: FrameTone,
  title: string,
  details: readonly string[] = [],
  options: FrameOptions = {},
): string {
  const indent = normalizeText(options.indent ?? '  ') || '  ';
  const lines: string[] = [statusLineImpl(chalkLike, tone, title)];
  for (const detail of details) {
    const normalized = normalizeText(detail);
    if (!normalized) continue;
    lines.push(chalkLike.gray(`${indent}${normalized}`));
  }
  return lines.join('\n');
}

function checklistImpl(
  chalkLike: ChalkLike,
  items: readonly ChecklistItem[] = [],
  options: ChecklistOptions = {},
): string {
  const indent = normalizeText(options.indent ?? '');
  const detailsIndent = normalizeText(options.detailsIndent ?? '  ') || '  ';

  const lines: string[] = [];
  for (const item of items ?? []) {
    const label = normalizeText(item?.label ?? '').trim();
    if (!label) continue;
    const state = (item?.state ?? 'neutral') as ChecklistState;
    const symbol = checklistSymbolFor(chalkLike, state);
    lines.push(`${indent}- [${symbol}] ${label}`);

    for (const detail of item?.details ?? []) {
      const normalized = normalizeText(detail);
      if (!normalized) continue;
      lines.push(`${indent}${chalkLike.gray(`${detailsIndent}${normalized}`)}`);
    }
  }

  return lines.join('\n');
}

function createPresentation(chalkLike: ChalkLike) {
  const cmd = (value: string): string => chalkLike.yellow(normalizeText(value));
  const ok = (message?: string): string => statusLineImpl(chalkLike, 'success', message);
  const warn = (message?: string): string => statusLineImpl(chalkLike, 'warning', message);
  const fail = (message?: string): string => statusLineImpl(chalkLike, 'error', message);
  const info = (message?: string): string => statusLineImpl(chalkLike, 'info', message);
  const neutral = (message?: string): string => statusLineImpl(chalkLike, 'neutral', message);
  const kv = (label: string, value: string): string => `${chalkLike.dim(normalizeText(label))} ${normalizeText(value)}`;
  const sectionTitle = (title: string): string => chalkLike.bold(normalizeText(title));
  const emphasis = (value: string): string => chalkLike.bold(normalizeText(value));
  const banner = (title: string, options: BannerOptions = {}): string => {
    const prefix = iconFor(chalkLike, options.prefix ?? '✨');
    const suffix = iconFor(chalkLike, options.suffix ?? '✨');
    const titleLine = `${prefix ? `${prefix} ` : ''}${chalkLike.cyan(normalizeText(title))}${suffix ? ` ${suffix}` : ''}`;
    const lines = [chalkLike.bold(titleLine)];
    const subtitle = normalizeText(options.subtitle ?? '');
    if (subtitle) lines.push(chalkLike.dim(subtitle));
    return lines.join('\n');
  };
  const bullets = (lines: readonly (string | null | undefined)[]): string => {
    return (lines ?? [])
      .map((line) => (line === null || line === undefined ? null : `- ${normalizeText(line)}`))
      .filter((line): line is string => line !== null)
      .join('\n');
  };
  const definitionList = (
    rows: readonly Readonly<{ label: string; value: string }>[],
    options: DefinitionListOptions = {},
  ): string => definitionListImpl(chalkLike, rows, options);
  const table = definitionList;
  const errorFrame = (title: string, details: readonly string[] = []): string => {
    const lines = [chalkLike.red(normalizeText(title))];
    for (const detail of details) {
      const normalized = normalizeText(detail);
      if (!normalized) continue;
      lines.push(chalkLike.gray(`  ${normalized}`));
    }
    return lines.join('\n');
  };
  const frame = (tone: FrameTone, title: string, details: readonly string[] = [], options: FrameOptions = {}): string =>
    frameImpl(chalkLike, tone, title, details, options);
  const checklist = (items: readonly ChecklistItem[], options: ChecklistOptions = {}): string =>
    checklistImpl(chalkLike, items, options);

  return {
    cmd,
    ok,
    warn,
    fail,
    info,
    neutral,
    kv,
    sectionTitle,
    emphasis,
    banner,
    bullets,
    definitionList,
    table,
    errorFrame,
    frame,
    checklist,
  } as const;
}

export function createTerminalPresentation(chalkLike: ChalkLike = chalk) {
  return createPresentation(chalkLike);
}

export const terminalPresentation = createTerminalPresentation();

export function createTerminalStyles(chalkLike: ChalkLike = chalk) {
  return createStyles(chalkLike);
}

export const terminalStyles = createTerminalStyles();

export const {
  cmd,
  ok,
  warn,
  fail,
  info,
  neutral,
  kv,
  sectionTitle,
  emphasis,
  banner,
  bullets,
  definitionList,
  table,
  errorFrame,
  frame,
  checklist,
} = terminalPresentation;

export const { ansiEnabled, bold, dim, gray, red, green, yellow, blue, magenta, cyan } = terminalStyles;
