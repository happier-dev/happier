import { Modal } from '@/modal';
import type { ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import { projectGroupIdentityKey, readProjectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { updateProjectOrganization } from '@/sync/ops/actions/projectWorkspaceActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

export function useSessionListWorkspaceHeaderActions(input: Readonly<{
    /** Undefined means the opened Account's complete organization census is unavailable. */
    projectOrganizations?: readonly ProjectOrganizationRow[];
    toggleCollapsedGroup: (groupKey: string) => void;
}>) {
    return {
        handleRenameWorkspace: async (params: Readonly<{
            legacyWorkspaceKey: string;
            scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
            currentLabel: string;
        }>) => {
            const projectRef = readProjectGroupIdentityKey(params.legacyWorkspaceKey);
            if (!projectRef || !input.projectOrganizations) { Modal.alert(t('common.error'), t('common.saveError')); return; }
            const current = input.projectOrganizations.find(row => projectGroupIdentityKey(row.key) === projectGroupIdentityKey(projectRef));
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(projectRef.serverId, lifetime.scope.serverId)) return;
            const newName = await Modal.prompt(
                t('sessionsList.renameWorkspacePromptTitle'),
                undefined,
                {
                    defaultValue: params.currentLabel,
                    placeholder: t('sessionsList.renameWorkspacePromptPlaceholder'),
                    confirmText: t('common.save'),
                    cancelText: t('common.cancel'),
                },
            );
            if (newName !== null && newName.trim()) {
                if (current?.value.label === newName.trim()) {
                    return;
                }
                const result = await updateProjectOrganization({
                    projectRef,
                    expectedRevision: current?.revision ?? 'absent',
                    label: newName.trim(),
                }, lifetime);
                if (!result.ok) Modal.alert(t('common.error'), t('common.saveError'));
            }
        },
        handleResetWorkspaceName: async (params: Readonly<{
            legacyWorkspaceKey: string;
            scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        }>) => {
            const projectRef = readProjectGroupIdentityKey(params.legacyWorkspaceKey);
            if (!projectRef || !input.projectOrganizations) { Modal.alert(t('common.error'), t('common.saveError')); return; }
            const current = input.projectOrganizations.find(row => projectGroupIdentityKey(row.key) === projectGroupIdentityKey(projectRef));
            if (!current?.value.label) {
                return;
            }
            const lifetime = captureActiveServerAccountScopeLifetime();
            const result = await updateProjectOrganization({
                projectRef,
                expectedRevision: current.revision,
                label: null,
            }, lifetime);
            if (!result.ok) Modal.alert(t('common.error'), t('common.saveError'));
        },
        handleToggleCollapse: input.toggleCollapsedGroup,
    };
}
