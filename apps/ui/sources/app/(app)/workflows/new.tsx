import * as React from 'react';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { WorkflowEditorHostScreen } from '@/components/workflows/screens/WorkflowEditorHostScreen';

/** Thin neutral create route; the host owns draft identity and the explicit effects. */
export function NewWorkflowRoute(): React.ReactElement {
    const params = useLocalSearchParams<{ importJson?: string; reviewedRunSeedId?: string; newSessionDraftSeedId?: string; triggerWorkflowSeedId?: string; definitionDraftSeedId?: string; example?: string; builtin?: string }>();
    // Only the opaque seed handle travels in the URL; the reviewed definition,
    // placement and accepted inputs stay in the temporary-data store.
    const reviewedRunSeedId = typeof params.reviewedRunSeedId === 'string' && params.reviewedRunSeedId.length > 0
        ? params.reviewedRunSeedId
        : undefined;
    // New Session's "Make this prompt a workflow…" hands its composed prompt over the same way.
    const newSessionDraftSeedId = typeof params.newSessionDraftSeedId === 'string' && params.newSessionDraftSeedId.length > 0
        ? params.newSessionDraftSeedId
        : undefined;
    const triggerWorkflowSeedId = typeof params.triggerWorkflowSeedId === 'string' && params.triggerWorkflowSeedId.length > 0
        ? params.triggerWorkflowSeedId
        : undefined;
    return <WorkflowsGate><WorkflowEditorHostScreen source={{
        kind: 'new',
        ...(typeof params.example === 'string' ? { exampleKey: params.example } : {}),
        ...(typeof params.builtin === 'string' ? { builtinId: params.builtin } : {}),
        ...(params.importJson === '1' ? { requestImport: true } : {}),
        ...(reviewedRunSeedId === undefined ? {} : { reviewedRunSeedId }),
        ...(newSessionDraftSeedId === undefined ? {} : { newSessionDraftSeedId }),
        ...(triggerWorkflowSeedId === undefined ? {} : { triggerWorkflowSeedId }),
        ...(typeof params.definitionDraftSeedId === 'string' ? { definitionDraftSeedId: params.definitionDraftSeedId } : {}),
    }} /></WorkflowsGate>;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { NewWorkflowRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewWorkflowRoute} />; }
