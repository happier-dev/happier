export function isSessionGoalEditingAvailable(params: Readonly<{
    providerSupportsEditableGoals: boolean;
    goalsFeatureEnabled: boolean;
}>): boolean {
    return params.providerSupportsEditableGoals && params.goalsFeatureEnabled;
}
