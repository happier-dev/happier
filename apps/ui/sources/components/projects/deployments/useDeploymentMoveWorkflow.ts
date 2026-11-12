import * as React from 'react';
import { buildMoveWorkflowDefinition } from '@happier-dev/deployments';
import { useWorkflowRunNowController } from '@/components/workflows/run/useWorkflowRunNowController';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeploymentActions } from './deploymentActions';

export function useDeploymentMoveWorkflow(lifetime: ServerAccountScopeLifetime, projectSourceId: string, environmentId: string) {
    const admission = useWorkflowRunNowController(lifetime, `deployment-move:${environmentId}`);
    const actions = React.useMemo(() => createDeploymentActions(lifetime, projectSourceId), [lifetime, projectSourceId]);
    const run = (input: Omit<Parameters<typeof buildMoveWorkflowDefinition>[0], 'requestId'>, title: string, controllerMachineId: string) => admission.runNow({
        refusal: 'alert', isInvocationCurrent: lifetime.isCurrent,
        prepareRequest: async runId => {
            const authored = buildMoveWorkflowDefinition({ ...input, requestId: runId });
            const saved = await actions.saveMoveWorkflow(runId, authored.definition, title);
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
