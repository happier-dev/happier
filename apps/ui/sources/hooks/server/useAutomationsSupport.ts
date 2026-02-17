import { useFeatureDecision } from './useFeatureDecision';
import { useFeatureDetails } from './useFeatureDetails';
import type { FeatureScopeParams } from './featureScope';

export type AutomationsSupport = Readonly<{
    enabled: boolean;
    existingSessionTarget: boolean;
}>;

export function useAutomationsSupport(scope?: FeatureScopeParams): AutomationsSupport {
    const decision = useFeatureDecision('automations', scope);
    const existingSessionTarget = useFeatureDetails({
        featureId: 'automations',
        fallback: false,
        scope,
        select: (features) => features.features.automations.existingSessionTarget.enabled === true,
    });

    return {
        enabled: decision?.state === 'enabled',
        existingSessionTarget,
    };
}
