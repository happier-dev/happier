import { Dimensions, Platform } from 'react-native';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isTauriDesktop } from '@/utils/platform/tauri';
import {
    CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS,
    resolveViewportClass,
    resolveViewportMinEdgePx,
    VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
} from '@/utils/platform/viewportClass';

function resolveConstrainedMaxWidth(params: Readonly<{ variant: 'header' | 'content' }>): number {
    if (isRunningOnMac() || isTauriDesktop()) {
        if (params.variant === 'header') return Number.POSITIVE_INFINITY;
        return CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.wide;
    }

    const { width, height } = Dimensions.get('window');

    if (Platform.OS !== 'web') {
        const minEdge = resolveViewportMinEdgePx({ width, height });
        // On phones, avoid constraining headers/content to desktop caps.
        if (minEdge < VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin) return Math.max(width, height);
    }

    const viewportClass = resolveViewportClass({ width, height });
    return CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS[viewportClass];
}

export const layout = {
    get maxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'content' });
    },
    get headerMaxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'header' });
    },
};
