import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';

export type ProjectSelectionPreferenceKeys = Readonly<{
    storageKey: string;
    predecessorStorageKey: string | null;
}>;

/** Local checkout preferences are Home-qualified. Bare-id predecessor values
 * are readable only while the complete candidate set proves their Home. */
export function resolveProjectSelectionPreferenceKeys(
    refs: readonly WorkspaceRefV1[],
    target: Readonly<{ id: string; serverId: string }>,
): ProjectSelectionPreferenceKeys | null {
    const selected = resolveWorkspaceRefById(refs, target.id, target.serverId);
    if (selected.kind !== 'resolved') return null;
    const predecessor = resolveWorkspaceRefById(refs, target.id);
    return {
        storageKey: `project-selection:v1:${JSON.stringify([resolveServerProfileScopeIdForIdentifier(selected.ref.serverId), selected.ref.id])}`,
        predecessorStorageKey: predecessor.kind === 'resolved' && predecessor.ref === selected.ref ? selected.ref.id : null,
    };
}

export function readProjectSelectionPreference(
    values: Readonly<Record<string, string>> | null | undefined,
    keys: ProjectSelectionPreferenceKeys | null,
): string | null {
    if (!keys) return null;
    const value = values?.[keys.storageKey]
        ?? (keys.predecessorStorageKey ? values?.[keys.predecessorStorageKey] : undefined);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function writeProjectSelectionPreference(
    values: Readonly<Record<string, string>> | null | undefined,
    keys: ProjectSelectionPreferenceKeys | null,
    value: string,
): Record<string, string> {
    return keys ? { ...values, [keys.storageKey]: value } : { ...values };
}
