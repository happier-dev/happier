import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { buildLegacySessionWorkspaceAliasIndex, type LegacyWorkspaceAliasMachine } from '../listing/legacySessionWorkspaceAliases';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { areSessionAppearanceColorsEqual, type SessionAppearanceColor } from './appearanceColor';

/** Opened predecessor appearance rows follow only an unambiguous accepted checkout. */
export function projectSessionWorkspaceColors(input: Readonly<{
    workspaceColors: Readonly<Record<string, SessionAppearanceColor>>;
    workspaceRefs: readonly WorkspaceRefV1[];
    censusServerId?: string;
    machines?: MachineCollection<LegacyWorkspaceAliasMachine>;
}>): Readonly<Record<string, SessionAppearanceColor>> {
    const legacyKeys = Object.keys(input.workspaceColors).filter(key => /^wl_[0-9a-f]{8}$/.test(key));
    if (!legacyKeys.length || !input.censusServerId || !input.machines) return input.workspaceColors;
    const aliases = buildLegacySessionWorkspaceAliasIndex(input.workspaceRefs, input.censusServerId, input.machines);
    const candidates = new Map<string, SessionAppearanceColor | null>();
    for (const key of legacyKeys) {
        const ref = aliases.get(key);
        if (!ref) continue;
        const projectKey = projectGroupIdentityKey(projectWorkspaceRefV1(ref));
        if (input.workspaceColors[projectKey]) continue;
        const previous = candidates.get(projectKey);
        const color = input.workspaceColors[key]!;
        // Multiple differently coloured checkouts cannot elect a Project override.
        candidates.set(projectKey, previous === undefined || previous !== null && areSessionAppearanceColorsEqual(previous, color) ? color : null);
    }
    let result: Record<string, SessionAppearanceColor> | null = null;
    for (const [key, color] of candidates) if (color) {
        result ??= { ...input.workspaceColors };
        result[key] = color;
    }
    return result ?? input.workspaceColors;
}
