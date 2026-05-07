export type AgentInputActionBarLayout = 'wrap' | 'scroll' | 'collapsed';

export type AgentInputActionBarActionFlags = Readonly<{
    showPermissionChip: boolean;
    hasProfile: boolean;
    hasEnvVars: boolean;
    hasAgent: boolean;
    hasRecipient: boolean;
    hasDelivery: boolean;
    hasExtraActionChips: boolean;
    hasMachine: boolean;
    hasPath: boolean;
    hasResume: boolean;
    hasFiles: boolean;
    hasStop: boolean;
}>;

export function getHasAnyAgentInputActions(flags: AgentInputActionBarActionFlags): boolean {
    return Boolean(
        flags.showPermissionChip ||
        flags.hasProfile ||
        flags.hasEnvVars ||
        flags.hasAgent ||
        flags.hasRecipient ||
        flags.hasDelivery ||
        flags.hasExtraActionChips ||
        flags.hasMachine ||
        flags.hasPath ||
        flags.hasResume ||
        flags.hasFiles ||
        flags.hasStop
    );
}

export function shouldShowSecondaryControlRow(
    actionBarLayout: AgentInputActionBarLayout,
    hasSecondaryControls: boolean,
): boolean {
    // Secondary controls keep their own row in both "wrap" and "scroll" layouts.
    // Only the "collapsed" layout moves them into the popover menu.
    return actionBarLayout !== 'collapsed' && hasSecondaryControls;
}

export function shouldShowPathAndResumeRow(actionBarLayout: AgentInputActionBarLayout): boolean {
    return shouldShowSecondaryControlRow(actionBarLayout, true);
}
