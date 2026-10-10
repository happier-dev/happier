import * as React from 'react';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows';

import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowBuiltinEditorHostScreen, WorkflowPluginEditorHostScreen } from './WorkflowCatalogEditorHostScreen';
import { WorkflowEditorHostScreen, type WorkflowEditorSource, type WorkflowSavedEntryIntent } from './WorkflowEditorHostScreen';
import { WorkflowMissingDefinitionState } from './WorkflowMissingDefinitionState';

/** Create and saved URLs are two identities of the same mounted editor. */
export function WorkflowEditorRoute(): React.ReactElement {
    const router = useRouter();
    const pathname = usePathname();
    const params = useLocalSearchParams<{
        id?: string | string[]; intent?: string | string[]; importJson?: string;
        reviewedRunSeedId?: string; newSessionDraftSeedId?: string; triggerWorkflowSeedId?: string;
        definitionDraftSeedId?: string; example?: string; builtin?: string;
        agentRevisionSeedId?: string; authoringSessionId?: string;
    }>();
    let source: WorkflowEditorSource;
    if (pathname === '/workflows/new') {
        // Only opaque seed handles travel in the URL; private definition and
        // placement remain in the existing Account-scoped temporary store.
        const seed = (value: string | undefined) => typeof value === 'string' && value.length > 0 ? value : undefined;
        const reviewedRunSeedId = seed(params.reviewedRunSeedId);
        const newSessionDraftSeedId = seed(params.newSessionDraftSeedId);
        const triggerWorkflowSeedId = seed(params.triggerWorkflowSeedId);
        source = {
            kind: 'new',
            ...(typeof params.example === 'string' ? { exampleKey: params.example } : {}),
            ...(typeof params.builtin === 'string' ? { builtinId: params.builtin } : {}),
            ...(params.importJson === '1' ? { requestImport: true } : {}),
            ...(reviewedRunSeedId === undefined ? {} : { reviewedRunSeedId }),
            ...(newSessionDraftSeedId === undefined ? {} : { newSessionDraftSeedId }),
            ...(triggerWorkflowSeedId === undefined ? {} : { triggerWorkflowSeedId }),
            ...(typeof params.definitionDraftSeedId === 'string' ? { definitionDraftSeedId: params.definitionDraftSeedId } : {}),
        };
    } else {
        const definitionId = Array.isArray(params.id) ? params.id[0] : params.id;
        const rawIntent = Array.isArray(params.intent) ? params.intent[0] : params.intent;
        const intent: WorkflowSavedEntryIntent | undefined = rawIntent === 'run' || rawIntent === 'schedule' ? rawIntent : undefined;
        if (definitionId === undefined || definitionId.length === 0) {
            return <WorkflowsGate><WorkflowMissingDefinitionState testID="workflow-detail-invalid"
                onOpenCollection={() => router.replace('/workflows' as never)} /></WorkflowsGate>;
        }
        const reference = parseWorkflowDefinitionRefV1(definitionId);
        if (reference?.kind === 'plugin') {
            return <WorkflowsGate><WorkflowPluginEditorHostScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} /></WorkflowsGate>;
        }
        if (reference?.kind === 'builtin') {
            return <WorkflowsGate><WorkflowBuiltinEditorHostScreen workflow={definitionId} {...(intent === 'run' ? { intent } : {})} /></WorkflowsGate>;
        }
        source = {
            kind: 'saved', definitionId,
            ...(intent === undefined ? {} : { intent }),
            ...(typeof params.agentRevisionSeedId === 'string' ? { agentRevisionSeedId: params.agentRevisionSeedId } : {}),
            ...(typeof params.authoringSessionId === 'string' ? { authoringSessionId: params.authoringSessionId } : {}),
        };
    }
    return <WorkflowsGate><WorkflowEditorHostScreen source={source} /></WorkflowsGate>;
}
