import * as React from 'react';
import type { WidgetDefinitionSummaryV1 } from '@happier-dev/protocol/widgets';

import { describeWidgetDefinitionSummaryV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';

type Account = Readonly<{ serverId: string; accountId: string }>;

/**
 * Where a definition's data comes from, in the person's words: the plugin that serves its read
 * ("analytics replica"), else simply "Your widget". Never a Resource id.
 */
export function describeYourWidgetSource(candidate: WidgetCandidate, projection: PluginUiProjectionModel | null | undefined): string {
    const names = new Set<string>();
    for (const resource of candidate.resources ?? []) {
        const name = projection?.installedPackagesById[resource.pluginId]?.displayName;
        if (name) names.add(name);
    }
    return names.size > 0 ? [...names].join(', ') : t('widgetDefinition.yourWidget');
}

/**
 * The Account's own widget definitions for the gallery's "Your widgets" (lab `dashboards` dbind G):
 * read through `widgets.definition.list` — the same Action an agent uses — only while the Add
 * is open, so a closed control reads nothing. Body reads belong to the demanded preview/mount.
 */
export function useYourWidgetCandidates(account: Account | null, projection: PluginUiProjectionModel | null | undefined): readonly WidgetCandidate[] {
    const [inventory, setInventory] = React.useState<Readonly<{ serverId: string; accountId: string;
        definitions: readonly WidgetDefinitionSummaryV1[] }> | null>(null);
    const serverId = account?.serverId;
    const accountId = account?.accountId;
    React.useEffect(() => {
        if (!serverId || !accountId) { setInventory(null); return; }
        const controller = new AbortController();
        const scope = { serverId, accountId };
        void (async () => {
            const listed = await runWidgetDefinitionCommand('widgets.definition.list', { account: scope }, scope, controller.signal);
            if (listed.kind !== 'applied' || controller.signal.aborted) return;
            if (!controller.signal.aborted) setInventory({ ...scope, definitions: listed.result.definitions });
        })();
        return () => controller.abort();
    }, [accountId, serverId]);
    return React.useMemo(() => {
        if (!inventory || inventory.serverId !== serverId || inventory.accountId !== accountId) return [];
        return inventory.definitions.map(summary => {
            const installed = summary.sourceDefinition ? readWidgetDescriptor(projection, summary.sourceDefinition) : null;
            const candidate = describeWidgetDefinitionSummaryV1(summary, installed);
            return { ...candidate, pluginName: installed?.pluginName ?? describeYourWidgetSource(candidate, projection) };
        });
    }, [inventory, serverId, accountId, projection]);
}
