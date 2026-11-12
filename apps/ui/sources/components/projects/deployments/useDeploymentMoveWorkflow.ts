import { buildMoveWorkflowDefinition } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDeploymentWorkflow } from './useDeploymentWorkflow';

export function useDeploymentMoveWorkflow(lifetime: ServerAccountScopeLifetime, projectSourceId: string, environmentId: string) {
    const workflow = useDeploymentWorkflow(lifetime, projectSourceId, `deployment-move:${environmentId}`);
    return { ...workflow, run: (input: Omit<Parameters<typeof buildMoveWorkflowDefinition>[0], 'requestId'>,
        title: string, controllerMachineId: string) => workflow.run(
        requestId => buildMoveWorkflowDefinition({ ...input, requestId }), title, controllerMachineId) };
}
