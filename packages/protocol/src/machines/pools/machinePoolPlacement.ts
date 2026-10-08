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
    load: Readonly<{ state: 'known'; running: number }> | Readonly<{ state: 'unknown' }>;
}>;

/**
 * One pure placement owner. The smallest eligible tier always wins. Sessions keep their original
 * SHA-256 ordering of the JSON tuple [requestKey, machineId]; finite/service starts first prefer the
 * least known running count in that tier. Unknown load remains eligible but is never zero. No
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
            const load = input.observations?.get(member.machineId)?.load;
            return load?.state === 'known' ? [{ member, running: load.running }] : [];
        });
        if (known.length > 0) {
            const running = known.reduce((lowest, candidate) => Math.min(lowest, candidate.running), known[0]!.running);
            candidates = known.filter((candidate) => candidate.running === running).map((candidate) => candidate.member);
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
