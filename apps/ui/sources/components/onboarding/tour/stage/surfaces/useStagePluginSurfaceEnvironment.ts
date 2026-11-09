import * as React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePluginSurfaceEnvironment, type PluginSurfaceEnvironment } from '@/components/plugins/surfaces/pluginSurfaceContext';

import { StagePhoneCaptureContext } from '../StagePhoneCaptureContext';

/** Keep the plugin Screen's existing safe-area owner in screen-only web captures. */
export function useStagePluginSurfaceEnvironment(platform: string): PluginSurfaceEnvironment {
    const environment = usePluginSurfaceEnvironment(platform);
    const phoneCapture = React.useContext(StagePhoneCaptureContext);
    const safeAreaInsets = useSafeAreaInsets();
    // Unistyles' browser metrics are independent of the native metrics supplied
    // by this capture through the canonical React Native safe-area contexts.
    return React.useMemo(() => phoneCapture ? { ...environment, safeAreaInsets } : environment,
        [environment, phoneCapture, safeAreaInsets]);
}
