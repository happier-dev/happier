import { buildMoveWorkflowDefinition } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDeploymentWorkflow } from './useDeploymentWorkflow';

type MoveInput = Parameters<typeof buildMoveWorkflowDefinition>[0];
type ReviewedMoveInput<T> = T extends unknown ? Omit<T, 'requestId'> : never;

export function useDeploymentMoveWorkflow(lifetime: ServerAccountScopeLifetime, projectSourceId: string, environmentId: string) {
    const workflow = useDeploymentWorkflow(lifetime, projectSourceId, `deployment-move:${environmentId}`);
    return { ...workflow, run: (input: ReviewedMoveInput<MoveInput>,
        title: string, controllerMachineId: string) => workflow.run(
        requestId => buildMoveWorkflowDefinition({ ...input, requestId }), title, controllerMachineId) };
}
