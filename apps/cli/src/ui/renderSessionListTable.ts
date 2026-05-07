import type { CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { padLeft, padRight, truncateEnd } from '@/ui/sessionTableLayout';
import { formatSessionUpdatedAtForCli, shortenSessionIdForCli } from '@/ui/sessionListFormatting';

type TableColumn = Readonly<{
  key: string;
  header: string;
  minWidth: number;
  maxWidth?: number;
  align?: 'left' | 'right';
}>;

function toInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function toResumeCell(row: CliSessionRowModel): string {
  if (row.vendorResume.eligible) return 'yes';
  switch (row.vendorResume.reasonCode) {
    case 'agent_unsupported':
      return 'no(unsupported)';
    case 'vendor_resume_id_missing':
      return 'no(missing-id)';
    case 'experimental_disabled':
      return 'no(disabled)';
    case 'backend_disabled_by_account_settings':
      return 'no(off)';
    default:
      return 'no';
  }
}

function buildTitleCell(row: CliSessionRowModel): string {
  const parts = [];
  if (row.tag) parts.push(row.tag);
  if (row.title) parts.push(row.title);
  const title = parts.join(' · ');
  if (!title && row.isSystem) {
    return row.systemPurpose ? `system:${row.systemPurpose}` : 'system';
  }
  if (row.isSystem && row.systemPurpose) {
    return `${title} system:${row.systemPurpose}`.trim();
  }
  return title;
}

export function renderSessionListTable(params: Readonly<{
  rows: ReadonlyArray<CliSessionRowModel>;
  columns?: number;
  nowMs?: number;
}>): string[] {
  const nowMs = toInt(params.nowMs) ?? Date.now();
  const termWidthRaw = toInt(params.columns) ?? process.stdout.columns ?? 120;
  const termWidth = Math.max(1, termWidthRaw);

  const baseColumns: TableColumn[] = [
    { key: 'id', header: 'ID', minWidth: 12 },
    { key: 'agent', header: 'AGENT', minWidth: 7 },
    { key: 'updated', header: 'UPDATED', minWidth: 7 },
    { key: 'active', header: 'ACTIVE', minWidth: 6 },
    { key: 'resume', header: 'RESUME', minWidth: 12 },
    { key: 'title', header: 'TITLE', minWidth: 10 },
    { key: 'path', header: 'PATH', minWidth: 10 },
  ];

  const fixedWidth = baseColumns
    .filter((c) => c.key !== 'title' && c.key !== 'path')
    .reduce((sum, c) => sum + c.minWidth, 0);
  const paddingBetween = 2 * (baseColumns.length - 1);
  const remaining = Math.max(0, termWidth - fixedWidth - paddingBetween);

  const titleWidth = Math.max(1, Math.floor(remaining * 0.45));
  const pathWidth = Math.max(1, remaining - titleWidth);

  const resolved = baseColumns.map((c) => {
    if (c.key === 'title') return { ...c, minWidth: titleWidth };
    if (c.key === 'path') return { ...c, minWidth: pathWidth };
    return c;
  });

  const shrinkColumn = (key: string, maxWidth: number): void => {
    const idx = resolved.findIndex((c) => c.key === key);
    if (idx < 0) return;
    const col = resolved[idx]!;
    const next = Math.max(1, Math.min(maxWidth, col.minWidth));
    resolved[idx] = { ...col, minWidth: next };
  };

  const computeTotalWidth = (): number =>
    resolved.reduce((sum, col) => sum + col.minWidth, 0) + paddingBetween;

  // Ensure we never exceed the requested terminal width (best-effort).
  let overflow = computeTotalWidth() - termWidth;
  if (overflow > 0) {
    const shrinkOrder = ['path', 'title', 'resume', 'active', 'updated', 'agent', 'id'];
    for (const key of shrinkOrder) {
      if (overflow <= 0) break;
      const col = resolved.find((c) => c.key === key);
      if (!col) continue;
      const available = col.minWidth - 1;
      if (available <= 0) continue;
      const shrinkBy = Math.min(available, overflow);
      shrinkColumn(key, col.minWidth - shrinkBy);
      overflow -= shrinkBy;
    }
  }

  const renderRow = (cells: string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < resolved.length; i += 1) {
      const col = resolved[i]!;
      const cell = truncateEnd(cells[i] ?? '', col.minWidth);
      const padded = col.align === 'right' ? padLeft(cell, col.minWidth) : padRight(cell, col.minWidth);
      parts.push(padded);
    }
    return parts.join('  ').trimEnd();
  };

  const lines: string[] = [];
  lines.push(renderRow(resolved.map((c) => c.header)));
  lines.push(renderRow(resolved.map((c) => '-'.repeat(Math.min(c.minWidth, Math.max(3, c.header.length))))));

  for (const row of params.rows) {
    lines.push(
      renderRow([
        shortenSessionIdForCli(row.id),
        row.agentId,
        formatSessionUpdatedAtForCli(row.updatedAt, nowMs),
        row.active ? 'yes' : '',
        toResumeCell(row),
        buildTitleCell(row),
        row.path ?? '',
      ]),
    );
  }

  return lines;
}
