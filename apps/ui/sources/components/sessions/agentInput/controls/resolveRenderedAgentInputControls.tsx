import * as React from 'react';

import type { AgentInputControlId } from './agentInputControlTypes';
import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';

type ControlNodesById = Partial<Record<AgentInputControlId, ReadonlyArray<React.ReactNode>>>;

export function resolveRenderedAgentInputControls(params: Readonly<{
    layout: 'wrap' | 'scroll' | 'collapsed';
    coreControlNodesById: ControlNodesById;
    extraControlNodesById: ControlNodesById;
    extraChips: readonly React.ReactNode[];
    singleRow?: boolean;
    /**
     * Collapsed layout only: the controls the host keeps on its bar, in bar order. Everything
     * else is reached from the actions menu (which omits these). Unset: every control shows.
     */
    barControlIds?: readonly AgentInputControlId[];
}>): Readonly<{
    chips: readonly React.ReactNode[];
    secondaryLeadingControls: readonly React.ReactNode[];
    hasPermissionControl: boolean;
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
        singleRow: params.singleRow,
    });

    const resolveControlNodes = (ids: readonly AgentInputControlId[]) =>
        ids.flatMap((controlId) => controlNodesById[controlId] ?? []);

    const secondaryLeadingControls = resolveControlNodes(
        controlLines.secondary.filter((controlId) => controlId !== 'path' && controlId !== 'resume'),
    );

    const chips = params.layout === 'collapsed'
        ? resolveControlNodes(params.barControlIds ?? controlLines.collapsed).filter(Boolean)
        : [
            ...resolveControlNodes(controlLines.primary),
            ...params.extraChips,
        ].filter(Boolean);

    return {
        chips,
        secondaryLeadingControls,
        hasPermissionControl: (params.layout === 'collapsed'
            ? params.barControlIds ?? controlLines.collapsed
            : [...controlLines.primary, ...controlLines.secondary]).includes('permission')
            && (controlNodesById.permission?.length ?? 0) > 0,
    };
}
