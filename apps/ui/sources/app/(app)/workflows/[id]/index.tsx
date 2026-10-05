import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
    WorkflowEditorHostScreen,
    type WorkflowSavedEntryIntent,
} from '@/components/workflows/screens/WorkflowEditorHostScreen';
import { WorkflowMissingDefinitionState } from '@/components/workflows/screens/WorkflowMissingDefinitionState';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows';
import { WorkflowPluginSourceScreen, WorkflowBuiltinSourceScreen } from '@/components/workflows/screens/WorkflowPluginSourceScreen';

/**
 * Saved workflow detail. The row, this detail and the edit route share one
 * Artifact identity, scope and Action owner, so opening from either place shows
 * the same revision.
 *
 * `intent` is the optional entry intent a saved row's Run now or Schedule
 * carries. It is a closed vocabulary and contains no definition content; the
 * editor host consumes it once, after this revision is reviewed.
 */
function readSavedEntryIntent(raw: string | string[] | undefined): WorkflowSavedEntryIntent | undefined {
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === 'run' || value === 'schedule' ? value : undefined;
}

export function SavedWorkflowRoute(): React.ReactElement {
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string | string[]; intent?: string | string[]; agentRevisionSeedId?: string; authoringSessionId?: string }>();
    const definitionId = Array.isArray(params.id) ? params.id[0] : params.id;
    const intent = readSavedEntryIntent(params.intent);
    if (definitionId === undefined || definitionId.length === 0) {
        return (
            <WorkflowsGate>
                <WorkflowMissingDefinitionState
                    testID="workflow-detail-invalid"
                    onOpenCollection={() => router.replace('/workflows' as never)}
                />
            </WorkflowsGate>
        );
    }
    return (
        <WorkflowsGate>
            {parseWorkflowDefinitionRefV1(definitionId)?.kind === 'plugin' ? (
                <WorkflowPluginSourceScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} />
            ) : parseWorkflowDefinitionRefV1(definitionId)?.kind === 'builtin' ? (
                <WorkflowBuiltinSourceScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} />
            ) : <WorkflowEditorHostScreen source={{
                kind: 'saved',
                definitionId,
                ...(intent === undefined ? {} : { intent }),
                ...(typeof params.agentRevisionSeedId === 'string' ? { agentRevisionSeedId: params.agentRevisionSeedId } : {}),
                ...(typeof params.authoringSessionId === 'string' ? { authoringSessionId: params.authoringSessionId } : {}),
            }} />}
        </WorkflowsGate>
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SavedWorkflowRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SavedWorkflowRoute} />; }
