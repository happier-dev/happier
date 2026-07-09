export type TargetWindowLiveTailGate = Readonly<{
    allowAutomaticLiveTailFollow: boolean;
    targetWindowActive: boolean;
}>;

export function resolveTargetWindowLiveTailGate(params: Readonly<{
    explicitLiveTailCommand: boolean;
    targetWindowActive: boolean;
}>): TargetWindowLiveTailGate {
    return {
        targetWindowActive: params.targetWindowActive,
        allowAutomaticLiveTailFollow: params.explicitLiveTailCommand || !params.targetWindowActive,
    };
}

export function shouldResetTargetWindowForViewportTransition(params: Readonly<{
    explicitLiveTailIntent: boolean;
    nextRouteKey: string | null;
    nextSessionId: string | null;
    previousRouteKey: string | null;
    previousSessionId: string | null;
}>): boolean {
    if (params.explicitLiveTailIntent) return true;
    if (params.previousSessionId !== params.nextSessionId) return true;
    return params.previousRouteKey !== params.nextRouteKey;
}
