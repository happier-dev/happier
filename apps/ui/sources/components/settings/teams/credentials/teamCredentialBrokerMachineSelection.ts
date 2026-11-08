import type { TeamCredentialSourceCandidateListOutputV1 } from '@happier-dev/protocol/teams';

import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type BrokerTarget = TeamCredentialSourceCandidateListOutputV1['brokerPresentation']['eligibleTargets'][number];
type BrokerCandidate = MachineAdministrationTargetSelectionV1['candidates'][number];

export type TeamCredentialBrokerMachineSelection = Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    availabilityByMachineId: ReadonlyMap<string, BrokerTarget['availability']>;
}>;

export function presentTeamCredentialBrokerMachineCandidate(params: Readonly<{
    candidate: BrokerCandidate;
    pickerRows: MachineAdministrationTargetSelectionV1['pickerRows'];
    unnamedTitle: string;
}>): Readonly<{ title: string; subtitle?: string }> {
    const { candidate } = params;
    const title = candidate.displayName.trim() && candidate.displayName !== candidate.target.machineId
        ? candidate.displayName
        : params.unnamedTitle;
    const row = params.pickerRows.find((item) => (
        item.candidate.target.serverIdentityId === candidate.target.serverIdentityId
        && item.candidate.target.machineId === candidate.target.machineId
    ));
    const host = row?.machine.metadata?.host?.trim();
    const serverLabel = candidate.serverLabel !== candidate.target.serverIdentityId
        && candidate.serverLabel !== candidate.target.machineId ? candidate.serverLabel : null;
    const subtitle = [host && host !== title && host !== candidate.target.machineId ? host : null, serverLabel]
        .filter(Boolean)
        .join(' · ');
    return { title, ...(subtitle ? { subtitle } : {}) };
}

/** Saved summaries and draft reviews name the same Home-qualified candidate as the editor. */
export function teamCredentialBrokerMachineLabel(params: Readonly<{
    serverId: string;
    machineId: string;
    pickerRows: MachineAdministrationTargetSelectionV1['pickerRows'];
    unnamedTitle: string;
}>): string | null {
    const row = params.pickerRows.find((item) => item.candidate.target.machineId === params.machineId
        && (item.serverId === params.serverId || areServerProfileIdentifiersEquivalent(
            item.candidate.target.serverIdentityId, params.serverId,
        )));
    return row ? presentTeamCredentialBrokerMachineCandidate({
        candidate: row.candidate, pickerRows: params.pickerRows, unnamedTitle: params.unnamedTitle,
    }).title : null;
}

export function resolveTeamCredentialBrokerMachineCandidateAvailability(params: Readonly<{
    candidate: BrokerCandidate;
    availabilityByMachineId: TeamCredentialBrokerMachineSelection['availabilityByMachineId'];
    updateRequiredDetail: string;
    offlineDetail: string;
    unavailableDetail: string;
    onlineDetail: string;
}>): Readonly<{ detail: string; selectable: boolean }> {
    const projected = params.availabilityByMachineId.get(params.candidate.target.machineId);
    if (projected === 'update_required') return { detail: params.updateRequiredDetail, selectable: false };
    if (params.candidate.availability !== 'online' && params.candidate.availability !== 'offline') {
        return { detail: params.unavailableDetail, selectable: false };
    }
    if (projected === 'offline' || params.candidate.availability === 'offline' || params.candidate.observation === 'stale') {
        return { detail: params.offlineDetail, selectable: true };
    }
    return { detail: params.onlineDetail, selectable: true };
}

/**
 * Joins the Home-owned exact eligible ids to the canonical Administration rows.
 * Eligibility never comes from presence, and a same-id Machine on another Home
 * cannot enter the choice set.
 */
export function buildTeamCredentialBrokerMachineSelection(params: Readonly<{
    serverId: string;
    eligibleTargets: readonly BrokerTarget[];
    selectedMachineId: string | null;
    pickerRows: MachineAdministrationTargetSelectionV1['pickerRows'];
    onSelectMachineId: (machineId: string) => void;
    onClear: () => void;
}>): TeamCredentialBrokerMachineSelection {
    const eligibleByMachineId = new Map(params.eligibleTargets.map((target) => [target.machineId, target]));
    const pickerRows = params.pickerRows
        .filter((row) => eligibleByMachineId.has(row.candidate.target.machineId)
            && (row.serverId === params.serverId || areServerProfileIdentifiersEquivalent(
                row.candidate.target.serverIdentityId,
                params.serverId,
            )))
        .map((row) => {
            const projected = eligibleByMachineId.get(row.candidate.target.machineId)!;
            const availability = projected.availability === 'update_required'
                ? 'locked' as const
                : projected.availability === 'offline' && row.candidate.availability === 'online'
                    ? 'offline' as const
                    : row.candidate.availability;
            return availability === row.candidate.availability
                ? row
                : { ...row, candidate: { ...row.candidate, availability } };
        });
    const candidates = pickerRows.map((row) => row.candidate);
    const selectedRow = params.selectedMachineId === null
        ? null
        : pickerRows.find((row) => row.candidate.target.machineId === params.selectedMachineId) ?? null;
    const selectedTarget = params.selectedMachineId === null
        ? null
        : selectedRow?.candidate.target ?? { serverIdentityId: params.serverId, machineId: params.selectedMachineId };
    const state = resolveMachineAdministrationTargetState({
        storedTarget: selectedTarget,
        candidates,
        allowSoleCandidate: false,
        // The Home's eligible list is the settled answer here: a selected machine it still lists is
        // only not in this device's rows yet, never gone; one it no longer lists has left the choice.
        isInventoryKnown: () => params.selectedMachineId === null || !eligibleByMachineId.has(params.selectedMachineId),
    });
    const selection: MachineAdministrationTargetSelectionV1 = {
        changeIntent: 'draft',
        candidates,
        pickerRows,
        state,
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: true,
        canExecute: false,
        selectTarget: (target) => {
            const row = pickerRows.find((candidateRow) => (
                candidateRow.candidate.target.serverIdentityId === target.serverIdentityId
                && candidateRow.candidate.target.machineId === target.machineId
            ));
            const projected = eligibleByMachineId.get(target.machineId);
            if (row && projected?.availability !== 'update_required'
                && (row.candidate.availability === 'online' || row.candidate.availability === 'offline')) {
                params.onSelectMachineId(target.machineId);
            }
        },
        clearTarget: params.onClear,
        resolveExecutionTarget: () => null,
    };
    return {
        selection,
        availabilityByMachineId: new Map(params.eligibleTargets.map((target) => [target.machineId, target.availability])),
    };
}
