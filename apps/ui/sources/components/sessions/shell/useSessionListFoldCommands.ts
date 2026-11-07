import * as React from 'react';

import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { buildSessionListCollapseKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { collapsedGroupsState } from '@/sync/domains/state/disclosureUiState';
import { t } from '@/text';

import { resolveSessionListHeaderCollapseKey, resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';
import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';

/**
 * The one writer for a Sessions-list group's fold: the device-local key qualified by the list's context
 * (Home/Account/Team, archive, layout, space). The group chevron, the reports disclosure and the mounted
 * fold command all write here; `session.list.collapsedGroups` reads and replaces the same store.
 */
export function writeSessionListGroupCollapsed(contextKey: string, groupKey: string, collapsed: boolean): void {
    collapsedGroupsState.set(buildSessionListCollapseKey(contextKey, groupKey), collapsed);
}

const EMPTY_COMMANDS: readonly CurrentUiContextLocalCommand[] = Object.freeze([]);

/**
 * Publishes a fold or unfold command for each group header the mounted list draws (P5 U3), reached through
 * `ui.current_context.read` → `ui.current_context.command.invoke`. A command sets its one group key and
 * leaves every other choice alone. A list that is not presented publishes nothing.
 */
export function useSessionListFoldCommands(input: Readonly<{
    items: readonly SessionListIndexItem[];
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    collapseContextKey: string;
    active: boolean;
}>): void {
    const { items, collapsedKeys, projectHeaderViewModelByGroupKey, collapseContextKey, active } = input;
    // Only the drawn headers, their titles and fold state decide the published commands.
    const groups = React.useMemo(() => {
        if (!active) return [];
        const seen = new Set<string>();
        const next: Array<Readonly<{ collapseKey: string; title: string; collapsed: boolean }>> = [];
        for (const item of items) {
            if (item.type !== 'header') continue;
            let collapseKey: string;
            let title: string;
            if (item.headerKind === 'folder') {
                collapseKey = resolveSessionListHeaderCollapseKey(item, projectHeaderViewModelByGroupKey);
                title = item.title;
            } else {
                const view = resolveSessionListHeaderViewState({ item, collapsedKeys, projectHeaderViewModelByGroupKey,
                    translateServerHeader: (server) => t('sessionsList.serverHeader', { server }) });
                if (!view) continue;
                collapseKey = view.collapseKey;
                title = view.kind === 'project' ? view.displayTitle : view.title;
            }
            if (!title || seen.has(collapseKey)) continue;
            seen.add(collapseKey);
            next.push({ collapseKey, title, collapsed: collapsedKeys[collapseKey] === true });
        }
        return next;
    }, [active, collapsedKeys, items, projectHeaderViewModelByGroupKey]);
    const commands = React.useMemo((): readonly CurrentUiContextLocalCommand[] => groups.length === 0 ? EMPTY_COMMANDS
        : groups.map(group => {
            const operation = group.collapsed ? 'expand' : 'collapse';
            return {
                key: `session.list.group.${operation}:${group.collapseKey}`,
                title: `${t(`common.${operation}`)} · ${group.title}`,
                invoke: () => writeSessionListGroupCollapsed(collapseContextKey, group.collapseKey, !group.collapsed),
            };
        }), [collapseContextKey, groups]);
    // Unchanged titles keep their command addresses; the definitions owner dedupes by key and title.
    useCurrentUiContextLocalCommands(commands, { contextKey: collapseContextKey });
}
