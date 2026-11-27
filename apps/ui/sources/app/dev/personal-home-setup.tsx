import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';

const PersonalHomeSetupSpecimen = retryableLazy(() => import('@/components/dev/personalHome/PersonalHomeSetupSpecimen'));

/** Static dev-only QA entry for the first-run Personal Home setup states, outside authenticated runtime mounts. */
export default function PersonalHomeSetupDevScreen() {
    if (!isDevRouteEnabled()) return null;
    return <React.Suspense fallback={null}><PersonalHomeSetupSpecimen /></React.Suspense>;
}
