import * as React from 'react';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '../agentInputContracts';
import type { View } from 'react-native';

export function resolveRenderedExtraActionChipNodes(params: Readonly<{
    chips?: readonly AgentInputExtraActionChip[];
    placementIds: readonly string[];
    renderContext: AgentInputExtraActionChipRenderContext;
    autoHideRenderContext: AgentInputExtraActionChipRenderContext;
}>): Readonly<{
    extraControlNodesById: Readonly<Record<string, ReadonlyArray<React.ReactNode>>>;
    extraChipAnchorRefsByKey: Readonly<Record<string, React.RefObject<View | null>>>;
}> {
    const extraControlNodesById: Record<string, ReadonlyArray<React.ReactNode>> = {};
    const extraChipAnchorRefsByKey: Record<string, React.RefObject<View | null>> = {};
    const pinnedIds = new Set(params.placementIds);

    for (const chip of params.chips ?? []) {
        const fixed = chip.controlId === 'actionMenu' || chip.controlId === 'stop';
        const id = fixed ? chip.controlId : chip.placement?.id;
        if (!id || (!fixed && !pinnedIds.has(id))) continue;
        const chipAnchorRef = React.createRef<View>();
        extraChipAnchorRefsByKey[chip.key] = chipAnchorRef;
        const renderContext = chip.labelPolicy === 'auto-hide'
            ? { ...params.autoHideRenderContext, chipAnchorRef }
            : { ...params.renderContext, chipAnchorRef };
        const node = (
            <React.Fragment key={chip.key}>
                {chip.render(renderContext)}
            </React.Fragment>
        );

        extraControlNodesById[id] = [
            ...(extraControlNodesById[id] ?? []),
            node,
        ];
    }

    return {
        extraControlNodesById,
        extraChipAnchorRefsByKey,
    };
}
