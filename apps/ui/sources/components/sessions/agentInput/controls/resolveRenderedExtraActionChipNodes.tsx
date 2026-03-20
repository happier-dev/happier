import * as React from 'react';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '../agentInputContracts';
import type { AgentInputControlId } from './agentInputControlTypes';

export function resolveRenderedExtraActionChipNodes(params: Readonly<{
    chips?: readonly AgentInputExtraActionChip[];
    renderContext: AgentInputExtraActionChipRenderContext;
    autoHideRenderContext: AgentInputExtraActionChipRenderContext;
}>): Readonly<{
    extraChips: readonly React.ReactNode[];
    extraControlNodesById: Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>>;
}> {
    const extraControlNodesById: Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>> = {};
    const extraChips: React.ReactNode[] = [];

    for (const chip of params.chips ?? []) {
        const renderContext = chip.labelPolicy === 'auto-hide'
            ? params.autoHideRenderContext
            : params.renderContext;
        const node = (
            <React.Fragment key={chip.key}>
                {chip.render(renderContext)}
            </React.Fragment>
        );

        if (!chip.controlId) {
            extraChips.push(node);
            continue;
        }

        extraControlNodesById[chip.controlId] = [
            ...(extraControlNodesById[chip.controlId] ?? []),
            node,
        ];
    }

    return {
        extraChips,
        extraControlNodesById,
    };
}
