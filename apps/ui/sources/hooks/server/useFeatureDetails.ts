import * as React from 'react';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';

type FeatureDetailsParams<T> = Readonly<{
    fallback: T;
    select: (features: ServerFeatures) => T;
}>;

export function useFeatureDetails<T>(params: FeatureDetailsParams<T>): T {
    const snapshot = useServerFeaturesRuntimeSnapshot();

    return React.useMemo(() => {
        if (snapshot.status !== 'ready') {
            return params.fallback;
        }
        return params.select(snapshot.features);
    }, [params, snapshot]);
}
