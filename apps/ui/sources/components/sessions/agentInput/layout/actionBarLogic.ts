export type AgentInputActionBarLayout = 'wrap' | 'scroll';

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
    _actionBarLayout: AgentInputActionBarLayout,
    hasSecondaryControls: boolean,
): boolean {
    return hasSecondaryControls;
}

/**
 * The chip rails' physical flow (P3 §3.4: flow only, never membership). An explicit choice wins. Auto reads as
 * 0.2 did and as the owner asked (2026-10-30): one scrolling rail per row on the web and on phones, so a new
 * session keeps two rails and a session one, however many chips it carries; wide native screens wrap.
 */
export function resolveAgentInputActionBarLayout(params: Readonly<{
    configuredLayout: AgentInputActionBarLayout | 'auto' | null | undefined;
    /**
     * What the host's own width asks for when the person left the setting on auto: a composer inside a
     * narrow card (a Workflow step) wraps its chips instead of clipping them on a scrolling rail.
     */
    hostLayout?: AgentInputActionBarLayout;
    platform: string;
    isMobileLayout: boolean;
}>): AgentInputActionBarLayout {
    if (params.configuredLayout === 'wrap' || params.configuredLayout === 'scroll') return params.configuredLayout;
    if (params.hostLayout !== undefined) return params.hostLayout;
    if (params.platform === 'web') return 'scroll';
    return params.isMobileLayout ? 'scroll' : 'wrap';
}
