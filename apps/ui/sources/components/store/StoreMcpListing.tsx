import * as React from 'react';
import { McpAddController, type McpAddSelection, type OpenMcpAddModalParams } from '@/components/settings/mcpServers/add/openMcpAddModal';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { isMcpAddSuggestion, type McpAddCatalogRow } from '@/components/settings/mcpServers/add/mcpAddModalConfig';

export type StoreMcpListingState = Readonly<{
    config: CapabilityAddModalConfig<McpAddCatalogRow> | null;
    item: RegistryCatalogItemSummary | null;
    resolving: boolean;
}>;

/** Data/controller binding only: the pane, page and Add reuse the native detail and receipt owner. */
export function StoreMcpListing(props: Readonly<{
    selection: McpAddSelection;
    onClose: () => void;
    onAdded?: OpenMcpAddModalParams['onAdded'];
    continuationId?: string;
    children: (state: StoreMcpListingState) => React.ReactNode;
}>): React.ReactNode {
    const params = React.useMemo<OpenMcpAddModalParams>(() => ({ initialSelection: props.selection,
        sourceId: props.selection.sourceId, onAdded: props.onAdded, continuationId: props.continuationId }),
    [props.selection.sourceId, props.selection.itemId, props.selection.version, props.onAdded, props.continuationId]);
    return <McpAddController params={params} onClose={props.onClose}>
        {(config, resolving) => props.children({ config, resolving, item: config?.catalog.items.find((item): item is RegistryCatalogItemSummary =>
            !isMcpAddSuggestion(item) && item.sourceId === props.selection.sourceId && item.itemId === props.selection.itemId
            && (!props.selection.version || item.version === props.selection.version)) ?? null })}
    </McpAddController>;
}
