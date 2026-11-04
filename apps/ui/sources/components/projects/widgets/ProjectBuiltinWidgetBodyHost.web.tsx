import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

// A Home widget dispatcher must not load Project editors before a Project widget is presented.
const Content = retryableLazy(async () => ({
    default: (await import('./ProjectBuiltinWidgetBody')).ProjectBuiltinWidgetBody,
}));

export const ProjectBuiltinWidgetBody = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={<PaneLoadingFallback />}>
        <Content {...props} />
    </React.Suspense>
));
