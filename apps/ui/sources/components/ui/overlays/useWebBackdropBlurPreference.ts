import * as React from 'react';
import { Platform } from 'react-native';

import { useLocalSetting } from '@/sync/store/hooks';

const WEB_BACKDROP_DATASET_KEY = 'happyBackdropBlur';

export function useWebBackdropBlurPreference(): void {
    const enabled = useLocalSetting('uiBackdropBlurEnabled') !== false;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        const root = document.documentElement;
        const dataset = root?.dataset;
        if (!dataset) return;
        const nextValue = enabled ? 'on' : 'off';
        const previousValue = dataset[WEB_BACKDROP_DATASET_KEY];

        dataset[WEB_BACKDROP_DATASET_KEY] = nextValue;

        return () => {
            if (dataset[WEB_BACKDROP_DATASET_KEY] !== nextValue) return;
            if (previousValue == null) {
                delete dataset[WEB_BACKDROP_DATASET_KEY];
                return;
            }
            dataset[WEB_BACKDROP_DATASET_KEY] = previousValue;
        };
    }, [enabled]);
}
