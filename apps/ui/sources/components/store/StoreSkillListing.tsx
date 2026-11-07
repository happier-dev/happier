import * as React from 'react';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { SkillAddController, type SkillAddSelection, type OpenSkillAddModalParams } from '@/components/settings/skills/add/openSkillAddModal';

export type StoreSkillListingState = Readonly<{
    config: CapabilityAddModalConfig<RegistryItemSummaryV1> | null;
    item: RegistryItemSummaryV1 | null;
    resolving: boolean;
    requestClose: () => void;
}>;

/** No Skill parser, installer or list loader: use the existing selected-detail controller. */
export function StoreSkillListing(props: Readonly<{
    selection: SkillAddSelection;
    onClose: () => void;
    onAdded?: OpenSkillAddModalParams['onAdded'];
    children: (state: StoreSkillListingState) => React.ReactNode;
}>): React.ReactNode {
    const params = React.useMemo<OpenSkillAddModalParams>(() => ({ initialSelection: props.selection,
        sourceId: props.selection.sourceId, onAdded: props.onAdded }),
    [props.selection.sourceId, props.selection.itemId, props.selection.version, props.onAdded]);
    return <SkillAddController params={params} onClose={props.onClose}>{(config, resolving, requestClose) => props.children({
        config, resolving, requestClose, item: config?.catalog.items.find(item => item.sourceId === props.selection.sourceId
            && item.itemId === props.selection.itemId && (!props.selection.version || item.version === props.selection.version)) ?? null,
    })}</SkillAddController>;
}
