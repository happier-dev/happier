import { getStorage } from '@/sync/domains/state/storageStore';
import {
    type WorkspaceRefAccountMutation,
    type WorkspaceRefAccountMutationResult,
} from '@/sync/domains/workspaces/workspaceRefs';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

type WorkspaceRefAccountSettingsFailure =
    | Readonly<{ ok: false; code: 'workspace_settings_unavailable' }>
    | Readonly<{ ok: false; code: 'workspace_settings_changed' }>
    | Readonly<{ ok: false; code: 'workspace_settings_outcome_unknown' }>;

export type WorkspaceRefAccountSettingsMutationResult = WorkspaceRefAccountMutationResult
    | WorkspaceRefAccountSettingsFailure;

/**
 * Projects have their own row/CAS owner, independent of Account Settings.
 */
async function mutateWorkspaceRefsInAccount(
    mutation: Extract<WorkspaceRefAccountMutation, { kind: 'migrate_label' }>,
): Promise<WorkspaceRefAccountSettingsMutationResult> {
    const sync = getSyncSingleton();
    const observed = getStorage().getState();
    const expectedSettingsScope = observed.settingsScope;
    if (expectedSettingsScope === null) {
        return { ok: false, code: 'workspace_settings_unavailable' };
    }

    try {
        return await sync.mutateProjectWorkspaceRef(mutation, expectedSettingsScope);
    } catch {
        // A failed transport must not claim the semantic intent committed.
        return { ok: false, code: 'workspace_settings_outcome_unknown' };
    }
}

export async function migrateLegacyWorkspaceLabelInAccount(
    input: Omit<Extract<WorkspaceRefAccountMutation, { kind: 'migrate_label' }>, 'kind'>,
): Promise<WorkspaceRefAccountSettingsMutationResult> {
    return await mutateWorkspaceRefsInAccount({ kind: 'migrate_label', ...input });
}
