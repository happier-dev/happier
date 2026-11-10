import * as React from 'react';

import { TranscriptTopBannerSlot } from '@/components/sessions/transcript/TranscriptTopBannerSlot';
import { useTranscriptFindActive } from '@/components/sessions/transcript/find/TranscriptFindContext';
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
 *
 * While transcript Find is open its capsule owns the top of the transcript and says the same thing in
 * its note (`TranscriptFindSurface` `olderLoadFailed`), so this banner stands down instead of stacking.
 */
export const OlderLoadRetryOverlay = React.memo(function OlderLoadRetryOverlay(props: Readonly<{
    onRetry: () => void;
}>) {
    if (useTranscriptFindActive()) return null;
    return (
        <TranscriptTopBannerSlot testID="transcript-older-load-retry-overlay">
            <WarningActionBanner
                testID="transcript.olderLoad.failed"
                floating
                title={t('session.transcript.olderLoadFailedTitle')}
                body={t('session.transcript.olderLoadFailedBody')}
                actionLabel={t('common.retry')}
                actionAccessibilityLabel={t('common.retry')}
                actionTestID="transcript.olderLoad.failed.retry"
                onActionPress={props.onRetry}
            />
        </TranscriptTopBannerSlot>
    );
});
