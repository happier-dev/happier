import { describe, expect, it } from 'vitest';
import { createUsageCoachSuppressionPort, readLegacyUsageCoachSuppressions, UsageCoachSuppressionStateV1Schema } from './coachActions.js';

describe('Coach suppression Account KV owner', () => {
    it('retains dismissals from historical preference containers with obsolete fields', () => {
        const suppressions = [{ kind: 'dismissed', evidenceKey: 'old' }];
        expect(readLegacyUsageCoachSuppressions({ v: 1, digestCadence: 'weekly', suppressions })).toEqual(suppressions);
        expect(() => readLegacyUsageCoachSuppressions({ suppressions: [{ kind: 'unknown', evidenceKey: 'old' }] })).toThrow();
    });

    it('converts legacy dismissals and snoozes on edit and never resurrects a restored entry', async () => {
        const legacy = [{ kind: 'dismissed' as const, evidenceKey: 'old' },
            { kind: 'snoozed' as const, evidenceKey: 'live', untilMs: Date.now() + 60_000 }];
        let value: unknown | null = null;
        let version = -1;
        let writes = 0;
        const owner = () => createUsageCoachSuppressionPort({ readLegacy: async () => legacy, transport: {
            read: async () => ({ value, version }),
            compareAndSet: async (next, expected) => {
                if (expected !== version) return { success: false, value, version };
                value = next; writes += 1;
                return { success: true, version: ++version };
            },
        } });
        expect((await owner().read()).suppressions).toEqual(legacy);
        expect(writes).toBe(0);
        await owner().edit({ evidenceKey: 'new', dismissed: true });
        expect(UsageCoachSuppressionStateV1Schema.parse(value).suppressions).toEqual([
            ...legacy, { kind: 'dismissed', evidenceKey: 'new' },
        ]);
        await owner().edit({ evidenceKey: 'old', dismissed: false });
        expect((await owner().read()).suppressions.map(row => row.evidenceKey)).toEqual(['live', 'new']);
        await owner().edit({ evidenceKey: 'live', untilMs: null });
        await owner().edit({ evidenceKey: 'new', dismissed: false });
        expect((await owner().read()).suppressions).toEqual([]);
        expect(legacy).toHaveLength(2);
    });

    it('preserves legacy state before a preference replacement and exposes CAS conflicts', async () => {
        const owner = createUsageCoachSuppressionPort({
            readLegacy: async () => [{ kind: 'dismissed', evidenceKey: 'old' }],
            transport: { read: async () => ({ value: null, version: -1 }),
                compareAndSet: async () => ({ success: false, value: { v: 1, suppressions: [] }, version: 1 }) },
        });
        await expect(owner.convertLegacy()).rejects.toMatchObject({ code: 'version_mismatch' });
        await expect(owner.edit({ evidenceKey: 'new', dismissed: true })).rejects.toMatchObject({ code: 'version_mismatch' });
    });

    it('preserves historical snoozes when editing another finding', async () => {
        let value: unknown = null;
        const historical = { kind: 'snoozed' as const, evidenceKey: 'old', untilMs: 1 };
        const owner = createUsageCoachSuppressionPort({ readLegacy: async () => [historical], transport: {
            read: async () => ({ value, version: -1 }),
            compareAndSet: async next => { value = next; return { success: true, version: 0 }; },
        } });
        await owner.edit({ evidenceKey: 'new', dismissed: true });
        expect((await owner.read()).suppressions).toContainEqual(historical);
    });
});
