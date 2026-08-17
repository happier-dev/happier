import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';

export type AgentInputHostControlId =
    | 'engine'
    | 'mode'
    | 'goal'
    | 'permission'
    | 'actionMenu'
    | 'profile'
    | 'env'
    | 'server'
    | 'connectedServices'
    | 'mcp'
    | 'checkout'
    | 'automation'
    | 'stop'
    | 'recipient'
    | 'delivery'
    | 'attachments'
    | 'linkedFiles'
    | 'files'
    | 'reviewComments'
    | 'storage'
    | 'windowsRemoteSessionMode'
    | 'providerOption'
    | 'shortcuts'
    | 'machine'
    | 'path'
    | 'resume';

/**
 * Plugin controls enter the incumbent ordering/overflow owner only after the
 * contribution catalog has admitted and normalized their qualified ID. The
 * resolver preserves the producer's normalized order rather than becoming a
 * second plugin-control catalog.
 */
export type AgentInputPluginControlId = `plugin:${string}`;

export type AgentInputControlId = AgentInputHostControlId | AgentInputPluginControlId;

export function isAgentInputPluginControlId(controlId: AgentInputControlId | string): controlId is AgentInputPluginControlId {
    return controlId.startsWith('plugin:') && controlId.length > 'plugin:'.length;
}

export type AgentInputControlLine = 'primary' | 'secondary';

export type AgentInputControlDescriptor = Readonly<{
    id: AgentInputControlId;
    line: AgentInputControlLine;
}>;

export type AgentInputResolvedControlLines = Readonly<{
    layout: AgentInputActionBarLayout;
    primary: readonly AgentInputControlId[];
    secondary: readonly AgentInputControlId[];
    collapsed: readonly AgentInputControlId[];
}>;
