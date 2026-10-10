import { Modal } from '@/modal';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { updateProjectWorkspace } from '@/sync/ops/actions/projectWorkspaceActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

export function useSessionListWorkspaceHeaderActions(input: Readonly<{
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    setCollapsedGroupKeys: (value: Record<string, boolean>) => void;
}>) {
    return {
        handleRenameWorkspace: async (params: Readonly<{
            legacyWorkspaceKey: string;
            scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
            currentLabel: string;
        }>) => {
            if (!params.scopeHint) return;
            const currentRef = findWorkspaceRefByScope(input.workspaceRefs, params.scopeHint);
            if (!currentRef) { Modal.alert(t('common.error'), t('common.saveError')); return; }
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime?.isCurrent()) return;
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
                if ((currentRef?.label ?? null) === newName.trim()) {
                    return;
                }
                const result = await updateProjectWorkspace({
                    serverId: currentRef.serverId,
                    workspaceId: currentRef.id,
                    label: newName.trim(),
                }, lifetime);
                if (!result.ok) Modal.alert(t('common.error'), t('common.saveError'));
            }
        },
        handleResetWorkspaceName: async (params: Readonly<{
            legacyWorkspaceKey: string;
            scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        }>) => {
            if (!params.scopeHint) return;
            const currentRef = findWorkspaceRefByScope(input.workspaceRefs, params.scopeHint);
            if ((currentRef?.label ?? null) === null) {
                return;
            }
            const result = await updateProjectWorkspace({
                serverId: params.scopeHint.serverId,
                workspaceId: currentRef!.id,
                label: null,
            });
            if (!result.ok) Modal.alert(t('common.error'), t('common.saveError'));
        },
        handleToggleCollapse: (collapseKey: string) => {
            const current = input.collapsedGroupKeys;
            if (current[collapseKey]) {
                input.setCollapsedGroupKeys({ ...current, [collapseKey]: false });
                return;
            }
            input.setCollapsedGroupKeys({ ...current, [collapseKey]: true });
        },
    };
}
