import { describe, expect, it } from 'vitest';

import { selectMachinePoolCandidate, type MachinePoolWorkerObservationV1 } from './machinePoolPlacement.js';

const members = [
    { machineId: 'primary', priorityTier: 0, enabled: true },
    { machineId: 'fallback-a', priorityTier: 3, enabled: true },
    { machineId: 'fallback-b', priorityTier: 3, enabled: true },
];
const availableMachineIds = new Set(members.map((member) => member.machineId));

describe('purpose-qualified Machine Pool placement', () => {
    it('keeps priority ahead of running load, including full queue-eligible workers', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: true, load: { state: 'known', running: 8 } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: 0 } }],
        ]);
        for (const purpose of ['finite', 'service-start'] as const) {
            expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose, observations }))
                .toEqual({ machineId: 'primary', priorityTier: 0 });
        }
    });

    it('prefers the least known running count rather than treating unknown as idle', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: 8 } }],
            ['fallback-b', { eligible: true, load: { state: 'unknown' } }],
        ]);
        const input = { members, availableMachineIds, requestKey: 'one', purpose: 'finite' as const, observations };
        // Without observations the incumbent affinity selects fallback-b for this key.
        expect(selectMachinePoolCandidate(input)).toEqual({ machineId: 'fallback-a', priorityTier: 3 });
        observations.set('fallback-b', { eligible: true, load: { state: 'known', running: 2 } });
        expect(selectMachinePoolCandidate(input)).toEqual({ machineId: 'fallback-b', priorityTier: 3 });
    });

    it('retains incumbent affinity for equal and all-unknown loads, independent of input order', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>(members.map((member) => [
            member.machineId, { eligible: true, load: { state: 'unknown' } },
        ]));
        const input = { members: members.slice(1), availableMachineIds, requestKey: 'one', observations };
        const expected = { machineId: 'fallback-b', priorityTier: 3 };
        expect(selectMachinePoolCandidate({ ...input, purpose: 'finite' })).toEqual(expected);
        expect(selectMachinePoolCandidate({ ...input, purpose: 'session' })).toEqual(expected);
        for (const member of members) observations.set(member.machineId, { eligible: true, load: { state: 'known', running: 4 } });
        expect(selectMachinePoolCandidate({ ...input, members: [...input.members].reverse(), purpose: 'service-start' })).toEqual(expected);
    });

    it('excludes unnegotiated/refused finite candidates but preserves Session results', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
        ]);
        const input = { members, availableMachineIds, requestKey: 'one', observations };
        expect(selectMachinePoolCandidate({ ...input, purpose: 'finite' })).toBeNull();
        expect(selectMachinePoolCandidate({ ...input, purpose: 'session' })).toEqual({ machineId: 'primary', priorityTier: 0 });
    });
});
