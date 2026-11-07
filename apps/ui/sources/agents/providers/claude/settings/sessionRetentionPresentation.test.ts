import { describe, expect, it } from 'vitest';
import { retentionMachineStatus } from './sessionRetentionPresentation';

describe('retention machine status', () => {
    it.each([
        { reportStartedAt: 20, expected: 'error' },
        { reportStartedAt: 10, expected: 'unknown' },
    ])('admits generic apply errors only from the current daemon ($expected)', ({ reportStartedAt, expected }) => {
        expect(retentionMachineStatus({
            pid: 123,
            startedAt: 20,
            cliVersion: '0.0.0-test',
            source: { pid: 123, startedAt: reportStartedAt, cliVersion: '0.0.0-test' },
            report: { status: 'error', reason: 'provider_settings_failed' },
        }, null)).toBe(expected);
    });
});
