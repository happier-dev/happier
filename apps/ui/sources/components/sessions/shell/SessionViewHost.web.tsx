import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { SessionViewRouteLoading } from './SessionViewRouteLoading';

// One demand edge keeps the transcript out of the shared initial graph even when
// routes, cockpit panes, onboarding and plugin widgets all present sessions.
const SessionViewContent = retryableLazy(async () => ({
    default: (await import('./SessionView')).SessionView,
}));

export const SessionView = React.memo((props: React.ComponentProps<typeof SessionViewContent>) => (
    <React.Suspense fallback={props.presentation?.kind === 'embedded' ? <PaneLoadingFallback /> : <SessionViewRouteLoading />}>
        <SessionViewContent {...props} />
    </React.Suspense>
));
