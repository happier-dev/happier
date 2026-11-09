import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { HomeHubSpecimen, isHomeCreateFixtureFrame } from '@/components/dev/home/HomeHubSpecimen';
import { isVoiceSetupFixtureFrame } from '@/components/dev/home/voiceSetupFixtures';

/** Dev-only: the app Home at lab data (lab `hindex` I1; `?machines=1` for I3; `?firstRun=1` for hjourneys J1 with K1; `?voice=SA|SB|SC|SD` for voice-moments Set up voice; `?brief=1` for B1; `?showcase=1` for the first-run default widgets in their empty states; with `&firstRun=1&create=A|J|Jd|Ip|Iu` the composer creating a Vercel sandbox from this device (installing, joining, joined) or its Setup interrupted states, lab af-create; `&provider=<pluginId/localId>` creates another bundled provider's machine). Never reads or writes the Account's Home layout. */
export default function HomeDevScreen() {
    const params = useLocalSearchParams<{ machines?: string; firstRun?: string; voice?: string; brief?: string; showcase?: string; create?: string; provider?: string }>();
    return <HomeHubSpecimen machines={params.machines === '1'} firstRun={params.firstRun === '1'} showcase={params.showcase === '1'} voice={isVoiceSetupFixtureFrame(params.voice) ? params.voice : null} brief={params.brief === '1'} create={isHomeCreateFixtureFrame(params.create) ? params.create : null} createProvider={typeof params.provider === 'string' ? params.provider : null} />;
}
