import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitComposerBottomChromeHeight,
    useReportSessionCockpitFloatingBottomChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { VoicePresenceFloat } from './VoicePresenceFloat';

function MeasuredPhoneIsland() {
    const report = useReportSessionCockpitFloatingBottomChromeHeight(true);
    const setBar = useSessionCockpitBottomChromeHeightSetter();
    const composerInset = useSessionCockpitComposerBottomChromeHeight();
    React.useEffect(() => { setBar(62); }, [setBar]);
    return <>
        <View testID="composer-inset" accessibilityValue={{ now: composerInset }} />
        <VoicePresenceFloat width={358} height={58} restingBottomInset={110} edgeInset={16} minimumTop={56}
            restCentred anchors="island" bottomChromeInset={98} onBottomReservationChange={report} testID="floating-host">
            {() => <View />}
        </VoicePresenceFloat>
    </>;
}

describe('VoicePresenceFloat measured phone reservation', () => {
    it('publishes the actual capsule band instead of its reference height', async () => {
        const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><MeasuredPhoneIsland /></SessionCockpitChromeRegistryProvider>);
        try {
            expect(screen.findByTestId('composer-inset')?.props.accessibilityValue.now).toBe(62);
            await act(async () => { screen.findByTestId('floating-host')?.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); });
            await act(async () => { screen.findByTestId('voice-presence-float-body')?.props.onLayout({ nativeEvent: { layout: { width: 358, height: 70 } } }); });
            expect(screen.findByTestId('composer-inset')?.props.accessibilityValue.now).toBe(144);
            await act(async () => { screen.findByTestId('voice-presence-float-body')?.props.onLayout({ nativeEvent: { layout: { width: 358, height: 94 } } }); });
            expect(screen.findByTestId('composer-inset')?.props.accessibilityValue.now).toBe(168);
        } finally { await screen.unmount(); }
    });
});
