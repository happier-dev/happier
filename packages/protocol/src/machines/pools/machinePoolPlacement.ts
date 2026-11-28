import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import type { MachinePoolPlacementPurposeV1 } from './v1.js';

/** Saved membership; current presence and worker observations are separate, ephemeral facts. */
export interface MachinePoolSelectableMemberV1 {
    machineId: string;
    priorityTier: number;
    enabled: boolean;
}

export interface MachinePoolSelectionV1 {
    machineId: string;
    priorityTier: number;
}

/** Advisory target facts. Eligibility includes capability/access/policy, never current fullness. */
export type MachinePoolWorkerObservationV1 = Readonly<{
    eligible: boolean;
    load: Readonly<{
        state: 'known';
        running: number;
        queued?: number;
        runAtMost?: number | null;
    }> | Readonly<{ state: 'unknown' }>;
    observedMemory?: Readonly<{
        totalBytes: number;
        availableBytes: number;
    }>;
}>;

const MEMORY_HEADROOM_BUCKET_BYTES = 256 * 1024 * 1024;
const MEMORY_HEADROOM_RATIO_BUCKETS = 20; // 5% buckets

function sanitizeObservedMemory(
    memory: MachinePoolWorkerObservationV1['observedMemory'],
): Readonly<{ totalBytes: number; availableBytes: number }> | undefined {
    if (!memory) return undefined;
    if (!Number.isFinite(memory.totalBytes) || !Number.isFinite(memory.availableBytes)) return undefined;
    if (memory.totalBytes < 0 || memory.availableBytes < 0) return undefined;
    return memory;
}

function memoryHeadroomBuckets(memory: Readonly<{ totalBytes: number; availableBytes: number }>): readonly [number, number] {
    const bytesBucket = Math.floor(Math.max(0, memory.availableBytes) / MEMORY_HEADROOM_BUCKET_BYTES);
    const ratioBucket = memory.totalBytes > 0
        ? Math.floor((Math.max(0, Math.min(memory.availableBytes, memory.totalBytes)) / memory.totalBytes) * MEMORY_HEADROOM_RATIO_BUCKETS)
        : 0;
    return [bytesBucket, ratioBucket];
}

/**
 * One pure placement owner. The smallest eligible tier always wins. Sessions keep their original
 * SHA-256 ordering of the JSON tuple [requestKey, machineId]; finite/service starts prefer known
 * load with a free immediate slot, then lowest total depth (running + queued), then coarse memory
 * headroom buckets when all tied candidates report memory, then deterministic SHA-256 tiebreak.
 * Unknown load remains eligible only when no known-load candidate exists in that tier. No
 * admission, wake, reservation or persisted decision happens here; the exact target revalidates.
 */
export function selectMachinePoolCandidate(input: Readonly<{
    members: readonly Readonly<MachinePoolSelectableMemberV1>[];
    availableMachineIds: ReadonlySet<string>;
    requestKey: string;
    purpose: MachinePoolPlacementPurposeV1;
    observations?: ReadonlyMap<string, MachinePoolWorkerObservationV1>;
}>): MachinePoolSelectionV1 | null {
    const eligible = input.members.filter((member) => member.enabled
        && input.availableMachineIds.has(member.machineId)
        && (input.purpose === 'session' || input.observations?.get(member.machineId)?.eligible === true));
    if (eligible.length === 0) return null;

    const priorityTier = eligible.reduce((lowest, member) => Math.min(lowest, member.priorityTier), eligible[0]!.priorityTier);
    let candidates = eligible.filter((member) => member.priorityTier === priorityTier);
    if (input.purpose !== 'session') {
        const known = candidates.flatMap((member) => {
            const observation = input.observations?.get(member.machineId);
            const load = observation?.load;
            if (load?.state !== 'known') return [];
            if (!Number.isFinite(load.running)) return [];
            if (load.queued !== undefined && !Number.isFinite(load.queued)) return [];
            const running = Math.max(0, load.running);
            const queued = Math.max(0, load.queued ?? 0);
            const runAtMost = load.runAtMost !== undefined && load.runAtMost !== null && Number.isFinite(load.runAtMost)
                ? Math.max(0, load.runAtMost)
                : null;
            const hasFreeSlot = runAtMost === null || running < runAtMost;
            const depth = running + queued;
            const observedMemory = sanitizeObservedMemory(observation?.observedMemory);
            return [{ member, hasFreeSlot, depth, observedMemory }];
        });
        if (known.length > 0) {
            const anyFreeSlot = known.some((candidate) => candidate.hasFreeSlot);
            let ranked = anyFreeSlot ? known.filter((candidate) => candidate.hasFreeSlot) : known;
            const lowestDepth = ranked.reduce((lowest, candidate) => Math.min(lowest, candidate.depth), ranked[0]!.depth);
            ranked = ranked.filter((candidate) => candidate.depth === lowestDepth);
            if (ranked.length > 1 && ranked.every((candidate) => candidate.observedMemory !== undefined)) {
                let bestBytes = -1;
                let bestRatio = -1;
                for (const candidate of ranked) {
                    const [bytesBucket, ratioBucket] = memoryHeadroomBuckets(candidate.observedMemory!);
                    if (bytesBucket > bestBytes || (bytesBucket === bestBytes && ratioBucket > bestRatio)) {
                        bestBytes = bytesBucket;
                        bestRatio = ratioBucket;
                    }
                }
                ranked = ranked.filter((candidate) => {
                    const [bytesBucket, ratioBucket] = memoryHeadroomBuckets(candidate.observedMemory!);
                    return bytesBucket === bestBytes && ratioBucket === bestRatio;
                });
            }
            candidates = ranked.map((candidate) => candidate.member);
        }
    }

    let selected: Readonly<MachinePoolSelectableMemberV1> | null = null;
    let selectedOrder = '';
    for (const member of candidates) {
        const order = bytesToHex(sha256(JSON.stringify([input.requestKey, member.machineId])));
        if (selected === null || order < selectedOrder || (order === selectedOrder && member.machineId < selected.machineId)) {
            selected = member;
            selectedOrder = order;
        }
    }
    return selected === null ? null : { machineId: selected.machineId, priorityTier };
}
