import * as React from 'react';

import type { AgentInputResolvedControlLines } from './agentInputControlTypes';

type ControlNodesById = Readonly<Partial<Record<string, ReadonlyArray<React.ReactNode>>>>;

export function resolveRenderedAgentInputControls(params: Readonly<{
    resolvedControls: AgentInputResolvedControlLines;
    coreControlNodesById: ControlNodesById;
    extraControlNodesById: ControlNodesById;
}>): Readonly<{
    chips: readonly React.ReactNode[];
    secondaryLeadingControls: readonly React.ReactNode[];
    secondaryTrailingControls: readonly React.ReactNode[];
    hasPermissionControl: boolean;
}> {
    const controlNodesById = {
        ...params.coreControlNodesById,
        ...params.extraControlNodesById,
    };
    const resolveNodes = (ids: readonly string[]) =>
        ids.flatMap((id) => controlNodesById[id] ?? []).filter(Boolean);
    const { primary, secondary } = params.resolvedControls;

    return {
        chips: [
            ...(controlNodesById.actionMenu ?? []),
            ...resolveNodes(primary),
            ...(controlNodesById.stop ?? []),
        ].filter(Boolean),
        secondaryLeadingControls: resolveNodes(secondary),
        secondaryTrailingControls: [],
        hasPermissionControl: [...primary, ...secondary].includes('permission')
            && (controlNodesById.permission?.length ?? 0) > 0,
    };
}
