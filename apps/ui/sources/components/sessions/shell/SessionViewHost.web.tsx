import * as React from 'react';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { SessionViewRouteLoading } from './SessionViewRouteLoading';

// One demand edge keeps the transcript out of the shared initial graph even when
// routes, cockpit panes, onboarding and plugin widgets all present sessions.
const SessionViewContent = retryableLazy(async () => ({
    default: (await import('./SessionView')).SessionView,
}));

/** A Session route starts this chunk with its first read instead of after the destination mounts. */
export function preloadSessionView(): void {
    SessionViewContent.preload();
}

export const SessionView = React.memo((props: React.ComponentProps<typeof SessionViewContent>) => (
    <React.Suspense fallback={props.presentation?.kind === 'embedded' ? <PaneLoadingFallback /> : (
        <SessionViewRouteLoading initialLoading serverId={props.routeHydrationState?.serverId ?? props.routeServerId ?? null} />
    )}>
        <SessionViewContent {...props} />
    </React.Suspense>
));
