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
    serverIdentityId: string | null;
    machineId: string | null;
}>): PluginAccountReleaseSelectionEligibility {
    const reader = input.reader;
    const inventory = reader?.readMaterializations();
    // An absent census does not remove the existing direct immutable-release read.
    if (!reader || inventory?.kind !== 'available' || input.version === null) return eligible;
    const candidates = inventory.materializations.filter(materialization =>
        materialization.pluginId === input.pluginId
        && materialization.version === input.version
        && (input.serverIdentityId === null || materialization.serverIdentityId === input.serverIdentityId)
        && (input.machineId === null || materialization.machineId === input.machineId));
    return candidates.length > 0 && candidates.every(materialization => {
        const { validation } = reader.classifyRelease(materialization);
        return validation.kind === 'rejected' && validation.reason === 'non_portable';
    }) ? nonPortable : eligible;
}
