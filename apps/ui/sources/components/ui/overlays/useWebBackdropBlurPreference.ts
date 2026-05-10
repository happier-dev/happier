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
        const nextValue = enabled ? 'on' : 'off';
        const previousValue = root.dataset[WEB_BACKDROP_DATASET_KEY];

        root.dataset[WEB_BACKDROP_DATASET_KEY] = nextValue;

        return () => {
            if (root.dataset[WEB_BACKDROP_DATASET_KEY] !== nextValue) return;
            if (previousValue == null) {
                delete root.dataset[WEB_BACKDROP_DATASET_KEY];
                return;
            }
            root.dataset[WEB_BACKDROP_DATASET_KEY] = previousValue;
        };
    }, [enabled]);
}
