import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

// The app shell carries window metadata; only an addressed detached pane needs its body.
const Content = retryableLazy(async () => ({
    default: (await import('./PaneTabDestination')).PaneTabDestination,
}));

export const PaneTabDestination = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={<PaneLoadingFallback />}>
        <Content {...props} />
    </React.Suspense>
));
