import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';

import { AGENT_INPUT_CONTROL_REGISTRY, findAgentInputControlDescriptor } from './agentInputControlRegistry';
import type { AgentInputControlId, AgentInputResolvedControlLines } from './agentInputControlTypes';

function sortControlIdsInRegistryOrder(controlIds: readonly AgentInputControlId[]): AgentInputControlId[] {
    const requested = new Set(controlIds);
    return AGENT_INPUT_CONTROL_REGISTRY
        .map((control) => control.id)
        .filter((controlId) => requested.has(controlId));
}

export function resolveAgentInputControlLines(params: Readonly<{
    layout: AgentInputActionBarLayout;
    controlIds: readonly AgentInputControlId[];
}>): AgentInputResolvedControlLines {
    const orderedControlIds = sortControlIdsInRegistryOrder(params.controlIds);

    if (params.layout === 'collapsed') {
        return {
            layout: params.layout,
            primary: [],
            secondary: [],
            collapsed: orderedControlIds,
        };
    }

    const primary: AgentInputControlId[] = [];
    const secondary: AgentInputControlId[] = [];
    for (const controlId of orderedControlIds) {
        const descriptor = findAgentInputControlDescriptor(controlId);
        if (!descriptor) continue;
        if (descriptor.line === 'secondary') {
            secondary.push(controlId);
            continue;
        }
        primary.push(controlId);
    }

    return {
        layout: params.layout,
        primary,
        secondary,
        collapsed: [],
    };
}
