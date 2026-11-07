import { resolveNewSessionGroupTarget, type NewSessionGroupTarget } from './resolveSessionListHeaderActionHandlers';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { LruMap } from '@/utils/cache/lruMap';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

type WorkspaceScopeHint = Readonly<{ serverId: string; machineId: string; rootPath: string }>;

export type SessionListHeaderViewState =
    | Readonly<{
        kind: 'project';
        collapseKey: string;
        collapsed: boolean;
        displayTitle: string;
        hasCustomLabel: boolean;
        legacyWorkspaceKey: string;
        scopeHint: WorkspaceScopeHint | null;
        /** Where this group's "New session" starts (its folder, or its machine's Chats). */
        newSessionTarget: NewSessionGroupTarget | null;
        seedSessionId: string | null;
        workspaceRefId: string | null;
    }>
    | Readonly<{
        kind: 'section';
        collapseKey: string;
        collapsed: boolean;
        title: string;
    }>;

const PROJECT_HEADER_VIEW_STATE_CACHE = new LruMap<string, SessionListHeaderViewState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});
const SECTION_HEADER_VIEW_STATE_CACHE = new LruMap<string, SessionListHeaderViewState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

/**
 * The one device-local collapse key a group header's fold writes, within its list context. The header's
 * chevron and the list's mounted fold command both use it, so they always fold the same group.
 */
export function resolveSessionListHeaderCollapseKey(
    item: Extract<SessionListIndexItem, { type: 'header' }>,
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>,
): string {
    if (item.headerKind === 'folder') return item.groupKey ?? `folder:${item.folderId ?? item.title}`;
    if (item.headerKind === 'project') {
        const groupKey = String(item.groupKey ?? '').trim();
        return projectHeaderViewModelByGroupKey.get(groupKey)?.collapseKey ?? groupKey;
    }
    return item.groupKey || `${item.headerKind ?? ''}:${item.serverId ?? 'local'}`;
}

export function resolveSessionListHeaderViewState(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    translateServerHeader: (server: string) => string;
}>): SessionListHeaderViewState | null {
    if (input.item.title && input.item.headerKind === 'project') {
        const groupKey = String(input.item.groupKey ?? '').trim();
        const viewModel = input.projectHeaderViewModelByGroupKey.get(groupKey) ?? null;
        const collapseKey = resolveSessionListHeaderCollapseKey(input.item, input.projectHeaderViewModelByGroupKey);
        const legacyWorkspaceKey = viewModel?.legacyWorkspaceKey ?? String(input.item.workspaceKey ?? '').trim();
        const scopeHint = viewModel?.scopeHint ?? input.item.workspaceScopeHint ?? null;
        const newSessionTarget = resolveNewSessionGroupTarget({ workspaceScopeHint: scopeHint, workspace: input.item.workspace });
        const rawSeedSessionId = viewModel?.seedSessionId ?? String(input.item.seedSessionId ?? '').trim();
        const seedSessionId = rawSeedSessionId ? rawSeedSessionId : null;
        const workspaceRefId = viewModel?.workspaceRefId ?? null;
        const displayTitle = viewModel?.displayTitle ?? input.item.title;
        const hasCustomLabel = viewModel?.hasCustomLabel ?? false;
        const cacheKey = JSON.stringify([
            groupKey,
            input.item.title,
            input.item.headerKind,
            Boolean(input.collapsedKeys[collapseKey]),
            legacyWorkspaceKey,
            displayTitle,
            hasCustomLabel,
            workspaceRefId,
            scopeHint?.serverId ?? null,
            scopeHint?.machineId ?? null,
            scopeHint?.rootPath ?? null,
            newSessionTarget && !('rootPath' in newSessionTarget) ? newSessionTarget.machineId : null,
            seedSessionId,
        ]);
        const cached = PROJECT_HEADER_VIEW_STATE_CACHE.get(cacheKey);
        if (cached) {
            return cached;
        }

        const next: SessionListHeaderViewState = {
            kind: 'project',
            collapseKey,
            collapsed: Boolean(input.collapsedKeys[collapseKey]),
            displayTitle,
            hasCustomLabel,
            legacyWorkspaceKey,
            scopeHint,
            newSessionTarget,
            seedSessionId,
            workspaceRefId,
        };

        PROJECT_HEADER_VIEW_STATE_CACHE.set(cacheKey, next);
        return next;
    }

    if (!input.item.title) {
        return null;
    }

    const collapseKey = resolveSessionListHeaderCollapseKey(input.item, input.projectHeaderViewModelByGroupKey);
    const title = input.item.headerKind === 'server'
        ? input.translateServerHeader(input.item.title)
        : input.item.title;
    const cacheKey = JSON.stringify([
        collapseKey,
        input.item.headerKind,
        input.item.groupKey,
        input.item.serverId ?? null,
        title,
        Boolean(input.collapsedKeys[collapseKey]),
    ]);
    const cached = SECTION_HEADER_VIEW_STATE_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next: SessionListHeaderViewState = {
        kind: 'section',
        collapseKey,
        collapsed: Boolean(input.collapsedKeys[collapseKey]),
        title,
    };

    SECTION_HEADER_VIEW_STATE_CACHE.set(cacheKey, next);
    return next;
}
