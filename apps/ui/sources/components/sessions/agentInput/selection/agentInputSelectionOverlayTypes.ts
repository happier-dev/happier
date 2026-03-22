import type { AgentInputPopoverAnchor } from '../agentInputContracts';

export type AgentInputSelectionOverlayId =
    | 'agent'
    | 'machine'
    | 'sessionMode'
    | 'permission'
    | 'path'
    | 'resume'
    | 'profile'
    | 'envVars'
    | 'collapsedExtra';

type AgentInputBaseSelectionOverlayState = Readonly<{
    anchor: AgentInputPopoverAnchor;
}>;

export type AgentInputSelectionOverlayState =
    | (AgentInputBaseSelectionOverlayState & Readonly<{
        id: Exclude<AgentInputSelectionOverlayId, 'collapsedExtra'>;
    }>)
    | (AgentInputBaseSelectionOverlayState & Readonly<{
        id: 'collapsedExtra';
        chipKey: string;
    }>);
