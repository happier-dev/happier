import { useEffect, useState, type DependencyList } from 'react';

import { getCachedServerFeatures, getServerFeatures } from '@/sync/apiFeatures';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

export function useServerFeatureValue<T>(params: {
    initial: T;
    deps?: DependencyList;
    select: (features: ServerFeatures | null) => T;
}): T {
    const { initial, deps = [], select } = params;
    const [value, setValue] = useState<T>(() => {
        const cached = getCachedServerFeatures();
        if (!cached) return initial;
        return select(cached);
    });

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const features = await getServerFeatures();
                if (!cancelled) {
                    setValue(select(features));
                }
            } catch {
                if (!cancelled) {
                    setValue(select(null));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, deps);

    return value;
}
