import * as React from 'react';
import { Platform } from 'react-native';

const useInsertionEffectSafe: typeof React.useEffect =
    typeof React.useInsertionEffect === 'function'
        ? React.useInsertionEffect
        : React.useLayoutEffect;

export function useWebRevealStyleInsertion(params: Readonly<{
    enabled: boolean;
    injectStyle: () => void;
}>): void {
    useInsertionEffectSafe(() => {
        if (params.enabled !== true) return;
        if (Platform.OS !== 'web') return;
        params.injectStyle();
    }, [params.enabled, params.injectStyle]);
}
