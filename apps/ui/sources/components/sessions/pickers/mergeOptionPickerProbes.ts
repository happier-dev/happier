import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';

/**
 * Merge multiple probe states into a single probe surface.
 *
 * This is used when a single refresh affordance should refresh multiple independent
 * sources (e.g. backend detection + model list + config option probes).
 */
export function mergeOptionPickerProbes(
    probes: ReadonlyArray<OptionPickerProbeState | null | undefined>,
): OptionPickerProbeState | undefined {
    const candidates = probes.filter(Boolean) as OptionPickerProbeState[];
    if (candidates.length === 0) return undefined;

    const phase: OptionPickerProbeState['phase'] =
        candidates.some((candidate) => candidate.phase === 'loading')
            ? 'loading'
            : candidates.some((candidate) => candidate.phase === 'refreshing')
                ? 'refreshing'
                : 'idle';

    const refreshFns = candidates
        .map((candidate) => candidate.onRefresh)
        .filter((fn): fn is () => void => typeof fn === 'function');

    const labels = candidates.find((candidate) => (
        candidate.refreshAccessibilityLabel
        || candidate.loadingAccessibilityLabel
        || candidate.refreshingAccessibilityLabel
    )) ?? null;

    const merged: OptionPickerProbeState = {
        phase,
        ...(refreshFns.length > 0
            ? {
                onRefresh: () => {
                    for (const fn of refreshFns) fn();
                },
            }
            : {}),
        ...(labels?.refreshAccessibilityLabel ? { refreshAccessibilityLabel: labels.refreshAccessibilityLabel } : {}),
        ...(labels?.loadingAccessibilityLabel ? { loadingAccessibilityLabel: labels.loadingAccessibilityLabel } : {}),
        ...(labels?.refreshingAccessibilityLabel ? { refreshingAccessibilityLabel: labels.refreshingAccessibilityLabel } : {}),
    };

    // If there's nothing to render, return undefined so consumers don't reserve space.
    if (merged.phase === 'idle' && typeof merged.onRefresh !== 'function') {
        return undefined;
    }

    return merged;
}

