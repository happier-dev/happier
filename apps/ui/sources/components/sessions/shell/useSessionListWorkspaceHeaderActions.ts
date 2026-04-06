import * as React from 'react';

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
    const handleRenameWorkspace = React.useCallback(async (params: Readonly<{
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
    }, [input.setWorkspaceRefs, input.workspaceRefs]);

    const handleResetWorkspaceName = React.useCallback((params: Readonly<{
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
    }, [input.setWorkspaceRefs, input.workspaceRefs]);

    const handleToggleCollapse = React.useCallback((collapseKey: string) => {
        const current = input.collapsedGroupKeys;
        if (current[collapseKey]) {
            const next = { ...current };
            delete next[collapseKey];
            input.setCollapsedGroupKeys(next);
            return;
        }
        input.setCollapsedGroupKeys({ ...current, [collapseKey]: true });
    }, [input.collapsedGroupKeys, input.setCollapsedGroupKeys]);

    return {
        handleRenameWorkspace,
        handleResetWorkspaceName,
        handleToggleCollapse,
    };
}
