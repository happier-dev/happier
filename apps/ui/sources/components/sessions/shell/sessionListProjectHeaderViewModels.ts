import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

export type SessionListProjectHeaderViewModel = Readonly<{
    collapseKey: string;
    displayTitle: string;
    hasCustomLabel: boolean;
    workspaceRefId: string | null;
    legacyWorkspaceKey: string;
    scopeHint: WorkspaceScopeBase | null;
}>;

export type SessionListProjectHeaderViewModelState = Readonly<{
    projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel>;
    scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase>;
}>;

export function buildSessionListProjectHeaderViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListViewItem>;
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>): SessionListProjectHeaderViewModelState {
    const workspaceRefByScopeKey = new Map<string, WorkspaceRefV1>();
    for (const workspaceRef of input.workspaceRefs) {
        const scopeKey = tryBuildWorkspaceCacheKey(workspaceRef);
        if (!scopeKey) {
            continue;
        }
        workspaceRefByScopeKey.set(scopeKey, workspaceRef);
    }

    const projectHeaderViewModelByGroupKey = new Map<string, SessionListProjectHeaderViewModel>();
    const scopeHintByLegacyWorkspaceKey = new Map<string, WorkspaceScopeBase>();

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        const groupKey = String(item.groupKey ?? '').trim();
        if (!groupKey) {
            continue;
        }

        const legacyWorkspaceKey = String(item.workspaceKey ?? '').trim();
        const scopeHint = item.workspaceScopeHint ?? null;
        if (legacyWorkspaceKey && scopeHint) {
            scopeHintByLegacyWorkspaceKey.set(legacyWorkspaceKey, scopeHint);
        }

        const workspaceRef = scopeHint
            ? (workspaceRefByScopeKey.get(tryBuildWorkspaceCacheKey(scopeHint) ?? '') ?? null)
            : null;
        const workspaceRefId = String(workspaceRef?.id ?? '').trim() || null;
        const legacyCustomLabel = legacyWorkspaceKey ? input.workspaceLabels?.[legacyWorkspaceKey] ?? null : null;
        const displayTitle = scopeHint
            ? resolveWorkspaceDisplayLabel({ scope: scopeHint, workspaceRef, fallbackPathLabel: item.title })
            : (legacyCustomLabel ?? item.title);
        const hasCustomLabel = scopeHint
            ? Boolean(workspaceRef && String(workspaceRef.label ?? '').trim())
            : Boolean(legacyCustomLabel && String(legacyCustomLabel).trim());

        projectHeaderViewModelByGroupKey.set(groupKey, {
            collapseKey: groupKey,
            displayTitle,
            hasCustomLabel,
            workspaceRefId,
            legacyWorkspaceKey,
            scopeHint,
        });
    }

    return {
        projectHeaderViewModelByGroupKey,
        scopeHintByLegacyWorkspaceKey,
    };
}
