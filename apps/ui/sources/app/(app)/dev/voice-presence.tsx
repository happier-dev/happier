import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { VoicePresenceSpecimen } from '@/components/dev/voicePresence/VoicePresenceSpecimen';
import { isVoicePresenceFixtureState } from '@/components/dev/voicePresence/voicePresenceFixtures';

/** Dev-only: the Voice presence primitives and containers at fixed states (lab `voice-presence`). `?frame=M|K|ST|…`. */
export default function VoicePresenceDevScreen() {
    const params = useLocalSearchParams<{ frame?: string; state?: string }>();
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <VoicePresenceSpecimen frame={typeof params.frame === 'string' ? params.frame : 'M'} state={params.state === 'all' ? 'all' : isVoicePresenceFixtureState(params.state) ? params.state : undefined} />
        </>
    );
}
