import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * A pane, cockpit or details surface whose code or first data has not arrived yet (a `Suspense`
 * fallback). It is the shared state composition's loading state, so it takes its container's size and,
 * when the wait runs long, says so ("Still waiting · 12 s") instead of spinning silently.
 */
export const PaneLoadingFallback = React.memo((props: Readonly<{ testID?: string;
    /** What is opening, when the host knows it ("Opening Price point…"); otherwise a quiet "Loading…". */
    title?: string }>) => (
    <SurfaceStateCard testID={props.testID} kind="loading" title={props.title ?? t('common.loading')} accessibilitySemantics="status" />
));
