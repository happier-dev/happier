import { describe, expect, it } from 'vitest';

import { applyCliWarningDismissal, isCliWarningDismissed } from './cliWarnings';

describe('agents/cliWarnings', () => {
    it('applies dismissals according to scope using table-driven cases', () => {
        const cases: Array<{
            scope: 'global' | 'machine';
            machineId: string | null;
            expectDismissedForM1: boolean;
            expectDismissedForM2: boolean;
        }> = [
            { scope: 'global', machineId: 'm1', expectDismissedForM1: true, expectDismissedForM2: true },
            { scope: 'machine', machineId: 'm1', expectDismissedForM1: true, expectDismissedForM2: false },
        ];

        for (const testCase of cases) {
            const next = applyCliWarningDismissal({
                dismissed: { perMachine: {}, global: {} },
                machineId: testCase.machineId,
                warningKey: 'codex',
                scope: testCase.scope,
            });
            expect(isCliWarningDismissed({ dismissed: next, machineId: 'm1', warningKey: 'codex' })).toBe(testCase.expectDismissedForM1);
            expect(isCliWarningDismissed({ dismissed: next, machineId: 'm2', warningKey: 'codex' })).toBe(testCase.expectDismissedForM2);
        }
    });

    it('does not create machine-scoped dismissal without a machine id', () => {
        const current = { perMachine: {}, global: {} };
        const next = applyCliWarningDismissal({
            dismissed: current,
            machineId: null,
            warningKey: 'codex',
            scope: 'machine',
        });

        expect(next).toBe(current);
        expect(isCliWarningDismissed({ dismissed: next, machineId: 'm1', warningKey: 'codex' })).toBe(false);
    });

    it('handles missing dismissal state as empty', () => {
        expect(isCliWarningDismissed({ dismissed: null, machineId: 'm1', warningKey: 'codex' })).toBe(false);
        expect(isCliWarningDismissed({ dismissed: undefined, machineId: 'm1', warningKey: 'codex' })).toBe(false);
    });
});
