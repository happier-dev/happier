export type UiDeploymentFreshnessState = Readonly<{
    baselineId: string | null;
    updateAvailable: boolean;
}>;

const OPAQUE_DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function normalizeUiDeploymentId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return OPAQUE_DEPLOYMENT_ID_PATTERN.test(normalized) ? normalized : null;
}

export function reduceUiDeploymentFreshness(
    state: UiDeploymentFreshnessState,
    observedId: unknown,
): UiDeploymentFreshnessState {
    const currentId = normalizeUiDeploymentId(observedId);
    if (!currentId || state.updateAvailable) return state;
    if (!state.baselineId) {
        return { baselineId: currentId, updateAvailable: false };
    }
    if (state.baselineId === currentId) return state;
    return { baselineId: state.baselineId, updateAvailable: true };
}
