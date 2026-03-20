import * as React from 'react';

import type { AgentInputControlId } from './agentInputControlTypes';
import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';

type ControlNodesById = Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>>;

export function resolveRenderedAgentInputControls(params: Readonly<{
    layout: 'wrap' | 'scroll' | 'collapsed';
    coreControlNodesById: ControlNodesById;
    extraControlNodesById: ControlNodesById;
    extraChips: readonly React.ReactNode[];
}>): Readonly<{
    chips: readonly React.ReactNode[];
    secondaryLeadingControls: readonly React.ReactNode[];
}> {
    const controlNodesById: ControlNodesById = {
        ...params.coreControlNodesById,
        ...params.extraControlNodesById,
    };

    const controlIds = Object.entries(controlNodesById)
        .filter(([, nodes]) => (nodes?.length ?? 0) > 0)
        .map(([controlId]) => controlId as AgentInputControlId);

    const controlLines = resolveAgentInputControlLines({
        layout: params.layout,
        controlIds,
    });

    const resolveControlNodes = (ids: readonly AgentInputControlId[]) =>
        ids.flatMap((controlId) => controlNodesById[controlId] ?? []);

    const secondaryLeadingControls = resolveControlNodes(
        controlLines.secondary.filter((controlId) => controlId !== 'path' && controlId !== 'resume'),
    );

    const chips = params.layout === 'collapsed'
        ? resolveControlNodes(controlLines.collapsed).filter(Boolean)
        : [
            ...resolveControlNodes(controlLines.primary),
            ...params.extraChips,
        ].filter(Boolean);

    return {
        chips,
        secondaryLeadingControls,
    };
}
