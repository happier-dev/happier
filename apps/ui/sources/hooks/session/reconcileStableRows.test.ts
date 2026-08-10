import { describe, expect, it } from 'vitest';

import { areRowValuesStructurallyEqual, reconcileStableRows } from './reconcileStableRows';

type Row = Readonly<{
    id: string;
    status: string;
    display?: Readonly<{ title: string; subtitle?: string }>;
    tags?: readonly string[];
}>;

const readRowKey = (row: Row): string => row.id;

describe('areRowValuesStructurallyEqual', () => {
    it('treats an explicitly undefined property as an absent one', () => {
        // Derivations here mix conditional spreads with `?? undefined`. A key-count-only comparison
        // would call these different forever and permanently disable the memo.
        expect(areRowValuesStructurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(areRowValuesStructurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
        expect(areRowValuesStructurallyEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
    });

    it('is independent of key order', () => {
        expect(areRowValuesStructurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it('sees a difference nested below the first level', () => {
        expect(areRowValuesStructurallyEqual(
            { display: { title: 'agent', meta: { runId: 'run_1' } } },
            { display: { title: 'agent', meta: { runId: 'run_2' } } },
        )).toBe(false);
    });

    it('does not treat an array as equal to an object with the same indices', () => {
        expect(areRowValuesStructurallyEqual(['a'], { 0: 'a' })).toBe(false);
        expect(areRowValuesStructurallyEqual(['a', 'b'], ['a'])).toBe(false);
    });
});

describe('reconcileStableRows', () => {
    it('returns the previous array when a rebuild produced equivalent rows', () => {
        const previous: readonly Row[] = [
            { id: 'run_1', status: 'running', display: { title: 'one' } },
            { id: 'run_2', status: 'running', display: { title: 'two' } },
        ];
        const rebuilt: readonly Row[] = [
            { id: 'run_1', status: 'running', display: { title: 'one' } },
            { id: 'run_2', status: 'running', display: { title: 'two' } },
        ];

        expect(reconcileStableRows(previous, rebuilt, readRowKey)).toBe(previous);
    });

    it('replaces only the row that changed', () => {
        const previous: readonly Row[] = [
            { id: 'run_1', status: 'running' },
            { id: 'run_2', status: 'running' },
            { id: 'run_3', status: 'running' },
        ];
        const rebuilt: readonly Row[] = [
            { id: 'run_1', status: 'running' },
            { id: 'run_2', status: 'succeeded' },
            { id: 'run_3', status: 'running' },
        ];

        const reconciled = reconcileStableRows(previous, rebuilt, readRowKey);

        expect(reconciled).not.toBe(previous);
        expect(reconciled[0]).toBe(previous[0]);
        expect(reconciled[1]).toBe(rebuilt[1]);
        expect(reconciled[2]).toBe(previous[2]);
    });

    it('matches by key, so a reordered but unchanged row keeps its identity', () => {
        const previous: readonly Row[] = [
            { id: 'run_1', status: 'running' },
            { id: 'run_2', status: 'running' },
        ];
        const rebuilt: readonly Row[] = [
            { id: 'run_2', status: 'running' },
            { id: 'run_1', status: 'running' },
        ];

        const reconciled = reconcileStableRows(previous, rebuilt, readRowKey);

        expect(reconciled).not.toBe(previous);
        expect(reconciled[0]).toBe(previous[1]);
        expect(reconciled[1]).toBe(previous[0]);
    });

    it('keeps surviving rows when one is removed', () => {
        const previous: readonly Row[] = [
            { id: 'run_1', status: 'running' },
            { id: 'run_2', status: 'running' },
        ];
        const rebuilt: readonly Row[] = [{ id: 'run_1', status: 'running' }];

        const reconciled = reconcileStableRows(previous, rebuilt, readRowKey);

        expect(reconciled).toHaveLength(1);
        expect(reconciled[0]).toBe(previous[0]);
    });

    it('keeps identity across an added row', () => {
        const previous: readonly Row[] = [{ id: 'run_1', status: 'running', tags: ['a'] }];
        const rebuilt: readonly Row[] = [
            { id: 'run_1', status: 'running', tags: ['a'] },
            { id: 'run_2', status: 'queued' },
        ];

        const reconciled = reconcileStableRows(previous, rebuilt, readRowKey);

        expect(reconciled).toHaveLength(2);
        expect(reconciled[0]).toBe(previous[0]);
        expect(reconciled[1]).toBe(rebuilt[1]);
    });
});
