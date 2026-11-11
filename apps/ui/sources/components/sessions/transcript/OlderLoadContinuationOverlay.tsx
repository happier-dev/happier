import * as React from 'react';

import { TranscriptTopBannerSlot } from '@/components/sessions/transcript/TranscriptTopBannerSlot';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { t } from '@/text';

/**
 * The transcript's one "Load older messages" continuation: what is above, and the action that reads the next
 * page. A Session floats it over an underfilled transcript (the overlay below); a Discussion thread leads with
 * it as its first item.
 */
export const OlderLoadContinuationBanner = React.memo(function OlderLoadContinuationBanner(props: Readonly<{
    onContinue: () => void;
    floating?: boolean;
}>) {
    return (
        <WarningActionBanner
            tone="neutral"
            testID="transcript.olderLoad.continue"
            floating={props.floating}
            title={t('session.transcript.olderLoadContinueTitle')}
            body={t('session.transcript.olderLoadContinueBody')}
            actionLabel={t('session.transcript.olderLoadContinueAction')}
            actionAccessibilityLabel={t('session.transcript.olderLoadContinueAction')}
            actionTestID="transcript.olderLoad.continue.action"
            onActionPress={props.onContinue}
        />
    );
});

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
            <OlderLoadContinuationBanner floating onContinue={props.onContinue} />
        </TranscriptTopBannerSlot>
    );
});
