import type { FeatureId } from '@happier-dev/protocol';

import { useFeatureDecision } from './useFeatureDecision';

export function useFeatureEnabled(featureId: FeatureId): boolean {
    const decision = useFeatureDecision(featureId);
    return decision?.state === 'enabled';
}
