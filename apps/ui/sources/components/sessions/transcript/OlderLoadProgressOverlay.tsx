import * as React from 'react';
import { View } from 'react-native';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';

/**
 * Shared user-triggered older-page loading indicator (plan D3): rendered by both
 * ChatList and ChainTranscriptList, driven by `useTranscriptOlderPagination`'s
 * spinner-delayed `isLoadingOlder` state. Overlay-positioned so it never joins
 * the scrollable content geometry.
 */
export const OlderLoadProgressOverlay = React.memo(() => (
    <View
        testID="transcript-older-load-progress-overlay"
        pointerEvents="none"
        style={{
            alignItems: 'center',
            left: 0,
            position: 'absolute',
            right: 0,
            top: TRANSCRIPT_TOP_GUTTER_PX,
            zIndex: 2,
        }}
    >
        <ActivitySpinner size="small" />
    </View>
));
