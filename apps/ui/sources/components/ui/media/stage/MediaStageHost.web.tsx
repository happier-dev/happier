import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

const MediaStageContent = retryableLazy(async () => ({
    default: (await import('./MediaStage')).MediaStage,
}));

export function MediaStage(props: React.ComponentProps<typeof MediaStageContent>) {
    return (
        <React.Suspense fallback={<PaneLoadingFallback />}>
            <MediaStageContent {...props} />
        </React.Suspense>
    );
}
