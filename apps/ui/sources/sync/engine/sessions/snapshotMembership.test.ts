import { describe, expect, it } from 'vitest';
import { reconcileSessionSnapshotMembership } from './snapshotMembership';

describe('ordinary Session snapshot membership', () => {
    it('adds listed Sessions while retaining omitted exact-read members', () => {
        const result = reconcileSessionSnapshotMembership({
            previous: new Set(['retained']), sessionIds: ['new'],
        });
        expect([...result]).toEqual(['retained', 'new']);
    });
    it('does not infer withdrawal from an empty ordinary snapshot', () => {
        const result = reconcileSessionSnapshotMembership({
            previous: new Set(['retained']), sessionIds: [],
        });
        expect([...result]).toEqual(['retained']);
    });
});
