import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const Content = retryableLazy(async () => ({
    default: (await import('./SessionDetailsPanel')).SessionDetailsPanel,
}));

export const SessionDetailsPanel = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={<PaneLoadingFallback />}>
        <Content {...props} />
    </React.Suspense>
));
