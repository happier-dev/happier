import { describe, expect, it } from 'vitest';
import type { NormalizedSpan } from '../otlp/types.js';
import { analyzeRequestQueries, type DatabaseExecutionEvidence } from './requests.js';

const root: NormalizedSpan = {
    type: 'span', traceId: 'trace', spanId: 'request', name: 'GET /users', kind: 2,
    startTimeUnixNano: '0', endTimeUnixNano: '100000000', durationMs: 100, status: 'ok',
};
function query(id: string, parameterIdentity?: string): DatabaseExecutionEvidence {
    return { observationId: id, source: 'otlp', traceId: root.traceId, spanId: id, parentSpanId: root.spanId,
        shape: 'SELECT name FROM users WHERE id = $1', statementKind: 'select', durationMs: 3,
        ...(parameterIdentity ? { parameterIdentity } : {}) };
}

describe('request-scoped repeated database evidence', () => {
    it('reports suspected N+1 for distinct parameter evidence and duplicate work separately without a severity threshold', () => {
        const result = analyzeRequestQueries([root], [query('one', 'param-a'), query('two', 'param-b')]);
        expect(result).toEqual([expect.objectContaining({
            traceId: 'trace', requestSpanId: 'request', kind: 'suspected_n_plus_one',
            repetitionCount: 2, totalDatabaseTimeMs: 6, observationIds: ['one', 'two'],
        })]);
        expect(analyzeRequestQueries([root], [query('one', 'param-a'), query('two', 'param-a')])[0]?.kind).toBe('duplicate_work');
        expect(analyzeRequestQueries([root], [query('one'), query('two')])[0]?.kind).toBe('repeated_query');
    });

    it('combines only explicit execution identities, retains concurrent equal SQL, and excludes control/retry evidence', () => {
        const first = { ...query('one', 'param-a'), executionIdentity: 'execution-one' };
        const wire = { ...first, observationId: 'wire-one', source: 'wire' as const };
        const second = query('two', 'param-b');
        const retry = { ...query('retry', 'param-c'), retryOf: 'one' };
        const control = { ...query('control'), statementKind: 'control' as const };
        const unrelated = { ...query('unrelated'), traceId: 'different-trace' };
        const result = analyzeRequestQueries([root], [first, wire, second, retry, control, unrelated]);
        expect(result[0]).toMatchObject({ repetitionCount: 2, totalDatabaseTimeMs: 6, observationIds: ['one', 'wire-one', 'two'] });
        expect(analyzeRequestQueries([], [first, second])).toEqual([]);
    });

    it('retains parameter, callsite and retry evidence when a linked wire observation lacks application details', () => {
        const first = { ...query('one', 'param-a'), executionIdentity: 'first', callsite: 'loadUser' };
        const wire = { ...query('wire-one'), source: 'wire' as const, spanId: first.spanId, executionIdentity: 'first', durationMs: 2 };
        const result = analyzeRequestQueries([root], [first, wire, query('two', 'param-b')]);
        expect(result[0]).toMatchObject({ kind: 'suspected_n_plus_one', totalDatabaseTimeMs: 5, callsites: ['loadUser'] });
        const retry = { ...query('retry', 'param-c'), executionIdentity: 'retry', retryOf: 'one' };
        const retryWire = { ...query('retry-wire'), source: 'wire' as const, spanId: retry.spanId, executionIdentity: 'retry' };
        expect(analyzeRequestQueries([root], [query('single', 'param-a'), retry, retryWire])).toEqual([]);
    });

    it('uses ancestry to keep sibling server requests in one trace separate', () => {
        const otherRoot = { ...root, spanId: 'other-request', parentSpanId: root.spanId };
        const nested = { ...root, spanId: 'internal', parentSpanId: otherRoot.spanId, kind: 1 };
        const result = analyzeRequestQueries([root, otherRoot, nested], [
            query('one', 'param-a'), query('two', 'param-b'),
            { ...query('three', 'param-c'), parentSpanId: nested.spanId },
            { ...query('four', 'param-d'), parentSpanId: nested.spanId },
        ]);
        expect(result.map(value => [value.requestSpanId, value.repetitionCount])).toEqual([['request', 2], ['other-request', 2]]);
    });
});
