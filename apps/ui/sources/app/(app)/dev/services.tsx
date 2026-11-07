import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ServicesSpecimen } from '@/components/dev/services/ServicesSpecimen';

/**
 * Dev-only: the session's Local services pane with the lab's data. `?phone=1` renders the phone width;
 * `?scan=denied` shows the scan warning for a Project root the daemon cannot read; `?remote=1` is
 * the pane seen from a device with no private route to the Machine's previews (services lab R).
 */
export default function ServicesDevScreen() {
    const params = useLocalSearchParams<{ phone?: string; scan?: string; remote?: string }>();
    return <ServicesSpecimen phone={params.phone === '1'} {...(params.scan === 'denied' ? { scan: 'denied' as const } : {})}
        remote={params.remote === '1'} />;
}
