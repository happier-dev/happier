import * as React from 'react';
import { View } from 'react-native';

import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { t } from '@/text';

/**
 * Shared older-page FAILURE affordance, rendered by ChatList and ChainTranscriptList in
 * the same overlay slot as {@link
 * '@/components/sessions/transcript/OlderLoadProgressOverlay'.OlderLoadProgressOverlay}
 * and driven by `useTranscriptOlderPagination`'s `loadFailed` state.
 *
 * Its Retry re-issues the FAILED OLDER READ from the retained cursor. It is deliberately
 * not the session transcript-load banner, whose Retry refreshes the transcript TAIL and
 * would leave the older cursor exactly where it failed.
 */
export const OlderLoadRetryOverlay = React.memo(function OlderLoadRetryOverlay(props: Readonly<{
    onRetry: () => void;
}>) {
    return (
        <View
            testID="transcript-older-load-retry-overlay"
            // `box-none` so the banner stays pressable while the surrounding overlay area
            // keeps passing scroll gestures through to the list underneath.
            pointerEvents="box-none"
            style={{
                alignItems: 'center',
                left: 0,
                paddingHorizontal: 8,
                position: 'absolute',
                right: 0,
                top: TRANSCRIPT_TOP_GUTTER_PX,
                zIndex: 2,
            }}
        >
            <View style={{ width: '100%', maxWidth: 560 }}>
                <WarningActionBanner
                    testID="transcript.olderLoad.failed"
                    title={t('session.transcript.olderLoadFailedTitle')}
                    body={t('session.transcript.olderLoadFailedBody')}
                    actionLabel={t('common.retry')}
                    actionAccessibilityLabel={t('common.retry')}
                    actionTestID="transcript.olderLoad.failed.retry"
                    onActionPress={props.onRetry}
                />
            </View>
        </View>
    );
});
