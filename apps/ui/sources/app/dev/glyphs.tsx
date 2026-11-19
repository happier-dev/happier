import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const GlyphSpecimen = retryableLazy(() => import('@/dev/atmosphere/GlyphSpecimen'));

export default function GlyphDevScreen() {
    if (!isDevRouteEnabled()) return null;
    return <React.Suspense fallback={null}><GlyphSpecimen /></React.Suspense>;
}
