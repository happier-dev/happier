import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const SimulatorSpecimen = retryableLazy(() => import('@/components/dev/simulator/SimulatorSpecimen'));

/** Static dev-only QA entry for the device viewer's states. `?only=<frame id>` renders one; `?phone=1` the phone width; `?width=<px>` the pane width (the rail and Tools recompose below 520). */
export default function SimulatorDevScreen() {
    const params = useLocalSearchParams<{ only?: string; phone?: string; width?: string }>();
    const width = typeof params.width === 'string' ? Number(params.width) : NaN;
    if (!isDevRouteEnabled()) return null;
    return (
        <React.Suspense fallback={null}>
            <SimulatorSpecimen only={typeof params.only === 'string' ? params.only : null} phone={params.phone === '1'} width={Number.isFinite(width) && width > 0 ? width : null} />
        </React.Suspense>
    );
}
