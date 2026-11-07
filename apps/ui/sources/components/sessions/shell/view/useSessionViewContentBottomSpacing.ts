import { Platform } from 'react-native';

import { layout } from '@/components/ui/layout/layout';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { isRunningOnMac } from '@/utils/platform/platform';

import {
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
    type SessionViewChatBottomSpacing,
} from './resolveSessionViewContentBottomSpacing';

/**
 * How far a Session's composer sits above the bottom of a pane `availableWidthPx` wide: the Session view's
 * own spacing, and the seat Docked New takes so it sits where that composer will be after Send.
 */
export function useSessionViewContentBottomSpacing(availableWidthPx: number, chatBottomSpacing: SessionViewChatBottomSpacing = 'default'): number {
    const safeArea = useChromeSafeAreaInsets();
    return resolveSessionViewContentBottomSpacing({
        chatBottomSpacing,
        // AgentContentView's keyboard scaffold owns the native safe-area inset
        // for the composer and transcript. Keeping the native inset out of this
        // outer layout avoids lifting the composer twice in classic/no-cockpit sessions.
        safeAreaBottomPx: Platform.OS === 'web' ? safeArea.bottom : 0,
        availableWidthPx,
        contentMaxWidthPx: layout.maxWidth,
        defaultContentBottomGapPx: (isRunningOnMac() || Platform.OS === 'web')
            ? SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX
            : 0,
        inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    });
}
