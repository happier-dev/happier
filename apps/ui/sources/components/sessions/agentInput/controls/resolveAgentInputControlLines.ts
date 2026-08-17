import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';

import { AGENT_INPUT_CONTROL_REGISTRY, findAgentInputControlDescriptor } from './agentInputControlRegistry';
import {
    isAgentInputPluginControlId,
    type AgentInputControlId,
    type AgentInputResolvedControlLines,
} from './agentInputControlTypes';

/**
 * The host registry owns host-control placement. Plugin controls have already
 * been admitted and normalized by their catalog producer, so retain their
 * supplied order at the one plugin insertion point instead of silently
 * discarding or independently re-sorting them here.
 */
export function sortControlIdsInRegistryOrder(controlIds: readonly AgentInputControlId[]): AgentInputControlId[] {
    const requested = new Set(controlIds);
    const hostControlIds = AGENT_INPUT_CONTROL_REGISTRY
        .map((control) => control.id)
        .filter((controlId) => requested.has(controlId));
    const seenPluginControlIds = new Set<AgentInputControlId>();
    const pluginControlIds = controlIds.filter((controlId) => {
        if (!isAgentInputPluginControlId(controlId) || seenPluginControlIds.has(controlId)) return false;
        seenPluginControlIds.add(controlId);
        return true;
    });

    return [...hostControlIds, ...pluginControlIds];
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
        if (isAgentInputPluginControlId(controlId)) {
            primary.push(controlId);
            continue;
        }
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
