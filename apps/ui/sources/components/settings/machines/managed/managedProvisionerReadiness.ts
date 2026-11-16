import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

export type ManagedProvisionerReadiness = Readonly<{
    kind: 'unverified' | 'ready' | 'needsAccount' | 'needsInstall' | 'needsSetup' | 'unavailable';
    prerequisites: readonly ManagedConfigurationFactsV1['prerequisites'][number][];
    status?: MachineProvisionerCheckResultV1['status'];
    code?: string;
    failure?: string;
    repair?: Readonly<{
        action: NonNullable<ManagedConfigurationFactsV1['prerequisites'][number]['repairAction']>;
        kind: 'connect' | 'install' | 'setup';
    }>;
    homeUnreachable: boolean;
    canConfigure: boolean;
    tone: 'ready' | 'attention' | 'none';
}>;

/** Presentation of the native answer, shared by discovery and the exact selected configuration. */
export function describeManagedProvisionerReadiness(input: Readonly<{
    check?: MachineProvisionerCheckResultV1;
    failure?: string | null;
    /** Selected options replace Check prerequisites, including an explicit empty snapshot. */
    prerequisites?: ManagedProvisionerReadiness['prerequisites'];
    optionStatus?: ManagedConfigurationFactsV1['optionStatus'];
}>): ManagedProvisionerReadiness {
    const { check, failure } = input;
    const prerequisites = input.prerequisites ?? check?.prerequisites ?? [];
    const missing = prerequisites.some(prerequisite => prerequisite.status !== 'available');
    const unknown = prerequisites.some(prerequisite => prerequisite.status === 'unknown');
    const noAccount = check?.code === 'credential_unavailable' || failure === 'credential_unavailable';
    const homeUnreachable = check?.available === true && check.code === 'home_not_guest_reachable';
    const unreadable = Boolean(failure) && !noAccount;
    const kind: ManagedProvisionerReadiness['kind'] = noAccount ? 'needsAccount'
        : unreadable ? 'unavailable'
        : !check || unknown ? 'unverified'
        : missing ? 'needsInstall'
        : homeUnreachable ? 'needsSetup'
        : input.optionStatus === 'unavailable' ? 'unavailable'
        : input.optionStatus === 'loading' ? 'unverified'
        : check.available ? 'ready' : 'needsSetup';
    const repairAction = prerequisites.find(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction)?.repairAction;
    return { kind, prerequisites, status: check?.status, code: check?.code,
        ...(failure ? { failure } : {}),
        ...(repairAction ? { repair: { action: repairAction,
            kind: noAccount ? 'connect' : missing ? 'install' : 'setup' } } : {}),
        homeUnreachable,
        canConfigure: !unreadable && !(check?.available === false && missing),
        tone: kind === 'ready' ? 'ready' : kind === 'needsAccount' || kind === 'needsInstall' || !check ? 'none' : 'attention' };
}
