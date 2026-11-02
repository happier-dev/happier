import { readDeploymentBindingSavedSecretRevisionsV1,
    type EnvironmentSecretBindingRoutingV1 } from '@happier-dev/deployment-protocol';

export type EnvironmentSecretRequiredUseV1 = Readonly<{
    resourceId: string; resourceRevision: number; machineId: string; installationId: string;
}>;
export type EnvironmentSecretRequiredUsesProjectionV1 = Readonly<{
    status: 'complete' | 'incomplete'; requiredSecretUses: readonly EnvironmentSecretRequiredUseV1[];
}>;
type Installation = Readonly<{ machineId: string; installationId: string }>;

/** Shared placement selection. Operational purposes need their private exact owner. */
export function environmentSecretBindingInstallationsV1<T extends Installation>(
    binding: EnvironmentSecretBindingRoutingV1,
    destinations: Readonly<{ runtimeInstallations: readonly T[] | null; buildInstallation?: T | null }>,
): readonly T[] | null {
    switch (binding.purpose) {
        case 'variable': return binding.phase === 'runtime' ? destinations.runtimeInstallations
            : destinations.buildInstallation ? [destinations.buildInstallation] : [];
        case 'registry': return destinations.runtimeInstallations && destinations.buildInstallation !== null
            ? [...destinations.runtimeInstallations, ...(destinations.buildInstallation ? [destinations.buildInstallation] : [])] : null;
        default: return null;
    }
}

/** Value-free requirements from canonical captures and current placement, never delivered grants. */
export function projectEnvironmentSecretBindingRequiredUsesV1(input: Readonly<{
    referencedSavedSecretRevisions: unknown;
    /** Null means current runtime placement/installation identity is unavailable. */
    runtimeInstallations: readonly Installation[] | null;
    /** Null means a selected builder has no current installed identity; omission means none selected. */
    buildInstallation?: Installation | null;
    /** Actual current Environment relations, not identifiers inferred from binding content. */
    currentRegistryTargetLinkIds?: readonly string[];
}>): EnvironmentSecretRequiredUsesProjectionV1 {
    const captures = readDeploymentBindingSavedSecretRevisionsV1(input.referencedSavedSecretRevisions);
    if (!captures) return { status: 'incomplete', requiredSecretUses: [] };
    let complete = true;
    const uses = new Map<string, EnvironmentSecretRequiredUseV1>();
    const registryLinks = input.currentRegistryTargetLinkIds ? new Set(input.currentRegistryTargetLinkIds) : null;
    for (const capture of captures) {
        if (!capture.requiredBindings) { complete = false; continue; }
        for (const binding of capture.requiredBindings) {
            if (binding.purpose === 'registry' && !registryLinks?.has(binding.targetLinkId)) {
                complete = false;
                continue;
            }
            const installations = environmentSecretBindingInstallationsV1(binding, input);
            if (!installations?.length) { complete = false; continue; }
            for (const installation of installations) {
                const use = { resourceId: capture.resourceId, resourceRevision: capture.revision,
                    machineId: installation.machineId, installationId: installation.installationId };
                uses.set(JSON.stringify([use.resourceId, use.resourceRevision, use.machineId, use.installationId]), use);
            }
        }
    }
    return { status: complete ? 'complete' : 'incomplete', requiredSecretUses: [...uses.entries()]
        .sort(([a], [b]) => a.localeCompare(b)).map(([, use]) => use) };
}
