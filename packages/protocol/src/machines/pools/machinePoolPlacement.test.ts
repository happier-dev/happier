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

    it('prefers a worker with a free execution slot over a saturated worker even when running counts are lower', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: 2, queued: 0, runAtMost: 4 } }],
            ['fallback-b', { eligible: true, load: { state: 'known', running: 1, queued: 0, runAtMost: 1 } }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations }))
            .toEqual({ machineId: 'fallback-a', priorityTier: 3 });
    });

    it('ranks by lowest total depth (running + queued) when free-slot availability is equal', () => {
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: 2, queued: 0, runAtMost: 2 } }],
            ['fallback-b', { eligible: true, load: { state: 'known', running: 1, queued: 3, runAtMost: 1 } }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations }))
            .toEqual({ machineId: 'fallback-a', priorityTier: 3 });
    });

    it('breaks equal-load ties using coarse memory headroom buckets while ignoring minor jitter', () => {
        const GiB = 1024 ** 3;
        const MiB = 1024 ** 2;
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', {
                eligible: true,
                load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
                observedMemory: { totalBytes: 64 * GiB, availableBytes: 32 * GiB },
            }],
            ['fallback-b', {
                eligible: true,
                load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
                observedMemory: { totalBytes: 16 * GiB, availableBytes: 4 * GiB },
            }],
        ]);
        // Incumbent SHA-256 tiebreak picks fallback-b for requestKey='one'; higher headroom overrides it to fallback-a.
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations }))
            .toEqual({ machineId: 'fallback-a', priorityTier: 3 });
        // Tiny memory jitter within the same 256 MiB and 5% bucket preserves deterministic SHA-256 tiebreak (fallback-b).
        observations.set('fallback-a', {
            eligible: true,
            load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
            observedMemory: { totalBytes: 64 * GiB, availableBytes: 32 * GiB + 64 * MiB },
        });
        observations.set('fallback-b', {
            eligible: true,
            load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
            observedMemory: { totalBytes: 64 * GiB, availableBytes: 32 * GiB + 32 * MiB },
        });
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations }))
            .toEqual({ machineId: 'fallback-b', priorityTier: 3 });
    });

    it('still prioritizes priorityTier over free slots, queue depth, and memory headroom', () => {
        const GiB = 1024 ** 3;
        const observations = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', {
                eligible: true,
                load: { state: 'known', running: 4, queued: 5, runAtMost: 4 },
                observedMemory: { totalBytes: 8 * GiB, availableBytes: 1 * GiB },
            }],
            ['fallback-a', {
                eligible: true,
                load: { state: 'known', running: 0, queued: 0, runAtMost: 16 },
                observedMemory: { totalBytes: 128 * GiB, availableBytes: 120 * GiB },
            }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations }))
            .toEqual({ machineId: 'primary', priorityTier: 0 });
    });

    it('sanitizes non-finite load and memory observations so NaN never collapses eligible selection to null', () => {
        const GiB = 1024 ** 3;
        // NaN running/queued on one candidate is treated as unknown load rather than poisoning Math.min to NaN -> null.
        const withNanLoad = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: Number.NaN, queued: 0, runAtMost: 4 } }],
            ['fallback-b', { eligible: true, load: { state: 'known', running: 1, queued: 0, runAtMost: 4 } }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations: withNanLoad }))
            .toEqual({ machineId: 'fallback-b', priorityTier: 3 });

        // All candidates having non-finite load still selects deterministically rather than returning null.
        const allNanLoad = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: Number.NaN, queued: Number.POSITIVE_INFINITY } }],
            ['fallback-b', { eligible: true, load: { state: 'known', running: 1, queued: Number.NaN } }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations: allNanLoad }))
            .not.toBeNull();

        // Non-finite observedMemory on a tied candidate is ignored rather than collapsing selection to null.
        const withNanMemory = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', {
                eligible: true,
                load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
                observedMemory: { totalBytes: 64 * GiB, availableBytes: Number.NaN },
            }],
            ['fallback-b', {
                eligible: true,
                load: { state: 'known', running: 1, queued: 0, runAtMost: 4 },
                observedMemory: { totalBytes: 16 * GiB, availableBytes: 8 * GiB },
            }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations: withNanMemory }))
            .not.toBeNull();

        // Negative running/queued values are clamped to 0.
        const withNegativeLoad = new Map<string, MachinePoolWorkerObservationV1>([
            ['primary', { eligible: false, load: { state: 'unknown' } }],
            ['fallback-a', { eligible: true, load: { state: 'known', running: -5, queued: -2, runAtMost: 4 } }],
            ['fallback-b', { eligible: true, load: { state: 'known', running: 0, queued: 1, runAtMost: 4 } }],
        ]);
        expect(selectMachinePoolCandidate({ members, availableMachineIds, requestKey: 'one', purpose: 'finite', observations: withNegativeLoad }))
            .toEqual({ machineId: 'fallback-a', priorityTier: 3 });
    });
});
