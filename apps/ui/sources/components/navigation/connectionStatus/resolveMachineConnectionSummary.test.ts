import { describe, expect, it } from 'vitest';

import { resolveMachineConnectionSummary } from './resolveMachineConnectionSummary';

describe('resolveMachineConnectionSummary', () => {
    it('returns unknown when there are no machines but some server counts are unknown', () => {
        expect(resolveMachineConnectionSummary({
            machineCount: 0,
            onlineCount: 0,
            hasUnknownMachines: true,
            primaryMachineLabel: null,
        })).toEqual({ kind: 'unknown' });
    });

    it('returns none when no machines are present', () => {
        expect(resolveMachineConnectionSummary({
            machineCount: 0,
            onlineCount: 0,
            hasUnknownMachines: false,
            primaryMachineLabel: null,
        })).toEqual({ kind: 'none' });
    });

    it('returns single when exactly one machine exists', () => {
        expect(resolveMachineConnectionSummary({
            machineCount: 1,
            onlineCount: 1,
            hasUnknownMachines: false,
            primaryMachineLabel: 'mbp',
        })).toEqual({ kind: 'single', label: 'mbp', online: true });
    });

    it('returns multiple summary counts', () => {
        expect(resolveMachineConnectionSummary({
            machineCount: 3,
            onlineCount: 2,
            hasUnknownMachines: false,
            primaryMachineLabel: null,
        })).toEqual({ kind: 'multiple', onlineCount: 2, offlineCount: 1 });
    });
});
