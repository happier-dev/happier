import chalk from 'chalk';

import { createHelpFormatter, type HelpRow } from './help.js';
import { createTerminalPresentation, type BannerOptions } from './presentation.js';

export type HelpPageSection = Readonly<{
  title: string;
  rows: readonly HelpRow[];
  indent?: string;
}>;

export type HelpPageOptions = Readonly<{
  title: string;
  subtitle?: string;
  usage?: readonly HelpRow[];
  sections?: readonly HelpPageSection[];
  notes?: readonly (string | null | undefined)[];
  footer?: readonly (string | null | undefined)[];
}>;

export type RenderHelpPageOptions = Readonly<{
  chalkLike?: typeof chalk;
  banner?: BannerOptions;
}>;

function pushBlank(lines: string[]): void {
  if (lines.length === 0 || lines[lines.length - 1] !== '') {
    lines.push('');
  }
}

function pushRenderedBlock(lines: string[], block: string): void {
  const trimmed = block.trimEnd();
  if (!trimmed) return;
  lines.push(...trimmed.split('\n'));
}

function pushTextLines(lines: string[], values: readonly (string | null | undefined)[], prefix = '- '): void {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    lines.push(`${prefix}${text}`);
  }
}

export function renderHelpPage(page: HelpPageOptions, options: RenderHelpPageOptions = {}): string {
  const presentation = createTerminalPresentation(options.chalkLike ?? chalk);
  const help = createHelpFormatter(options.chalkLike ?? chalk);
  const lines: string[] = [];

  lines.push(presentation.banner(page.title, { subtitle: page.subtitle, ...(options.banner ?? {}) }));

  if (page.usage && page.usage.length > 0) {
    pushBlank(lines);
    lines.push(presentation.sectionTitle('Usage:'));
    pushRenderedBlock(lines, help.renderRows(page.usage, { indent: '  ' }));
  }

  for (const section of page.sections ?? []) {
    if (!section.rows || section.rows.length === 0) continue;
    pushBlank(lines);
    lines.push(presentation.sectionTitle(section.title));
    pushRenderedBlock(lines, help.renderRows(section.rows, { indent: section.indent ?? '  ' }));
  }

  if (page.notes && page.notes.length > 0) {
    pushBlank(lines);
    lines.push(presentation.sectionTitle('Notes:'));
    pushTextLines(lines, page.notes);
  }

  if (page.footer && page.footer.length > 0) {
    pushBlank(lines);
    for (const value of page.footer) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      lines.push(text);
    }
  }

  return lines.join('\n').trimEnd();
}
