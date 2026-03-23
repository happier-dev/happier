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
    extraChipAnchorRefsByKey: Readonly<Record<string, React.RefObject<any>>>;
}> {
    const extraControlNodesById: Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>> = {};
    const extraChips: React.ReactNode[] = [];
    const extraChipAnchorRefsByKey: Record<string, React.RefObject<any>> = {};

    for (const chip of params.chips ?? []) {
        const chipAnchorRef = React.createRef<any>();
        extraChipAnchorRefsByKey[chip.key] = chipAnchorRef;
        const renderContext = chip.labelPolicy === 'auto-hide'
            ? { ...params.autoHideRenderContext, chipAnchorRef }
            : { ...params.renderContext, chipAnchorRef };
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
        extraChipAnchorRefsByKey,
    };
}
