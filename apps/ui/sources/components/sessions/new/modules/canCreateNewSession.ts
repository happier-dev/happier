import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { canAttemptMachineSpawn, type MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import { isDeferredManagedMachineAuthorPresetDraft, type ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { resolveMachineDestinationPurposeEligibility } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';

export function isHostBoundNewSessionMachine(params: Readonly<{
    selectedMachineId: string | null;
    hostBoundMachineId?: string | null;
    directoryKind?: 'path' | 'managed';
}>): boolean {
    return Boolean(params.selectedMachineId)
        && params.directoryKind === 'managed'
        && params.selectedMachineId === params.hostBoundMachineId;
}

export function canCreateNewSession(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    scope?: MachineReachabilityScope | null;
    /** An injected creation host owns this exact managed-directory machine. */
    hostBoundMachineId?: string | null;
    selectedPath: string;
    /** `managed`: no folder is needed; the machine keeps a private one. */
    directoryKind?: 'path' | 'managed';
    spawnReadiness?: MachineSpawnReadiness | null;
    executionTarget?: SessionAuthoringExecutionTargetV2 | null;
    managedMachineSelection?: ManagedMachineSelectionDraft | null;
}>): boolean {
    if (params.managedMachineSelection) {
        return (isDeferredManagedMachineAuthorPresetDraft(params.managedMachineSelection)
            || params.managedMachineSelection.receipt.optionStatus === 'current'
            && params.managedMachineSelection.receipt.prerequisites.every(item => item.status === 'available'))
            && (params.directoryKind === 'managed' || Boolean(params.selectedPath.trim()));
    }
    if (params.executionTarget?.kind === 'temporary_computer') {
        return true;
    }
    if (!params.selectedMachineId) return false;
    if (params.directoryKind !== 'managed' && !params.selectedPath.trim()) return false;
    if (isHostBoundNewSessionMachine(params)) return true;
    if (!params.selectedMachine) return false;
    return resolveMachineSessionStart({ machine: params.selectedMachine, selectedMachineId: params.selectedMachineId,
        scope: params.scope, spawnReadiness: params.spawnReadiness }).canStart;
}

/**
 * Whether a new Session can start on this Machine now: the one decider for the composer's Send and the Machine page's
 * Start session. A wakeable asleep created Machine starts when you send; anything else needs current spawn readiness.
 * `eligibility` carries the destination owner's refusal (and its wake cause) for the words beside a disabled control.
 */
export function resolveMachineSessionStart(params: Readonly<{
    machine: Machine;
    selectedMachineId: string | null;
    scope?: MachineReachabilityScope | null;
    spawnReadiness?: MachineSpawnReadiness | null;
}>): Readonly<{ canStart: boolean; eligibility: ReturnType<typeof resolveMachineDestinationPurposeEligibility> }> {
    const eligibility = resolveMachineDestinationPurposeEligibility('session', undefined, params.machine, params.scope);
    if (!eligibility.eligible) return { canStart: false, eligibility };
    if (eligibility.managedWake) return { canStart: params.machine.id === params.selectedMachineId, eligibility };
    return { canStart: canAttemptMachineSpawn({
        selectedMachineId: params.selectedMachineId,
        machine: params.machine,
        scope: params.scope,
        spawnReadiness: params.spawnReadiness,
    }), eligibility };
}
