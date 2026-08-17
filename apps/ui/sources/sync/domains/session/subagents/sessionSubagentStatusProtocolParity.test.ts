import { SESSION_SUBAGENT_STATUS_SOURCES_V1, fromSubagentStatus } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionSubagentStatus } from './types';

/**
 * The parity lock for a boundary mirror.
 *
 * `SessionSubagentStatus` is owned here — it is derived from transcript observation, never sent on
 * the wire — but the protocol adapter must be typed against it, and `packages/protocol` cannot
 * import from `apps/ui`. So the protocol keeps `SESSION_SUBAGENT_STATUS_SOURCES_V1` as a documented
 * mirror, and a mirror with nothing comparing the two sides is a drift waiting to happen: adding a
 * member here would silently leave the adapter unable to map it, and a status with no mapping is how
 * a raw provider value reaches a screen untranslated.
 *
 * This test is that comparison, and it lives on this side because only this side can see both.
 *
 * The exhaustive `switch` in `fromSubagentStatus` covers the other direction (a protocol member with
 * no arm fails to compile), so together they pin set equality in both directions.
 */
describe('SessionSubagentStatus <-> protocol mirror', () => {
    it('mirrors every UI status in the protocol source vocabulary', () => {
        // Listed literally, not derived from the type: a `satisfies`-style derivation would drift
        // with the type it is supposed to police.
        const uiStatuses = [
            'running',
            'succeeded',
            'failed',
            'timedOut',
            'cancelled',
            'terminated',
            'unknown',
        ] as const satisfies readonly SessionSubagentStatus[];

        // Compile-time half: a member added to the UI union and not to this table fails to build.
        const exhaustive: Record<SessionSubagentStatus, true> = {
            running: true,
            succeeded: true,
            failed: true,
            timedOut: true,
            cancelled: true,
            terminated: true,
            unknown: true,
        };
        expect(Object.keys(exhaustive).sort()).toEqual([...uiStatuses].sort());

        expect([...SESSION_SUBAGENT_STATUS_SOURCES_V1].sort()).toEqual([...uiStatuses].sort());
    });

    it('maps every UI status through the adapter without falling back to unknown', () => {
        for (const status of SESSION_SUBAGENT_STATUS_SOURCES_V1) {
            if (status === 'unknown') continue;
            expect(fromSubagentStatus(status)).not.toBe('unknown');
        }
        expect(fromSubagentStatus('running')).toBe('running');
        // Kept distinct from `failed`: the recovery is to raise the budget, not to read an error.
        expect(fromSubagentStatus('timedOut')).toBe('timedOut');
        // A stop is not an error: both stop shapes collapse to `cancelled`, never to `failed`.
        expect(fromSubagentStatus('terminated')).toBe('cancelled');
        expect(fromSubagentStatus('cancelled')).toBe('cancelled');
    });
});
