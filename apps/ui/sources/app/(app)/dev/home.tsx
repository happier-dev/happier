import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { HomeHubSpecimen } from '@/components/dev/home/HomeHubSpecimen';
import { isVoiceSetupFixtureFrame } from '@/components/dev/home/voiceSetupFixtures';

/** Dev-only: the app Home at lab data (lab `hindex` I1; `?machines=1` for I3; `?firstRun=1` for hjourneys J1 with K1; `?voice=SA|SB|SC|SD` for voice-moments Set up voice; `?brief=1` for B1). Never reads or writes the Account's Home layout. */
export default function HomeDevScreen() {
    const params = useLocalSearchParams<{ machines?: string; firstRun?: string; voice?: string; brief?: string }>();
    return <HomeHubSpecimen machines={params.machines === '1'} firstRun={params.firstRun === '1'} voice={isVoiceSetupFixtureFrame(params.voice) ? params.voice : null} brief={params.brief === '1'} />;
}
