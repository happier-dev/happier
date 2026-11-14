import * as React from 'react';
import { useSessionListViewFilterController } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import { projectSessionListNeedsYou, useActiveRetainedSessionListNeedsYou } from '@/components/sessions/shell/sessionListPaneRetention';
import { useSessionListPaneProjection } from '@/components/sessions/shell/useSessionListPaneProjection';

/** Brief demand reaches the Home list producer even when another column owns navigation. */
export function useVoiceBriefNeedsYou() {
    const displayed = useActiveRetainedSessionListNeedsYou();
    const controller = useSessionListViewFilterController('active');
    const storageKind = controller.sourceAvailable ? controller.displayFilters.source : 'persisted';
    const pane = useSessionListPaneProjection(storageKind, controller, {
        pathname: '/',
        // Reuse an already displayed shelf; no second query consumer is needed.
        sessionListSurfaceDataActive: displayed === null,
    });
    return React.useMemo(() => displayed ?? projectSessionListNeedsYou(pane), [displayed, pane]);
}
