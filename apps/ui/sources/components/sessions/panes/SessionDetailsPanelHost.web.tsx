import * as React from 'react';

import { DestinationBodyLoading } from '@/components/appShell/workspace/DestinationBodyLoading';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const Content = retryableLazy(async () => ({
    default: (await import('./SessionDetailsPanel')).SessionDetailsPanel,
}));

export const SessionDetailsPanel = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={props.presentation === 'screen'
        ? <DestinationBodyLoading holdLaunchCurtain={false} routeServerId={props.routeServerId} />
        : <PaneLoadingFallback />}>
        <Content {...props} />
    </React.Suspense>
));
