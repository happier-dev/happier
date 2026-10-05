import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ConnectedServicesSpecimen } from '@/components/dev/connectedServices/ConnectedServicesSpecimen';
import { useDeviceType } from '@/utils/platform/responsive';

/** Dev-only: the Connected services surfaces with fixture accounts (lab `csvc`). `?frame=<id>`. */
export default function ConnectedServicesDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    const frame = typeof params.frame === 'string' ? params.frame : null;
    const phone = useDeviceType() === 'phone';
    const entityFrame = frame !== null && ['D1p', 'D2p', 'PLp', 'PLap'].includes(frame);
    return <>
        {/* Entity actions reach screen and parent in the real hidden-child settings stack.
            This detached fixture keeps only its parent header visible on phones, too. */}
        <Stack.Screen options={{ headerShown: !(phone && entityFrame) }} />
        <ConnectedServicesSpecimen frame={frame} />
    </>;
}
