import * as React from 'react';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createWorkflowStartDetailsTab, type WorkflowStartSource } from '@/components/workflows/run/workflowStartDetailsModel';
import type { WorkflowStartReference } from '@/components/workflows/run/WorkflowStartPicker';
import { tLoose } from '@/text';
import { useSessionAgentStartOpener } from './useSessionAgentStartOpener';
import { useSessionAddressForSessionId } from '@/components/sessions/plugins/useSessionPluginRuntime';

export { BUILTIN_WORKFLOW_CATALOG_V1 as SESSION_STARTABLE_BUILTIN_WORKFLOWS } from '@happier-dev/protocol/workflows/builtins/catalog';

/** Every contextual choice opens a reference; the mounted Details body owns the start. */
export function useSessionBuiltinWorkflowStart(params: Readonly<{ sessionId: string; serverId?: string | null; scopeId?: string }>) {
    const openStart = useSessionAgentStartOpener();
    const address = useSessionAddressForSessionId(params.sessionId, params.serverId);
    const destinationScopeId = useDestinationPaneScopeId(createSessionPaneScopeId(params.sessionId, address?.serverId));
    const scopeId = params.scopeId ?? destinationScopeId;
    return React.useCallback((workflow: string | WorkflowPluginSourceV1 | WorkflowStartReference | WorkflowStartSource) => {
        let source: WorkflowStartSource;
        let title: string | undefined;
        if (typeof workflow === 'string') {
            const builtin = BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === workflow);
            if (!builtin) return;
            source = { kind: 'catalog', workflow: builtin.id };
            title = tLoose(builtin.titleKey);
        } else if ('source' in workflow) {
            source = workflow.source;
            title = workflow.name;
        } else if ('kind' in workflow) {
            source = workflow;
        } else {
            source = { kind: 'catalog', workflow: workflow.workflow, pluginVersion: workflow.version };
            title = workflow.title;
        }
        openStart(scopeId, createWorkflowStartDetailsTab(source, title));
    }, [openStart, scopeId]);
}
