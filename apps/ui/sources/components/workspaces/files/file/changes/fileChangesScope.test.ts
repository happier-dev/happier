import { describe, expect, it } from 'vitest';
import { resolveFileChangesScope } from './fileChangesScope';

describe('File Changes selection policy', () => {
    it('keeps a read-only branch capture exact despite a retained live tab preference', () => {
        const initialChanges = { kind: 'branch' as const, head: 'feature', base: 'main', comparisonId: 'captured-branch' };
        expect(resolveFileChangesScope({ initialChanges, readOnly: true, storedScope: { kind: 'workingTree' } }))
            .toMatchObject({ selector: initialChanges, capture: true, readOnly: true });
    });
    it('uses session/project defaults and preserves an explicitly opened turn', () => {
        expect(resolveFileChangesScope({}).current).toEqual({ kind: 'workingTree' });
        expect(resolveFileChangesScope({ sessionId: 's' }).current).toEqual({ kind: 'session' });
        const initialChanges = { kind: 'turnCheckpoint' as const, turnId: 'turn-4', comparisonId: 'exact-evidence' };
        expect(resolveFileChangesScope({ sessionId: 's', initialChanges }))
            .toMatchObject({ current: { kind: 'turn', turnId: 'turn-4' }, selector: initialChanges, capture: true });
    });
    it('makes persisted per-tab scope authoritative and keeps Uncommitted outside captures', () => {
        expect(resolveFileChangesScope({ sessionId: 's', initialChanges: { kind: 'turnCheckpoint', turnId: 'turn-4' },
            storedScope: { kind: 'workingTree', futurePresentationField: true } }))
            .toMatchObject({ current: { kind: 'workingTree' }, selector: { kind: 'workingTree' }, capture: false });
        expect(resolveFileChangesScope({ storedScope: { kind: 'turn', turnId: 'turn-8' } }))
            .toMatchObject({ current: { kind: 'turn', turnId: 'turn-8' }, capture: true });
    });
    it('keeps an explicitly opened turn available when another scope is selected', () => {
        const initialChanges = { kind: 'turnCheckpoint' as const, turnId: 'turn-original' };
        expect(resolveFileChangesScope({ sessionId: 's', initialChanges, storedScope: { kind: 'session' }, latestTurnId: 'turn-latest' }))
            .toMatchObject({ current: { kind: 'session' }, turnId: 'turn-original' });
        expect(resolveFileChangesScope({ sessionId: 's', latestTurnId: 'turn-latest' }).turnId).toBe('turn-latest');
    });
});
