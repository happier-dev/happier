import { describe, expect, it } from 'vitest';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import { readTriageListEmptyState, resolveTriageListEmptyState } from './emptyState.js';
import type { TriageListShellStateV1 } from './windowState.js';

function windowState(input: Readonly<{
    coverage: 'complete' | 'partial';
    error?: string | null;
    refreshing?: boolean;
    rows?: TriageListWindowV1['rows'];
}>): TriageListShellStateV1 {
    return {
        kind: 'window',
        window: {
            v: 1,
            rows: input.rows ?? [],
            lanes: [],
            coverage: input.coverage,
            assembledAtMs: 0,
        },
        refreshing: input.refreshing ?? false,
        stale: false,
        error: input.error ?? null,
    };
}

describe('the empty PRs & Issues list', () => {
    it('claims every source answered only when a complete window really is empty', () => {
        expect(resolveTriageListEmptyState({ coverage: 'complete', error: null, refreshing: false }))
            .toMatchObject({ kind: 'healthy', description: expect.stringContaining('Every configured source answered') });
    });

    it('never claims every source answered while a source is reporting a failure', () => {
        const resolved = resolveTriageListEmptyState({
            coverage: 'complete',
            error: 'example-forge could not be reached.',
            refreshing: false,
        });

        expect(resolved.kind).toBe('sourceFailure');
        // The reader is told which source failed, in the store's words, rather
        // than a generic sentence this resolver would have to invent.
        expect(resolved.description).toBe('example-forge could not be reached.');
        expect(`${resolved.title} ${resolved.description}`).not.toMatch(/answered/u);
    });

    it('never claims every source answered while the walk is still bounded', () => {
        const resolved = resolveTriageListEmptyState({
            coverage: 'partial',
            error: null,
            refreshing: false,
        });

        expect(resolved.kind).toBe('boundedWindow');
        expect(`${resolved.title} ${resolved.description}`).not.toMatch(/answered/u);
    });

    it('says a pass is still running rather than that the walk stopped short', () => {
        expect(resolveTriageListEmptyState({ coverage: 'partial', error: null, refreshing: true }))
            .toMatchObject({ kind: 'reading' });
    });

    it('ranks a failure above incompleteness, because a failure falsifies it too', () => {
        expect(resolveTriageListEmptyState({
            coverage: 'partial',
            error: 'example-forge could not be reached.',
            refreshing: true,
        }).kind).toBe('sourceFailure');
    });

    it('is reached only by an assembled window that has no rows to show', () => {
        // The unavailable and unconfigured states are their own screens; a list
        // empty slot must never speak for them.
        expect(readTriageListEmptyState({ kind: 'initial' }, 0)).toBeNull();
        expect(readTriageListEmptyState({ kind: 'configureSources' }, 0)).toBeNull();
        expect(readTriageListEmptyState({ kind: 'unavailable', message: 'no' }, 0)).toBeNull();
        expect(readTriageListEmptyState(windowState({ coverage: 'complete' }), 3)).toBeNull();
        expect(readTriageListEmptyState(windowState({ coverage: 'partial' }), 0))
            .toMatchObject({ kind: 'boundedWindow' });
    });
});
