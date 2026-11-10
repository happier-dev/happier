import * as React from 'react';

import { TranscriptTopBannerSlot } from '@/components/sessions/transcript/TranscriptTopBannerSlot';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { t } from '@/text';

/**
 * Explicit continuation for an underfilled transcript whose bounded initial fill retained an
 * older cursor. Unlike the failure overlay, this is a normal reader action: it gives the one
 * existing older-pagination owner a chance to read the next page when short content cannot emit
 * a scroll threshold observation.
 */
export const OlderLoadContinuationOverlay = React.memo(function OlderLoadContinuationOverlay(props: Readonly<{
    onContinue: () => void;
}>) {
    return (
        <TranscriptTopBannerSlot testID="transcript-older-load-continuation-overlay">
            <WarningActionBanner
                tone="neutral"
                testID="transcript.olderLoad.continue"
                floating
                title={t('session.transcript.olderLoadContinueTitle')}
                body={t('session.transcript.olderLoadContinueBody')}
                actionLabel={t('session.transcript.olderLoadContinueAction')}
                actionAccessibilityLabel={t('session.transcript.olderLoadContinueAction')}
                actionTestID="transcript.olderLoad.continue.action"
                onActionPress={props.onContinue}
            />
        </TranscriptTopBannerSlot>
    );
});
