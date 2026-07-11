export function isSessionGoalEditingAvailable(params: Readonly<{
    providerSupportsEditableGoals: boolean;
    goalsFeatureEnabled: boolean;
    /**
     * Whether the viewer can write to this session (owner, edit, or admin access). View-only
     * (`accessLevel === 'view'`) sessions may DISPLAY goal/work-state but must never expose enabled
     * goal mutation controls, so goal editability requires write access (G5/D4). The single
     * `canEditSessionGoals` gate computed from this drives both the above-input work-state badge
     * popover and the AgentInput goal chip, so read-only sessions cannot mutate goals via either.
     */
    hasWriteAccess: boolean;
}>): boolean {
    return params.providerSupportsEditableGoals
        && params.goalsFeatureEnabled
        && params.hasWriteAccess;
}
