/**
 * One captured request as waterfall rows: the pure projection of the existing capture trace read
 * (`capture/trace/get`) the exception detail draws on the shared IntervalTimeline.
 *
 * Telemetry owns the capture data, so it owns this projection. Repeated identical queries collapse
 * into one row with the producer's count; spans whose parent the trace never delivered are drawn at
 * the top level and counted once. Nothing is invented for a missing span.
 */

import { requestLabelOf } from '@happier-dev/plugin-ui/components';

import type {
  DatabaseCaptureRepeatedQueryV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';

export type WaterfallRowV1 = Readonly<{
  id: string;
  label: string;
  depth: number;
  start: number;
  end: number;
  kind: 'request' | 'span' | 'query';
  /** The span's own id, so a consumer can mark the span an exception was recorded in. */
  spanId: string | null;
  /** OpenTelemetry span kind (3 = an external call); null for a query or when the producer did not say. */
  spanKind: number | null;
  repeated?: Readonly<{
    count: number;
    kind: DatabaseCaptureRepeatedQueryV1['kind'];
  }>;
  failed: boolean;
  /** The request's route, when this row is a request to one: drawn as the shared method + route cell. */
  route?: Readonly<{ method: string; route: string }>;
}>;

export type WaterfallV1 = Readonly<{
  root: DatabaseCaptureSummaryV1 | null;
  domain: Readonly<{ start: number; end: number }> | null;
  rows: readonly WaterfallRowV1[];
  orphans: number;
}>;

const timed = (summary: DatabaseCaptureSummaryV1) =>
  (summary.kind === 'span' || summary.kind === 'query') &&
  typeof summary.durationMs === 'number';

export function projectWaterfall(
  summaries: readonly DatabaseCaptureSummaryV1[],
  repeatedQueries: readonly DatabaseCaptureRepeatedQueryV1[],
): WaterfallV1 {
  const items = summaries.filter(timed);
  const bySpan = new Map(
    items.flatMap((item) =>
      item.spanId ? [[item.spanId, item] as const] : [],
    ),
  );
  const root =
    items.find(
      (item) =>
        item.spanKind === 2 &&
        (!item.parentSpanId || !bySpan.has(item.parentSpanId)),
    ) ??
    items.find((item) => !item.parentSpanId) ??
    null;
  const collapsed = new Map<string, DatabaseCaptureRepeatedQueryV1>();
  const hidden = new Set<string>();
  for (const group of repeatedQueries) {
    const [first, ...rest] = group.observationIds;
    if (!first) continue;
    collapsed.set(first, group);
    for (const id of rest) hidden.add(id);
  }
  const children = new Map<string, DatabaseCaptureSummaryV1[]>();
  const top: DatabaseCaptureSummaryV1[] = [];
  let orphans = 0;
  for (const item of items) {
    if (hidden.has(item.id) || item === root) continue;
    const parent =
      item.kind === 'query'
        ? (item.parentSpanId ?? item.spanId)
        : item.parentSpanId;
    if (parent && (bySpan.has(parent) || parent === root?.spanId)) {
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
    } else {
      if (parent) orphans += 1;
      top.push(item);
    }
  }
  const rows: WaterfallRowV1[] = [];
  const visit = (item: DatabaseCaptureSummaryV1, depth: number) => {
    const group = collapsed.get(item.id);
    const members = group
      ? items.filter((candidate) => group.observationIds.includes(candidate.id))
      : [item];
    rows.push({
      id: item.id,
      label: requestLabelOf(item),
      depth,
      start: Math.min(...members.map((member) => member.at)),
      end: Math.max(
        ...members.map((member) => member.at + (member.durationMs ?? 0)),
      ),
      kind:
        item === root ? 'request' : item.kind === 'query' ? 'query' : 'span',
      spanId: item.spanId ?? null,
      spanKind: item.spanKind ?? null,
      ...(group
        ? { repeated: { count: group.repetitionCount, kind: group.kind } }
        : {}),
      failed: (item.httpStatusCode ?? 0) >= 500 || item.outcome === 'error',
      ...(item.endpointMethod && item.endpointRoute
        ? { route: { method: item.endpointMethod, route: item.endpointRoute } }
        : {}),
    });
    const next =
      item.spanId && item.kind === 'span'
        ? (children.get(item.spanId) ?? [])
        : [];
    for (const child of [...next].sort((a, b) => a.at - b.at))
      visit(child, depth + 1);
  };
  if (root) visit(root, 0);
  for (const item of top.sort((a, b) => a.at - b.at)) visit(item, root ? 1 : 0);
  const domain =
    root && root.durationMs
      ? { start: root.at, end: root.at + root.durationMs }
      : rows.length > 0
        ? {
            start: Math.min(...rows.map((row) => row.start)),
            end: Math.max(...rows.map((row) => row.end)),
          }
        : null;
  return {
    root,
    domain: domain && domain.end > domain.start ? domain : null,
    rows,
    orphans,
  };
}

/**
 * The request's direct steps that took the most of its time (D27 #10), largest first: evidence, never a verdict.
 * Steps can overlap, so their shares need not add up to the whole.
 */
export function slowestSteps(
  waterfall: WaterfallV1,
  count = 3,
): readonly Readonly<{ row: WaterfallRowV1; share: number }>[] {
  const domain = waterfall.domain;
  const total = domain ? domain.end - domain.start : 0;
  if (total <= 0) return [];
  const top = waterfall.root ? 1 : 0;
  return waterfall.rows
    .filter((row) => row.depth === top && row.kind !== 'request')
    .map((row) => ({ row, share: Math.min(1, (row.end - row.start) / total) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, count);
}

/** A step that failed carries the failure mark; the request a failure ended is the frame, never the mark. */
export function failedStep(row: WaterfallRowV1): boolean {
  return row.failed && row.kind !== 'request';
}
