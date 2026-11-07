import * as React from 'react';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { AgentAddController, type OpenAgentAddModalParams } from '@/components/settings/agents/add/agentAddModalConfig';
import type { AgentAddRow } from '@/components/settings/agents/add/agentAddRows';
import { useAgentAddContinuations } from '@/components/settings/agents/collection/AgentCollectionList';

export type StoreAgentListingState = Readonly<{
    config: CapabilityAddModalConfig<AgentAddRow>;
    item: AgentAddRow | null;
    resolving: boolean;
}>;
const ignoreAddedPresentation = () => {};

/** The native controller still chooses ACP setup versus Plugin review from the admitted payload. */
export function StoreAgentListing(props: Readonly<{
    selection: NonNullable<OpenAgentAddModalParams['initialSelection']>;
    onClose: () => void;
    children: (state: StoreAgentListingState) => React.ReactNode;
}>): React.ReactNode {
    const continuations = useAgentAddContinuations();
    const params = React.useMemo<OpenAgentAddModalParams>(() => ({ ...continuations, initialSelection: props.selection,
        sourceId: props.selection.sourceId }),
    [continuations, props.selection.sourceId, props.selection.itemId, props.selection.version]);
    return <AgentAddController params={params} onClose={props.onClose} onAddedStay={ignoreAddedPresentation}>
        {(config, resolving) => props.children({ config, resolving,
            item: config.catalog.items.find(item => item.summary.sourceId === props.selection.sourceId
                && item.summary.itemId === props.selection.itemId
                && (!props.selection.version || item.summary.version === props.selection.version)) ?? null,
        })}
    </AgentAddController>;
}
