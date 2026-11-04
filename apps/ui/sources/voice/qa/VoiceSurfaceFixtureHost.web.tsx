import * as React from 'react';

import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const Content = retryableLazy(async () => ({
    default: (await import('@/dev/testkit/harness/useVoiceSurfaceE2eFixtureComposition')).VoiceSurfaceFixtureHost,
}));

export function VoiceSurfaceFixtureHost(props: Readonly<{ enabled: boolean }>) {
    if (!props.enabled) return null;
    return <React.Suspense fallback={null}><Content {...props} /></React.Suspense>;
}
