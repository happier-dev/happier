import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowsDestinationIndex } from '@/components/workflows/library/WorkflowsDestinationIndex';

import { WorkflowEventDetailPage } from './WorkflowEventDetail';

/**
 * `/workflows/events`: beside the column (on its Events view) main says what picking an event does; without
 * the column the destination's page opens on Events itself.
 */
export const WorkflowsEventsIndex = React.memo(function WorkflowsEventsIndex() {
    const columnVisible = useAppShellColumn().columnVisible;
    if (!columnVisible) return <WorkflowsDestinationIndex />;
    return <WorkflowsGate surface="destination"><WorkflowEventDetailPage eventKey={null} /></WorkflowsGate>;
});

/** `/workflows/events/<key>`: one observed event, in the main pane or pushed on a phone. */
export const WorkflowsEventDetail = React.memo(function WorkflowsEventDetail() {
    const params = useLocalSearchParams<{ eventKey?: string }>();
    const eventKey = typeof params.eventKey === 'string' && params.eventKey.length > 0 ? params.eventKey : null;
    return <WorkflowsGate surface="destination"><WorkflowEventDetailPage eventKey={eventKey} /></WorkflowsGate>;
});
