import * as React from 'react';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { useWorkflowRunNowController, type WorkflowRunNowRequest } from '@/components/workflows/run/useWorkflowRunNowController';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeploymentActions } from './deploymentActions';

/** Deployment Workflows share the existing Run-now admission and recovery owner. */
export function useDeploymentWorkflow(lifetime: ServerAccountScopeLifetime, projectSourceId: string, key: string) {
    const admission = useWorkflowRunNowController(lifetime, key);
    const actions = React.useMemo(() => createDeploymentActions(lifetime, projectSourceId), [lifetime, projectSourceId]);
    const run = (author: (requestId: string) => Readonly<{ definition: WorkflowDefinitionV1; inputs: WorkflowRunNowRequest['inputs'] }>,
        title: string, controllerMachineId: string) => admission.runNow({
        // The sheet that pressed Start says a refusal in place, with its phase and code (PAGE-ACCEPT-176 D25).
        refusal: 'inline', isInvocationCurrent: lifetime.isCurrent,
        prepareRequest: async runId => {
            const authored = author(runId);
            const saved = await actions.saveWorkflow(runId, authored.definition, title);
            return { source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
                inputs: authored.inputs, reviewedDefinition: authored.definition,
                executionTarget: { kind: 'detached_run' },
                project: { machineId: controllerMachineId, directory: '~' },
            };
        },
    });
    return { run, refusal: admission.refusal, pending: admission.pendingRunId !== null
        && admission.hasUnsettledAdmission(admission.pendingRunId) };
}
