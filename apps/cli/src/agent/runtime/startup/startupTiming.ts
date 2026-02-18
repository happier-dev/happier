import type { StartupTiming } from './startupSpec';

type StartupSpan = { startMs: number; endMs: number } | { startMs: number; endMs: null };

export function createStartupTiming(opts: { enabled: boolean; nowMs: () => number }): StartupTiming {
  if (!opts.enabled) {
    return {
      enabled: false,
      mark: () => {},
      getMark: () => null,
      startSpan: () => () => {},
      getSpan: () => null,
      formatSummaryLine: (formatOpts) => formatSummaryLineText({ prefix: formatOpts?.prefix, parts: [] }),
    };
  }

  const baseMs = opts.nowMs();
  const marks = new Map<string, number>();
  const spans = new Map<string, StartupSpan>();

  const mark = (id: string): void => {
    marks.set(id, Math.max(0, opts.nowMs() - baseMs));
  };

  const startSpan = (id: string): (() => void) => {
    const startMs = Math.max(0, opts.nowMs() - baseMs);
    spans.set(id, { startMs, endMs: null });
    return () => {
      const existing = spans.get(id);
      if (!existing) return;
      if (existing.endMs !== null) return;
      spans.set(id, { startMs: existing.startMs, endMs: Math.max(0, opts.nowMs() - baseMs) });
    };
  };

  const getSpan = (id: string): { startMs: number; endMs: number } | null => {
    const s = spans.get(id);
    if (!s) return null;
    if (s.endMs === null) return null;
    return { startMs: s.startMs, endMs: s.endMs };
  };

  const formatSummaryLine = (formatOpts?: {
    prefix?: string;
    includeIds?: ReadonlyArray<string>;
  }): string => {
    const includeIds = formatOpts?.includeIds ?? null;
    const parts: string[] = [];

    const markParts: Array<{ id: string; ms: number }> = [];
    for (const [id, ms] of marks.entries()) {
      if (includeIds && !includeIds.includes(id)) continue;
      markParts.push({ id, ms });
    }
    markParts.sort((a, b) => a.id.localeCompare(b.id));
    for (const part of markParts) {
      parts.push(`${part.id}=${part.ms}ms`);
    }

    const spanParts: Array<{ id: string; startMs: number; endMs: number }> = [];
    for (const [id, span] of spans.entries()) {
      if (includeIds && !includeIds.includes(id)) continue;
      if (span.endMs === null) continue;
      spanParts.push({ id, startMs: span.startMs, endMs: span.endMs });
    }
    spanParts.sort((a, b) => a.id.localeCompare(b.id));
    for (const part of spanParts) {
      const durationMs = Math.max(0, part.endMs - part.startMs);
      parts.push(`${part.id}=${durationMs}ms`);
    }

    return formatSummaryLineText({ prefix: formatOpts?.prefix, parts });
  };

  return {
    enabled: true,
    mark,
    getMark: (id: string) => marks.get(id) ?? null,
    startSpan,
    getSpan,
    formatSummaryLine,
  };
}

function formatSummaryLineText(opts: { prefix?: string; parts: string[] }): string {
  const prefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : '[startup-timing]';
  if (opts.parts.length === 0) return prefix;
  return `${prefix} ${opts.parts.join(' ')}`;
}
