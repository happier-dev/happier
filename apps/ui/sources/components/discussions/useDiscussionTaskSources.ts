import * as React from 'react';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { buildTriageEntryPageV1, buildTriageEntryRouteSegmentV1, isInternalTaskReferenceV1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useBoardTaskItems } from '@/components/boards/model/useBoardTaskItems';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

function taskRef(serverId: string, id: string): BoardItemRefV1 {
    return { kind: 'task', pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, qualifiedId: { serverId, id } };
}

export type DiscussionTaskSource = Readonly<{ title: string; href: string | null }>;

/** Reuse the same live, Account-scoped resolution that supplies Boards and Session header Tasks. */
export function useDiscussionTaskSources(scope: ServerAccountScope, entries: readonly TriageEntryRefV1[], enabled: boolean) {
    const { serverId } = scope;
    const demanded = enabled && entries.length > 0;
    const inAppScope = useAppShellPluginUiProjection(view => areServerAccountScopesEqual(view.accountLifetime?.scope, scope), demanded);
    const refs = React.useMemo(() => [...new Set(entries.filter(isInternalTaskReferenceV1).map(buildTriageEntryRouteSegmentV1))]
        .sort().map(id => taskRef(serverId, id)), [entries, serverId]);
    const { items, settled } = useBoardTaskItems(serverId, refs, undefined, demanded && inAppScope);
    const resolve = React.useCallback((entry: TriageEntryRefV1): DiscussionTaskSource | null => {
        const item = items.get(buildWorkBoardItemKeyV1(taskRef(serverId, buildTriageEntryRouteSegmentV1(entry))));
        return item ? { title: item.title, href: item.page ? buildPluginAppPageRoutePath({
            pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: item.page.pageId, subPath: item.page.subPath,
        }) : null } : null;
    }, [items, serverId]);
    const resolveEntryHref = React.useCallback((entry: TriageEntryRefV1) => {
        if (!enabled || !inAppScope) return null;
        if (isInternalTaskReferenceV1(entry)) return resolve(entry)?.href ?? null;
        return buildPluginAppPageRoutePath(buildTriageEntryPageV1(entry));
    }, [enabled, inAppScope, resolve]);
    return { resolve, resolveEntryHref, settled };
}
