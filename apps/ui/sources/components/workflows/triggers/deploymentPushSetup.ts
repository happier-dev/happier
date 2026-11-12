import type { AutomationDeploymentTriggerV1 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

export type DeploymentPushSetupConfig = Readonly<{
  environment: DeploymentEnvironmentRefV1;
  targetLinkId: string;
  project: WorkflowProjectTargetV1;
  protection: DeploymentEnvironmentHeaderV1['protection'];
}>;

/** Translate the editor draft while retaining the owner's other saved filters. */
export function buildDeploymentPushFilter(branch: string, existing?: AutomationDeploymentTriggerV1) {
  const { triggerId: _triggerId, branch: _branch, ...filter } = existing ?? {};
  return { ...filter, ...(branch.trim() ? { branch: branch.trim() } : {}) };
}

/** Fixed destination operands only. The trigger owner binds SHA/requestKey from its admitted occurrence. */
export function buildDeploymentPushRequest(
  config: Omit<DeploymentPushSetupConfig, 'protection'>,
  trigger: AutomationTriggerDefinitionInput,
  actionApproval?: 'automatic' | 'ask',
  branch?: string,
) {
  const starter = getWorkflowStarterExamplesV1().find(example => example.key === 'deploy-on-push');
  if (!starter) throw new Error('deploy-on-push starter unavailable');
  return {
    target: { kind: 'inline' as const, definition: starter.definition },
    project: config.project,
    executionTarget: { kind: 'detached_run' as const },
    trigger,
    inputs: { serverId: config.environment.serverId, environmentId: config.environment.environmentId,
      targetLinkId: config.targetLinkId },
    deployment: buildDeploymentPushFilter(branch ?? ''),
    ...(actionApproval === undefined ? {} : { actionApproval }),
  };
}
