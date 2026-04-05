import type { SessionListViewItem } from '@/sync/domains/state/storage';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';

type ProjectHeaderItem = Extract<SessionListViewItem, { type: 'header' }> & { headerKind: 'project' };
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
        workspaceRefId: string | null;
    }>
    | Readonly<{
        kind: 'section';
        collapseKey: string;
        collapsed: boolean;
        title: string;
    }>;

export function resolveSessionListHeaderViewState(input: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    translateServerHeader: (server: string) => string;
}>): SessionListHeaderViewState | null {
    if (input.item.title && input.item.headerKind === 'project') {
        const groupKey = String(input.item.groupKey ?? '').trim();
        const viewModel = input.projectHeaderViewModelByGroupKey.get(groupKey) ?? null;
        const collapseKey = viewModel?.collapseKey ?? groupKey;
        const legacyWorkspaceKey = viewModel?.legacyWorkspaceKey ?? String(input.item.workspaceKey ?? '').trim();
        const scopeHint = viewModel?.scopeHint ?? input.item.workspaceScopeHint ?? null;
        const workspaceRefId = viewModel?.workspaceRefId ?? null;
        const displayTitle = viewModel?.displayTitle ?? input.item.title;
        const hasCustomLabel = viewModel?.hasCustomLabel ?? false;

        return {
            kind: 'project',
            collapseKey,
            collapsed: Boolean(input.collapsedKeys[collapseKey]),
            displayTitle,
            hasCustomLabel,
            legacyWorkspaceKey,
            scopeHint,
            workspaceRefId,
        };
    }

    if (!input.item.title) {
        return null;
    }

    const collapseKey = input.item.groupKey || `${input.item.headerKind ?? ''}:${input.item.serverId ?? 'local'}`;
    const title = input.item.headerKind === 'server'
        ? input.translateServerHeader(input.item.title)
        : input.item.title;

    return {
        kind: 'section',
        collapseKey,
        collapsed: Boolean(input.collapsedKeys[collapseKey]),
        title,
    };
}
