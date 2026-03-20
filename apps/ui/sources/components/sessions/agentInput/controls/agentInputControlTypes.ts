import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';

export type AgentInputControlId =
    | 'engine'
    | 'mode'
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
