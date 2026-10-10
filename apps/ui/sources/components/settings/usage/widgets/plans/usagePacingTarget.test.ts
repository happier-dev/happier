import { describe, expect, it } from 'vitest';
import { readUsagePersonalPaceTarget, setUsagePersonalPaceTarget, selectUsageWindowsAboveTarget } from './usagePacingTarget';

const pool = { id: 'pool-a', scope: { kind: 'pool' as const, group: { serviceRef: { pluginId: 'p', localId: 'claude' }, groupId: 'g' } as never }, utilizationFraction: 0.5 };

describe('personal pace target (lab p2budget)', () => {
    it('reads only the account-wide personal target, never a pool or one-meter target', () => {
        expect(readUsagePersonalPaceTarget([pool])).toBeNull();
        expect(readUsagePersonalPaceTarget([{ id: 'x', scope: { kind: 'personal' }, meterId: 'weekly', utilizationFraction: 0.4 }])).toBeNull();
        expect(readUsagePersonalPaceTarget([pool, { id: 'personal', scope: { kind: 'personal' }, utilizationFraction: 0.75 }])).toBe(0.75);
    });
    it('sets or clears the personal target and keeps every other target as it was', () => {
        const set = setUsagePersonalPaceTarget([pool], 0.9);
        expect(set).toEqual([pool, { id: 'personal', scope: { kind: 'personal' }, utilizationFraction: 0.9 }]);
        expect(setUsagePersonalPaceTarget(set, 0.5)).toEqual([pool, { id: 'personal', scope: { kind: 'personal' }, utilizationFraction: 0.5 }]);
        expect(setUsagePersonalPaceTarget(set, null)).toEqual([pool]);
    });
    it('names the windows this pace takes past the target, and only windows with a known pace', () => {
        const window = (key: string, used: number | null) => ({ key, label: key, pace: used === null ? null : { projectedUsedFraction: used } });
        const above = selectUsageWindowsAboveTarget([
            { title: 'Claude', windows: [window('5-hour', 0.95), window('weekly', 0.6), window('opus', null)] },
        ], 0.75);
        expect(above).toEqual(['Claude · 5-hour']);
    });
});
