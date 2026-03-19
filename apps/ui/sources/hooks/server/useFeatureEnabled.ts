import type { FeatureId } from '@happier-dev/protocol';

import type { FeatureDecisionScopeParams } from './useFeatureDecision';
import { useFeatureDecision } from './useFeatureDecision';

export function useFeatureEnabled(featureId: FeatureId, scope?: FeatureDecisionScopeParams): boolean {
    const decision = useFeatureDecision(featureId, scope);
    return decision?.state === 'enabled';
}
