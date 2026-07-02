import { Modal } from '@/modal';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { findWorkspaceRefByScope, upsertWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';

export function useSessionListWorkspaceHeaderActions(input: Readonly<{
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    setWorkspaceRefs: (value: WorkspaceRefV1[]) => void;
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
                const currentRef = findWorkspaceRefByScope(input.workspaceRefs, params.scopeHint);
                if ((currentRef?.label ?? null) === newName.trim()) {
                    return;
                }
                input.setWorkspaceRefs(upsertWorkspaceRefByScope(input.workspaceRefs, {
                    scope: params.scopeHint,
                    nowMs: Date.now(),
                    patch: { label: newName.trim() },
                }));
            }
        },
        handleResetWorkspaceName: (params: Readonly<{
            legacyWorkspaceKey: string;
            scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        }>) => {
            if (!params.scopeHint) return;
            const currentRef = findWorkspaceRefByScope(input.workspaceRefs, params.scopeHint);
            if ((currentRef?.label ?? null) === null) {
                return;
            }
            input.setWorkspaceRefs(upsertWorkspaceRefByScope(input.workspaceRefs, {
                scope: params.scopeHint,
                nowMs: Date.now(),
                patch: { label: null },
            }));
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
