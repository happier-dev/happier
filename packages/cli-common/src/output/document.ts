import { terminalPresentation, type BannerOptions, type DefinitionListOptions, type DefinitionListRow } from './presentation.js';

export type OutputItem =
  | Readonly<{ kind: 'line'; text: string }>
  | Readonly<{ kind: 'blank' }>
  | Readonly<{ kind: 'bullets'; items: readonly (string | null | undefined)[] }>
  | Readonly<{ kind: 'numbered'; items: readonly (string | null | undefined)[]; start?: number }>
  | Readonly<{ kind: 'definitionList'; rows: readonly DefinitionListRow[]; options?: DefinitionListOptions }>
  | Readonly<{ kind: 'section'; title: string; body: readonly OutputItem[] }>;

export type OutputPresentation = Readonly<{
  banner: (title: string, options?: BannerOptions) => string;
  bullets: (lines: readonly (string | null | undefined)[]) => string;
  definitionList: (rows: readonly DefinitionListRow[], options?: DefinitionListOptions) => string;
  sectionTitle: (title: string) => string;
}>;

export type RenderOutputOptions = Readonly<{
  presentation?: OutputPresentation;
}>;

function normalizePresentation(explicit?: OutputPresentation): OutputPresentation {
  if (explicit) return explicit;
  return {
    banner: terminalPresentation.banner,
    bullets: terminalPresentation.bullets,
    definitionList: terminalPresentation.definitionList,
    sectionTitle: terminalPresentation.sectionTitle,
  };
}

function renderItem(item: OutputItem, presentation: OutputPresentation): string[] {
  if (item.kind === 'blank') return [''];
  if (item.kind === 'line') return [String(item.text ?? '')];
  if (item.kind === 'bullets') {
    const rendered = presentation.bullets(item.items ?? []);
    return rendered ? String(rendered).split('\n') : [];
  }
  if (item.kind === 'numbered') {
    const start = typeof item.start === 'number' ? item.start : 1;
    const normalized = (item.items ?? [])
      .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
      .filter((value) => value.length > 0);
    return normalized.map((value, index) => `${start + index}. ${value}`);
  }
  if (item.kind === 'definitionList') {
    const rendered = presentation.definitionList(item.rows ?? [], item.options);
    return rendered ? String(rendered).split('\n') : [];
  }
  if (item.kind === 'section') {
    const lines: string[] = [presentation.sectionTitle(String(item.title ?? ''))];
    for (const child of item.body ?? []) {
      lines.push(...renderItem(child, presentation));
    }
    return lines;
  }
  return [];
}

export function renderOutputItems(items: readonly OutputItem[], options: RenderOutputOptions = {}): string {
  const presentation = normalizePresentation(options.presentation);
  const lines: string[] = [];
  for (const item of items ?? []) {
    lines.push(...renderItem(item, presentation));
  }
  return lines.join('\n').replace(/\n+$/u, '');
}

export type OutputBuilder = Readonly<{
  line: (text: string) => void;
  blank: () => void;
  bullets: (items: readonly (string | null | undefined)[]) => void;
  numbered: (items: readonly (string | null | undefined)[], options?: Readonly<{ start?: number }>) => void;
  definitionList: (rows: readonly DefinitionListRow[], options?: DefinitionListOptions) => void;
  section: (title: string, build?: (section: OutputBuilder) => void) => void;
  render: () => string;
  items: () => readonly OutputItem[];
}>;

export function createOutputBuilder({ presentation: explicitPresentation }: RenderOutputOptions = {}): OutputBuilder {
  const presentation = normalizePresentation(explicitPresentation);
  const items: OutputItem[] = [];

  const builder: OutputBuilder = {
    line: (text) => {
      items.push({ kind: 'line', text: String(text ?? '') });
    },
    blank: () => {
      items.push({ kind: 'blank' });
    },
    bullets: (bulletItems) => {
      items.push({ kind: 'bullets', items: bulletItems ?? [] });
    },
    numbered: (numberedItems, options) => {
      items.push({
        kind: 'numbered',
        items: numberedItems ?? [],
        ...(options?.start != null ? { start: options.start } : {}),
      });
    },
    definitionList: (rows, options) => {
      items.push({ kind: 'definitionList', rows: rows ?? [], ...(options ? { options } : {}) });
    },
    section: (title, build) => {
      const sectionItems: OutputItem[] = [];
      const sectionBuilder = createOutputBuilder({ presentation });
      build?.(sectionBuilder);
      sectionItems.push(...sectionBuilder.items());
      items.push({ kind: 'section', title: String(title ?? ''), body: sectionItems });
    },
    render: () => renderOutputItems(items, { presentation }),
    items: () => items,
  };

  return builder;
}
