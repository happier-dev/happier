import type {
  ActionsSettingsV1,
  ActionSettingsActionId,
} from '@happier-dev/protocol/actions/actionSettings';
import { readDeploymentEnvironmentApprovalScopeV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';

import { resolveActionSettingsTargetControlState } from '@/components/settings/actions/resolveActionSettingsControlState';

/** Agents are the audience a per-Environment approval is offered for, as for a Machine (Plan 40 §6.1). */
export const ENVIRONMENT_APPROVAL_AUDIENCE = 'agent' as const;

type ApprovalEnvironment = Parameters<
  typeof readDeploymentEnvironmentApprovalScopeV1
>[0];

/** The scope an Environment's approval rows are written under, and the admitted scope the policy reads them with. */
export function environmentApprovalScopes(environment: ApprovalEnvironment) {
  const admission = readDeploymentEnvironmentApprovalScopeV1(environment);
  return {
    scope: { kind: 'environment' as const, environmentId: environment.id },
    approvalScope:
      'scope' in admission ? (admission.scope ?? undefined) : undefined,
    admitted: 'scope' in admission,
  };
}

/**
 * Whether an agent asks before every one of these Actions in this Environment: the shared Actions policy's own answer
 * (`approvalRequiredByPolicy`) for the agent audience, under the person's settings. A consequence review says
 * "Agents ask first" only when this holds for each Action its choices run.
 */
export function environmentAgentsAskFirst(
  params: Readonly<{
    settings: ActionsSettingsV1;
    environment: ApprovalEnvironment;
    actionIds: readonly ActionSettingsActionId[];
  }>,
): boolean {
  const { scope, approvalScope } = environmentApprovalScopes(
    params.environment,
  );
  return params.actionIds.every((actionId) => {
    const state = resolveActionSettingsTargetControlState({
      settings: params.settings,
      scope,
      approvalScope,
      actionId,
      targetId: ENVIRONMENT_APPROVAL_AUDIENCE,
    });
    return state.kind === 'approval' && state.approvalRequiredByPolicy;
  });
}
