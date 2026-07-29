import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { getFirstPartyScmBackendLegacyLocalId } from '@/scm/registry/firstPartyScmBackendIdentity';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';

function firstAvailableMode(availableModes: readonly ScmDiffArea[]): ScmDiffArea {
    return availableModes[0] ?? 'pending';
}

export function resolveDefaultDiffModeForFile(input: {
    snapshot: ScmWorkingSnapshot | null;
    backendOverrides: Record<string, ScmDiffArea> | null | undefined;
    hasIncludedDelta: boolean;
    hasPendingDelta: boolean;
}): ScmDiffArea {
    const { snapshot, backendOverrides, hasIncludedDelta, hasPendingDelta } = input;
    const plugin = scmUiBackendRegistry.getPluginForSnapshot(snapshot);
    const config = plugin.diffModeConfig(snapshot);
    const availableModes = config.availableModes;
    const available = new Set<ScmDiffArea>(availableModes);
    const backendId = snapshot?.repo?.backendId ?? plugin.id;
    const legacyBackendId = getFirstPartyScmBackendLegacyLocalId(backendId);

    const backendPreference = backendOverrides?.[backendId]
        ?? (legacyBackendId ? backendOverrides?.[legacyBackendId] : undefined)
        ?? null;
    const preferred = backendPreference && available.has(backendPreference)
        ? backendPreference
        : available.has(config.defaultMode)
            ? config.defaultMode
            : firstAvailableMode(availableModes);

    if (hasIncludedDelta && hasPendingDelta) {
        return preferred;
    }
    if (hasIncludedDelta) {
        return available.has('included') ? 'included' : firstAvailableMode(availableModes);
    }
    if (hasPendingDelta) {
        return available.has('pending') ? 'pending' : firstAvailableMode(availableModes);
    }
    return preferred;
}
