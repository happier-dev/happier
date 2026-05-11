import { Dimensions, Platform } from 'react-native';
import {
    resolveViewportMinEdgePx,
    VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
} from '@/utils/platform/viewportClass';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveContentMaxWidthForMode } from './contentWidthMode';

function readPreferredContentWidthMode(): unknown {
    return getStorage().getState().localSettings.uiContentWidthMode;
}

function resolveConstrainedMaxWidth(params: Readonly<{
    variant: 'header' | 'content';
    preferredContentWidthMode?: unknown;
}>): number {
    const { width, height } = Dimensions.get('window');

    if (Platform.OS !== 'web') {
        const minEdge = resolveViewportMinEdgePx({ width, height });
        // On phones, avoid constraining headers/content to desktop caps.
        if (minEdge < VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin) return Math.max(width, height);
    }

    return resolveContentMaxWidthForMode(params.preferredContentWidthMode ?? readPreferredContentWidthMode());
}

export const layout = {
    get maxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'content' });
    },
    get headerMaxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'header' });
    },
};

export function useLayoutMaxWidth(): number {
    const preferredContentWidthMode = useLocalSetting('uiContentWidthMode');
    return resolveConstrainedMaxWidth({ variant: 'content', preferredContentWidthMode });
}
