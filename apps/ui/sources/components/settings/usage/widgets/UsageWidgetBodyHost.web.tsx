import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

// Keep the widget catalog lightweight until an actual Usage occurrence mounts.
const Content = retryableLazy(async () => ({
    default: (await import('./UsageWidgetBody')).UsageWidgetBody,
}));

export const UsageWidgetBody = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={<PaneLoadingFallback />}>
        <Content {...props} />
    </React.Suspense>
));
