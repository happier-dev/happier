import type { MachineReplacementReason } from '@happier-dev/protocol';

import {
    activeMachineRegistrationServerId,
    readMachineRegistrations,
    readMachineRegistration,
    updateMachineRegistration,
    type MachineReplacementCandidate,
} from './machineRegistrationStore';

export async function recordMachineReplacementCandidateForActiveServer(params: Readonly<{
    accountId: string | null | undefined;
    machineId: string | null | undefined;
    replacementReason: MachineReplacementReason;
    now?: number;
}>): Promise<void> {
    const accountId = params.accountId?.trim() ?? '';
    const machineId = params.machineId?.trim() ?? '';
    if (!accountId || !machineId) return;

    await updateMachineRegistration(current => ({
        ...current,
        replacementCandidates: { ...current.replacementCandidates, [accountId]: {
            machineId, replacementReason: params.replacementReason, createdAt: params.now ?? Date.now(),
        } },
    }));
}

export async function readMachineReplacementCandidateForActiveServer(params: Readonly<{
    accountId: string | null | undefined;
}>): Promise<MachineReplacementCandidate | null> {
    const accountId = params.accountId?.trim() ?? '';
    if (!accountId) return null;
    const activeServerId = activeMachineRegistrationServerId();
    const active = (await readMachineRegistration(activeServerId)).replacementCandidates;
    if (active && Object.hasOwn(active, accountId)) return active[accountId];
    const registrations = await readMachineRegistrations();
    const candidates = registrations.flatMap(([serverId, { replacementCandidates }]) =>
        serverId !== activeServerId && replacementCandidates && Object.hasOwn(replacementCandidates, accountId)
            ? [replacementCandidates[accountId]] : []);
    return candidates.length === 1 ? candidates[0] : null;
}

export async function consumeMachineReplacementCandidateAfterRegistration(params: Readonly<{
    accountId: string | null | undefined;
    didRegister: boolean;
    replacesMachineId: string | null | undefined;
}>): Promise<void> {
    if (!params.didRegister) return;
    const accountId = params.accountId?.trim() ?? '';
    const replacesMachineId = params.replacesMachineId?.trim() ?? '';
    if (!accountId || !replacesMachineId) return;

    const registrations = await readMachineRegistrations();
    await Promise.all(registrations.map(async ([serverId, { replacementCandidates }]) => {
        if (replacementCandidates?.[accountId]?.machineId !== replacesMachineId) return;
        await updateMachineRegistration(current => {
            if (current.replacementCandidates?.[accountId]?.machineId !== replacesMachineId) return current;
            const { [accountId]: _removed, ...replacementCandidates } = current.replacementCandidates;
            return { ...current, replacementCandidates };
        }, serverId);
    }));
}
