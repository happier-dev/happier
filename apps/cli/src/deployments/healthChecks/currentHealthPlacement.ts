import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
  DeploymentEnvironmentHeaderV1,
  DeploymentTargetLinkHeaderV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';

/**
 * Current edge health is read on the Environment controller from its own-server
 * runtime link. Every other placement settles here with a typed reason the caller
 * can act on, instead of an authorization refusal further along.
 */
export function readDeploymentHealthCurrentPlacementFailure(
  request: Readonly<{ machineId: string; targetLinkId: string }>,
  environment: Pick<
    DeploymentEnvironmentHeaderV1,
    'controllerMachineId' | 'runtimeTargetLinkId' | 'capabilities'
  >,
  targetLinks: readonly Pick<
    DeploymentTargetLinkHeaderV1,
    'id' | 'targetKind'
  >[],
): ActionExecuteFailure | null {
  if (!environment.capabilities.read)
    return {
      ok: false,
      errorCode: 'action_forbidden',
      error: 'action_forbidden',
    };
  const link = targetLinks.find((item) => item.id === request.targetLinkId);
  if (!link || environment.runtimeTargetLinkId !== link.id) {
    return {
      ok: false,
      errorCode: 'target_mismatch',
      error: 'target_mismatch',
      effectAttempted: false,
    };
  }
  if (link.targetKind !== 'ownServer')
    return {
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action',
      effectAttempted: false,
      details: {
        reason: 'target_not_supported',
        targetKind: link.targetKind,
        requiredFact: 'edgeHealthObservation',
        supportedAction: 'deployments.observation.get',
        remedy:
          'Current edge health is recorded only for own-server targets. Use deployments.observation.get for the provider deployment state, or deployments.receipts.get for the recorded receipt.',
      },
    };
  if (environment.controllerMachineId !== request.machineId)
    return {
      ok: false,
      errorCode: 'target_mismatch',
      error: 'target_mismatch',
      effectAttempted: false,
      details: {
        reason: 'controller_placement',
        requiredFact: 'environmentControllerMachine',
        controllerMachineId: environment.controllerMachineId,
        remedy: `Current health is read on the Environment controller. Retry with machineId ${environment.controllerMachineId}.`,
      },
    };
  return null;
}
