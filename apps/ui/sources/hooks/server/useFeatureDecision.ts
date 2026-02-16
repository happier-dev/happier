import * as React from 'react';
import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';

import { useSettings } from '@/sync/domains/state/storage';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    useServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';

export function useFeatureDecision(featureId: FeatureId): FeatureDecision | null {
    const settings = useSettings();
    const snapshot = useServerFeaturesRuntimeSnapshot();

    return React.useMemo(
        () =>
            resolveRuntimeFeatureDecisionFromSnapshot({
                featureId,
                settings,
                snapshot,
            }),
        [featureId, settings, snapshot],
    );
}
