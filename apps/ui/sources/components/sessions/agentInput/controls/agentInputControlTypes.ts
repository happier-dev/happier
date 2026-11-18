import type { AgentInputActionBarLayout } from '@/components/sessions/agentInput/layout/actionBarLogic';
import type { IconName } from '@/components/ui/icons/Icon';
import type { NavigationDefaultPlacement, NavigationPlacement } from '@/sync/domains/settings/navigationPlacement';

export type AgentInputPlacementContext = 'session' | 'newSession' | 'workflow' | 'discussion';

/** The + menu section a control's row sits in: `add` (put something into the message) leads, above a hairline. */
export type AgentInputControlMenuGroup = 'add' | 'controls';

export type AgentInputControlMenuMetadata = Readonly<{
    /** Used only when the action has neither a current value nor an authored subtitle. */
    description?: string;
    /** The admitted owner opens a detail picker/popover, rather than executing an operation. */
    disclosure?: boolean;
    /** The control's one + menu group; undeclared is `controls`. */
    group?: AgentInputControlMenuGroup;
}>;

export type AgentInputControlPlacement = Readonly<{
    id: string;
    title: string;
    icon?: IconName;
    menu?: AgentInputControlMenuMetadata;
    /** `auto` rides the row while the control holds something (`hasContent`), and waits in + otherwise. */
    defaultPlacement?: NavigationDefaultPlacement;
    hasContent?: boolean;
    pending?: boolean;
}>;

export type AgentInputPlacementDescriptor = Readonly<{
    id: string;
    controlId: AgentInputControlId;
    title: string;
    icon?: IconName;
    menu?: AgentInputControlMenuMetadata;
    line: AgentInputControlLine;
    slot: 'chip' | 'fieldAccessory';
    defaultPlacement: NavigationDefaultPlacement;
    hasContent?: boolean;
    allowedPlacements?: readonly NavigationPlacement[];
    pending: boolean;
}>;

export type AgentInputHostControlId =
    | 'workflow'
    | 'workflowInputs'
    | 'workflowRoles'
    | 'workflowTargets'
    | 'engine'
    | 'mode'
    | 'goal'
    | 'permission'
    | 'actionMenu'
    | 'profile'
    | 'env'
    | 'server'
    | 'connectedServices'
    | 'capabilities'
    | 'checkout'
    | 'organization'
    | 'tags'
    | 'automation'
    | 'stop'
    | 'sessionAccess'
    | 'recipient'
    | 'delivery'
    | 'attachments'
    | 'linkedFiles'
    | 'files'
    | 'reviewComments'
    | 'storage'
    | 'approvalProfile'
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
    layout?: AgentInputActionBarLayout;
    controls: readonly AgentInputPlacementDescriptor[];
    primary: readonly string[];
    secondary: readonly string[];
    /** Effective overflow, retained at the existing + menu boundary. */
    collapsed: readonly string[];
    accessories: readonly string[];
    hidden: readonly string[];
    effectivePlacements: Readonly<Record<string, NavigationPlacement>>;
}>;
