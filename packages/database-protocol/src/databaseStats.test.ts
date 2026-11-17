import { describe, expect, it } from 'vitest';
import { compareDatabaseEvidenceWindowsV1, compareDatabaseStatsCountersV1, compareDatabaseStatsSizeV1,
    type DatabaseMeasuredWindowV1, type DatabaseStatsCounterSampleV1 } from './databaseStats.js';

const sample = (rows: DatabaseStatsCounterSampleV1['rows'], observedAtMs: number): DatabaseStatsCounterSampleV1 => ({
    engineId: 'postgresql', observedAtMs, coverage: { status: 'complete' }, rows,
    intervalBasis: { bindingKey: 'deployment:one', databaseIdentity: '16384', selectionKey: 'statements:totalTime:page-one', statsResetAt: '2026-11-16T00:00:00Z' },
});
describe('database stats comparisons', () => {
    it('compares retained measured windows without inventing a result for incomplete or incompatible evidence', () => {
        const compare = compareDatabaseEvidenceWindowsV1;
        const before: DatabaseMeasuredWindowV1 = { measure: 'p95', unit: 'ms', basis: 'metric_points', value: 100,
            window: { since: 1000, until: 2000 }, completeness: 'complete', reasons: [], producers: [] };
        const after = { ...before, value: 180, window: { since: 2000, until: 3000 } };
        expect(compare(before, after)).toEqual({ status: 'comparable', before: 100, after: 180, change: 80, changePercent: 80 });
        expect(compare({ ...before, value: 0 }, after)).toMatchObject({ status: 'comparable', changePercent: null });
        expect(compare({ ...before, completeness: 'partial', reasons: ['sampled_traffic'] }, after))
            .toEqual({ status: 'inconclusive', reasons: ['sampled_traffic'] });
        expect(compare(before, { ...after, basis: 'sampled_spans' })).toEqual({ status: 'inconclusive', reasons: ['incompatible_measurements'] });
        expect(compare(before, { ...after, value: undefined, reasons: ['no_traffic'] }))
            .toEqual({ status: 'inconclusive', reasons: ['no_traffic'] });
        expect(compare(before, { ...after, window: { since: 1500, until: 2500 } }))
            .toEqual({ status: 'inconclusive', reasons: ['incompatible_windows'] });
        expect(compare(before, { ...after, producers: [{ serviceVersion: 'one' }, { serviceVersion: 'two' }] }))
            .toEqual({ status: 'inconclusive', reasons: ['mixed_versions'] });
        const partialBefore: DatabaseMeasuredWindowV1 = { ...before, completeness: 'partial', reasons: ['boundary_gap'] };
        const partialAfter: DatabaseMeasuredWindowV1 = { ...after, completeness: 'partial', reasons: ['boundary_gap'] };
        expect(compare(partialBefore, partialAfter)).toMatchObject({ status: 'comparable', changePercent: 80 });
        expect(compare(partialBefore, { ...partialAfter, completeness: 'unknown', reasons: ['boundary_gap', 'gap'] }))
            .toEqual({ status: 'inconclusive', reasons: ['boundary_gap', 'gap'] });
    });
    it('compares common keys with lossless deltas and computes mean from total time rather than subtracting means', () => {
        const before = sample([{ key: 'db:user:query:top', calls: '9007199254740993', totalTimeMs: 100, rows: '9007199254740998' },
            { key: 'evicted', calls: '5', totalTimeMs: 20, rows: '5' }], 1000);
        const after = sample([{ key: 'db:user:query:top', calls: '9007199254740995', totalTimeMs: 190, rows: '9007199254741008' },
            { key: 'new', calls: '8', totalTimeMs: 4, rows: '9' }], 2000);
        expect(compareDatabaseStatsCountersV1(before, after)).toEqual({ status: 'available', fromMs: 1000, toMs: 2000,
            rows: [{ key: 'db:user:query:top', calls: '2', totalTimeMs: 90, rows: '10', meanTimeMs: 45 }], missingKeys: ['evicted'] });
    });
    it('makes resets, changed bindings, and partial observations unavailable instead of claiming improvement', () => {
        const before = sample([{ key: 'a', calls: '10', totalTimeMs: 50, rows: '30' }], 1000);
        const after = sample([{ key: 'a', calls: '9', totalTimeMs: 60, rows: '40' }], 2000);
        expect(compareDatabaseStatsCountersV1(before, after)).toEqual({ status: 'unavailable', reason: 'counter_reset' });
        expect(compareDatabaseStatsCountersV1(before, { ...after, intervalBasis: { ...after.intervalBasis, bindingKey: 'deployment:two' } }))
            .toEqual({ status: 'unavailable', reason: 'comparison_unavailable' });
        expect(compareDatabaseStatsCountersV1(before, { ...after, coverage: { status: 'partial', reasons: ['visibility_restricted'] } }))
            .toEqual({ status: 'unavailable', reason: 'partial_observation' });
    });
    it('does not manufacture a mean without calls, or a first interval without a baseline', () => {
        const before = sample([{ key: 'a', calls: '10', totalTimeMs: 50, rows: '30' }], 1000);
        expect(compareDatabaseStatsCountersV1(undefined, before)).toEqual({ status: 'unavailable', reason: 'previous_sample_required' });
        expect(compareDatabaseStatsCountersV1(before, { ...before, observedAtMs: 2000 })).toMatchObject({ status: 'available', rows: [{ meanTimeMs: null }] });
    });
    it('rejects a per-statement reset even when newer cumulative counters have caught up', () => {
        const before = sample([{ key: 'a', calls: '10', totalTimeMs: 50, rows: '30' }], 1000);
        const after = sample([{ key: 'a', calls: '20', totalTimeMs: 100, rows: '60' }], 2000);
        expect(compareDatabaseStatsCountersV1({ ...before, intervalBasis: { ...before.intervalBasis, rowResetMarkers: { a: 'first' } } },
            { ...after, intervalBasis: { ...after.intervalBasis, rowResetMarkers: { a: 'reset-later' } } }))
            .toEqual({ status: 'unavailable', reason: 'comparison_unavailable' });
    });
    it('keeps signed size growth exact, rejects a changed deployment and requires increasing sample time', () => {
        const before = { bytes: '9007199254741008', observedAtMs: 1000, bindingKey: 'deployment:one' };
        expect(compareDatabaseStatsSizeV1(before, { ...before, bytes: '9007199254740993', observedAtMs: 2000 }))
            .toEqual({ status: 'available', bytes: '-15', fromMs: 1000, toMs: 2000 });
        expect(compareDatabaseStatsSizeV1(before, { ...before, bindingKey: 'deployment:two', observedAtMs: 2000 }))
            .toEqual({ status: 'unavailable', reason: 'comparison_unavailable' });
        expect(compareDatabaseStatsSizeV1(before, before)).toEqual({ status: 'unavailable', reason: 'comparison_unavailable' });
    });
});
