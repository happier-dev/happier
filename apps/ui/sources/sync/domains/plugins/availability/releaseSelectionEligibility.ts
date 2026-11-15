import type { InstalledPluginCapabilityDistributionV1 } from '@happier-dev/protocol/capabilities';
import type { PluginAccountAvailabilityReader } from './reader';

export type PluginAccountReleaseSelectionEligibility =
    | Readonly<{ kind: 'eligible' }>
    | Readonly<{ kind: 'ineligible'; reason: 'non_portable' }>;

const eligible = Object.freeze({ kind: 'eligible' as const });
const nonPortable = Object.freeze({ kind: 'ineligible' as const, reason: 'non_portable' as const });

/** Portability stays with Availability's classifier; this selects the observed candidate coordinate. */
export function readPluginAccountReleaseSelectionEligibility(input: Readonly<{
    pluginId: string;
    version: string | null;
    reader: PluginAccountAvailabilityReader | null;
    installedDistribution?: InstalledPluginCapabilityDistributionV1 | null;
    serverIdentityId: string | null;
    machineId: string | null;
}>): PluginAccountReleaseSelectionEligibility {
    // The installed trust record already knows a local source cannot publish an
    // Account release, including while the Account census is still unavailable.
    if (input.installedDistribution?.kind === 'localPath') return nonPortable;
    const reader = input.reader;
    const inventory = reader?.readMaterializations();
    // An absent census does not remove the existing direct immutable-release read.
    if (!reader || inventory?.kind !== 'available' || input.version === null) return eligible;
    const observed = inventory.materializations.filter(materialization =>
        materialization.pluginId === input.pluginId
        && materialization.version === input.version);
    const selected = observed.filter(materialization =>
        (input.serverIdentityId === null || materialization.serverIdentityId === input.serverIdentityId)
        && (input.machineId === null || materialization.machineId === input.machineId));
    // Installed can display an Account-observed release absent from the selected
    // machine. Classify that observation while preferring an exact local copy.
    const candidates = selected.length > 0 ? selected : observed;
    return candidates.length > 0 && candidates.every(materialization => {
        const { validation } = reader.classifyRelease(materialization);
        return validation.kind === 'rejected' && validation.reason === 'non_portable';
    }) ? nonPortable : eligible;
}
