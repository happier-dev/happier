import { describe, expect, it } from 'vitest';
import type { DatabaseCaptureSummaryV1 } from '@happier-dev/database-protocol';
import { projectWaterfall } from './traceWaterfall.js';

const base = { worktree: 'w', source: 'otlp' as const, traceId: 't1' };
function span(
  id: string,
  at: number,
  durationMs: number,
  extra: Partial<DatabaseCaptureSummaryV1> = {},
): DatabaseCaptureSummaryV1 {
  return { ...base, id, kind: 'span', at, durationMs, spanId: id, ...extra };
}
function query(
  id: string,
  at: number,
  durationMs: number,
  parentSpanId: string,
): DatabaseCaptureSummaryV1 {
  return {
    ...base,
    id,
    kind: 'query',
    source: 'wire',
    at,
    durationMs,
    parentSpanId,
    shape: 'SELECT * FROM invoice_lines WHERE invoice_id = $1',
  };
}

describe('the captured request waterfall', () => {
  it('collapses a repeated query into one row under the step that ran it, in tree order', () => {
    const root = span('req', 0, 214, {
      spanKind: 2,
      endpointMethod: 'GET',
      endpointRoute: '/invoices/:id',
      httpStatusCode: 200,
    });
    const page = span('page', 11, 196, {
      parentSpanId: 'req',
      shape: 'InvoicePage',
    });
    const lines = Array.from({ length: 24 }, (_, index) =>
      query(`q${index}`, 19 + index * 3, 2, 'page'),
    );
    const middleware = span('mw', 2, 8, {
      parentSpanId: 'req',
      shape: 'middleware · session',
    });
    const waterfall = projectWaterfall(
      [root, page, middleware, ...lines],
      [
        {
          traceId: 't1',
          requestSpanId: 'req',
          shape: lines[0]!.shape!,
          kind: 'suspected_n_plus_one',
          repetitionCount: 24,
          totalDatabaseTimeMs: 48,
          observationIds: lines.map((line) => line.id),
          callsites: [],
          explanation: 'repeated',
        },
      ],
    );
    expect(waterfall.domain).toEqual({ start: 0, end: 214 });
    expect(waterfall.rows.map((row) => [row.label, row.depth])).toEqual([
      ['GET /invoices/:id', 0],
      ['middleware · session', 1],
      ['InvoicePage', 1],
      [lines[0]!.shape, 2],
    ]);
    expect(waterfall.rows[3]).toMatchObject({
      repeated: { count: 24, kind: 'suspected_n_plus_one' },
      start: 19,
      end: 19 + 23 * 3 + 2,
    });
    // A span whose parent the trace never delivered sits at the top level and is counted once.
    const orphaned = projectWaterfall([root, span('lost', 5, 3, { parentSpanId: 'missing' })], []);
    expect(orphaned.orphans).toBe(1);
    expect(orphaned.rows.map((row) => [row.id, row.depth])).toEqual([['req', 0], ['lost', 1]]);
  });
});
