import { describe, expect, it } from 'vitest';

import { DEFAULT_TURN_STALL_WARN_MS, readTurnStallWarnThresholdMs } from './stallWatch';

describe('readTurnStallWarnThresholdMs', () => {
    it('defaults to 15 minutes when the env value is absent or unparsable', () => {
        expect(DEFAULT_TURN_STALL_WARN_MS).toBe(15 * 60_000);
        expect(readTurnStallWarnThresholdMs(undefined)).toBe(DEFAULT_TURN_STALL_WARN_MS);
        expect(readTurnStallWarnThresholdMs('')).toBe(DEFAULT_TURN_STALL_WARN_MS);
        expect(readTurnStallWarnThresholdMs('   ')).toBe(DEFAULT_TURN_STALL_WARN_MS);
        expect(readTurnStallWarnThresholdMs('not-a-number')).toBe(DEFAULT_TURN_STALL_WARN_MS);
        expect(readTurnStallWarnThresholdMs('-1')).toBe(DEFAULT_TURN_STALL_WARN_MS);
    });

    it('honours explicit thresholds and the 0-disables escape hatch', () => {
        expect(readTurnStallWarnThresholdMs('0')).toBe(0);
        expect(readTurnStallWarnThresholdMs('60000')).toBe(60_000);
        expect(readTurnStallWarnThresholdMs(' 900000 ')).toBe(900_000);
        expect(readTurnStallWarnThresholdMs('120000.9')).toBe(120_000);
    });
});
