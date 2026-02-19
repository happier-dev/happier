import { useFeatureDecision } from './useFeatureDecision';
import type { FeatureScopeParams } from './featureScope';

export type AutomationsSupport = Readonly<{
    enabled: boolean;
}>;

export function useAutomationsSupport(scope?: FeatureScopeParams): AutomationsSupport {
    const decision = useFeatureDecision('automations', scope);

    return {
        enabled: decision?.state === 'enabled',
    };
}
