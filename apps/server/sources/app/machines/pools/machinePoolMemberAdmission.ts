import { isPersistentMachine, type MachineKind } from '@happier-dev/protocol/machines/machineKind';
import type { MachinePoolMemberEligibilityV1 } from '@happier-dev/protocol/machines/pools/v1';

import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import type { Tx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

type AdmissionMachine = Readonly<{ id: string; kind: MachineKind; revokedAt: Date | null; replacedByMachineId: string | null }>;

function projectMemberEligibility(machineId: string, machine: AdmissionMachine | undefined): MachinePoolMemberEligibilityV1 {
    if (!machine) return { machineId, eligible: false, reason: 'not_owned_or_missing' };
    const lifecycle = classifyMachineAvailabilityState(machine);
    if (lifecycle === 'revoked' || lifecycle === 'replaced') return { machineId, eligible: false, reason: lifecycle };
    if (!isPersistentMachine(machine)) return { machineId, eligible: false, reason: 'temporary' };
    return { machineId, eligible: true };
}

async function readMemberEligibility(client: Tx | typeof db, accountId: string, machineIds: readonly string[]): Promise<readonly MachinePoolMemberEligibilityV1[]> {
    const machineById = new Map<string, AdmissionMachine>();
    for (const chunk of portableQueryChunks({ values: [...new Set(machineIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        const machines = await client.machine.findMany({
            where: { accountId, id: { in: [...chunk] } },
            select: { id: true, kind: true, revokedAt: true, replacedByMachineId: true },
        });
        for (const machine of machines) machineById.set(machine.id, machine);
    }
    return machineIds.map(machineId => projectMemberEligibility(machineId, machineById.get(machineId)));
}

/** Account-scoped, non-disclosing projection of the same decision used by Pool writes. */
export async function getMachinePoolMemberEligibility(params: Readonly<{
    accountId: string;
    machineIds: readonly string[];
}>): Promise<readonly MachinePoolMemberEligibilityV1[]> {
    return readMemberEligibility(db, params.accountId, params.machineIds);
}

/** The one admission owner for new Pool references and re-enabling saved references. */
export async function validateMachinePoolMembersInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    members: readonly Readonly<{ machineId: string; priorityTier: number; enabled: boolean }>[];
    current?: Readonly<{ members: readonly Readonly<{ machineId: string; enabled: boolean }>[] }>;
}>): Promise<readonly string[]> {
    if (params.members.length === 0) return [];
    const eligibility = await readMemberEligibility(params.tx, params.accountId, params.members.map(member => member.machineId));
    const eligibilityById = new Map(eligibility.map(member => [member.machineId, member]));
    const currentById = new Map(params.current?.members.map((member) => [member.machineId, member]));
    return params.members.flatMap((member) => {
        const decision = eligibilityById.get(member.machineId)!;
        if (decision.eligible) return [];
        if (decision.reason === 'not_owned_or_missing') return [member.machineId];
        const existing = currentById.get(member.machineId);
        // Tier edits and disabling a saved reference do not admit a Machine.
        // A new reference or re-enable still requires current eligibility.
        return existing && (existing.enabled || !member.enabled) ? [] : [member.machineId];
    });
}
