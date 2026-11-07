import { describe, expect, it } from 'vitest';
import { createUsageCoachSuppressionPort, UsageCoachSuppressionStateV1Schema } from './coachActions.js';

describe('Coach suppression Account KV owner', () => {
    it('starts empty and edits and restores findings through current KV state', async () => {
        let value: unknown | null = null;
        let version = -1;
        let writes = 0;
        const owner = () => createUsageCoachSuppressionPort({ transport: {
            read: async () => ({ value, version }),
            compareAndSet: async (next, expected) => {
                if (expected !== version) return { success: false, value, version };
                value = next; writes += 1;
                return { success: true, version: ++version };
            },
        } });
        expect((await owner().read()).suppressions).toEqual([]);
        expect(writes).toBe(0);
        await owner().edit({ evidenceKey: 'new', dismissed: true });
        expect(UsageCoachSuppressionStateV1Schema.parse(value).suppressions).toEqual([
            { kind: 'dismissed', evidenceKey: 'new' },
        ]);
        await owner().edit({ evidenceKey: 'live', untilMs: 123 });
        expect((await owner().read()).suppressions.map(row => row.evidenceKey)).toEqual(['new', 'live']);
        await owner().edit({ evidenceKey: 'live', untilMs: null });
        await owner().edit({ evidenceKey: 'new', dismissed: false });
        expect((await owner().read()).suppressions).toEqual([]);
    });

    it('exposes CAS conflicts', async () => {
        const value = { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'winner' }] };
        const owner = createUsageCoachSuppressionPort({
            transport: { read: async () => ({ value: null, version: -1 }),
                compareAndSet: async () => ({ success: false, value, version: 1 }) },
        });
        await expect(owner.edit({ evidenceKey: 'new', dismissed: true })).rejects.toMatchObject({ code: 'version_mismatch' });
    });

    it('preserves stored snoozes when editing another finding', async () => {
        const stored = { kind: 'snoozed' as const, evidenceKey: 'old', untilMs: 1 };
        let value: unknown = { v: 1, suppressions: [stored] };
        const owner = createUsageCoachSuppressionPort({ transport: {
            read: async () => ({ value, version: -1 }),
            compareAndSet: async next => { value = next; return { success: true, version: 0 }; },
        } });
        await owner.edit({ evidenceKey: 'new', dismissed: true });
        expect((await owner.read()).suppressions).toContainEqual(stored);
    });
});
