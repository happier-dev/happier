import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '../runtimePathMatching.js';
import type { HappierInstallation, HappierInstallationInventory } from '../types.js';

export function resolvePreferredHappierCliInstallation(params: Readonly<{
    inventory: HappierInstallationInventory;
    preferredCliCommand: 'happier' | 'hprev' | 'hdev' | null;
}>): HappierInstallation | null {
    if (!params.preferredCliCommand) {
        return null;
    }

    const candidates = params.inventory.installations
        .filter((entry) => (
            entry.onPath
            && entry.components.includes('happier-cli')
            && entry.shimName === params.preferredCliCommand
        ))
        .sort((left, right) => {
            const leftOrder = typeof left.pathOrder === 'number' ? left.pathOrder : Number.POSITIVE_INFINITY;
            const rightOrder = typeof right.pathOrder === 'number' ? right.pathOrder : Number.POSITIVE_INFINITY;
            return leftOrder - rightOrder || left.path.localeCompare(right.path);
        });

    const selectedCandidate = candidates[0] ?? null;
    if (!selectedCandidate) {
        return null;
    }

    const candidateRuntimePath = normalizeHappierRuntimePath(selectedCandidate.realPath ?? selectedCandidate.path);
    if (!candidateRuntimePath) {
        return selectedCandidate;
    }

    return params.inventory.installations.find((entry) => {
        if (entry.id === selectedCandidate.id) {
            return false;
        }
        if (!entry.components.includes('happier-cli')) {
            return false;
        }
        const roots = [entry.path, entry.realPath]
            .map(normalizeHappierRuntimePath)
            .filter((value): value is string => Boolean(value));
        return roots.some((root) => isHappierRuntimePathWithinRoot(candidateRuntimePath, root));
    }) ?? selectedCandidate;
}
