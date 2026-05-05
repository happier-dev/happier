import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListProjectHeaderViewModel = Readonly<{
    collapseKey: string;
    displayTitle: string;
    hasCustomLabel: boolean;
    workspaceRefId: string | null;
    legacyWorkspaceKey: string;
    scopeHint: WorkspaceScopeBase | null;
    seedSessionId: string | null;
}>;

export type SessionListProjectHeaderViewModelState = Readonly<{
    projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel>;
    scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase>;
}>;

const EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE: SessionListProjectHeaderViewModelState = {
    projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
    scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
};

const SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE = new LruMap<string, SessionListProjectHeaderViewModelState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function appendCachePart(parts: string[], value: string): void {
    parts.push(value);
}

function buildSessionListProjectHeaderViewModelStateCacheKey(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>): string {
    const parts: string[] = ['session-list-project-header-view-model-state'];

    for (const [workspaceKey, workspaceLabel] of Object.entries(input.workspaceLabels ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))) {
        appendCachePart(parts, `workspaceLabel:${workspaceKey}:${workspaceLabel}`);
    }

    for (const workspaceRef of input.workspaceRefs) {
        appendCachePart(parts, [
            'workspaceRef',
            String(workspaceRef.id ?? ''),
            String(workspaceRef.serverId ?? ''),
            String(workspaceRef.machineId ?? ''),
            String(workspaceRef.rootPath ?? ''),
            String(workspaceRef.label ?? ''),
        ].join('|'));
    }

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        appendCachePart(parts, [
            'projectHeader',
            String(item.groupKey ?? ''),
            String(item.title ?? ''),
            String(item.workspaceKey ?? ''),
            String(item.workspaceScopeHint?.serverId ?? ''),
            String(item.workspaceScopeHint?.machineId ?? ''),
            String(item.workspaceScopeHint?.rootPath ?? ''),
            String(item.seedSessionId ?? ''),
            String(item.serverId ?? ''),
            String(item.serverName ?? ''),
        ].join('|'));
    }

    return parts.join('::');
}

export function buildSessionListProjectHeaderViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>): SessionListProjectHeaderViewModelState {
    const cacheKey = buildSessionListProjectHeaderViewModelStateCacheKey(input);
    const cachedState = SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.get(cacheKey);
    if (cachedState) {
        return cachedState;
    }

    let projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel> | null = null;
    let scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase> | null = null;

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
            projectHeaderViewModelByGroupKey = new Map<string, SessionListProjectHeaderViewModel>();
            scopeHintByLegacyWorkspaceKey = new Map<string, WorkspaceScopeBase>();
        }

        const groupKey = String(item.groupKey ?? '').trim();
        if (!groupKey) {
            continue;
        }

        const legacyWorkspaceKey = String(item.workspaceKey ?? '').trim();
        const scopeHint = item.workspaceScopeHint ?? null;
        const seedSessionId = String(item.seedSessionId ?? '').trim() || null;
        if (legacyWorkspaceKey && scopeHint) {
            scopeHintByLegacyWorkspaceKey.set(legacyWorkspaceKey, scopeHint);
        }

        const legacyCustomLabel = legacyWorkspaceKey ? input.workspaceLabels?.[legacyWorkspaceKey] ?? null : null;
        const presentation = resolveWorkspaceDisplayPresentation({
            scope: scopeHint,
            workspaceRefs: input.workspaceRefs,
            fallbackPathLabel: item.title,
            legacyLabel: legacyCustomLabel,
        });

        projectHeaderViewModelByGroupKey.set(groupKey, {
            collapseKey: groupKey,
            displayTitle: presentation.displayTitle,
            hasCustomLabel: presentation.hasCustomLabel,
            workspaceRefId: presentation.workspaceRefId,
            legacyWorkspaceKey,
            scopeHint,
            seedSessionId,
        });
    }

    if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
        return EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE;
    }

    const nextState: SessionListProjectHeaderViewModelState = {
        projectHeaderViewModelByGroupKey,
        scopeHintByLegacyWorkspaceKey,
    };

    SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, nextState);
    return nextState;
}
