import { useFeatureDecision } from './useFeatureDecision';
import type { FeatureScopeParams } from './featureScope';
import type { FeatureDecision } from '@happier-dev/protocol';

export type AutomationsSupport = Readonly<{
    enabled: boolean;
    loading: boolean;
    discoverable?: boolean;
    blockedBy?: FeatureDecision['blockedBy'] | null;
    blockerCode?: FeatureDecision['blockerCode'] | null;
}>;

export function useAutomationsSupport(scope?: FeatureScopeParams): AutomationsSupport {
    const decision = useFeatureDecision('automations', scope);

    return {
        loading: decision == null,
        enabled: decision?.state === 'enabled',
        discoverable: decision == null || decision?.state === 'enabled' || decision?.blockedBy === 'local_policy',
        blockedBy: decision?.blockedBy ?? null,
        blockerCode: decision?.blockerCode ?? null,
    };
}
