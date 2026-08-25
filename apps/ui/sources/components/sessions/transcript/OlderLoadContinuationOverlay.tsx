import * as React from 'react';
import { View } from 'react-native';

import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
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
        <View
            testID="transcript-older-load-continuation-overlay"
            // Keep the mounted continuation control pressable without turning the surrounding
            // overlay into a scroll-gesture sink.
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
                    tone="neutral"
                    testID="transcript.olderLoad.continue"
                    title={t('session.transcript.olderLoadContinueTitle')}
                    body={t('session.transcript.olderLoadContinueBody')}
                    actionLabel={t('session.transcript.olderLoadContinueAction')}
                    actionAccessibilityLabel={t('session.transcript.olderLoadContinueAction')}
                    actionTestID="transcript.olderLoad.continue.action"
                    onActionPress={props.onContinue}
                />
            </View>
        </View>
    );
});
