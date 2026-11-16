import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const SimulatorSpecimen = retryableLazy(() => import('@/components/dev/simulator/SimulatorSpecimen'));

/** Static dev-only QA entry for the device viewer's states. `?only=<frame id>` renders one; `?phone=1` the phone width. */
export default function SimulatorDevScreen() {
    const params = useLocalSearchParams<{ only?: string; phone?: string }>();
    if (!isDevRouteEnabled()) return null;
    return (
        <React.Suspense fallback={null}>
            <SimulatorSpecimen only={typeof params.only === 'string' ? params.only : null} phone={params.phone === '1'} />
        </React.Suspense>
    );
}
