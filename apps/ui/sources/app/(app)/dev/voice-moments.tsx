import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { VoiceMomentsSpecimen } from '@/components/dev/voiceMoments/VoiceMomentsSpecimen';

/** Dev-only: Voice moments at fixed states. `?frame=N1|END|POSTEND|C1|CX`; no Voice transport starts. */
export default function VoiceMomentsDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <VoiceMomentsSpecimen frame={typeof params.frame === 'string' ? params.frame : 'C1'} />
        </>
    );
}
