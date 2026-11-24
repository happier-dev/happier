import { RPC_METHODS } from '../../../../rpc/methods.js';
import { readRecord } from '../../../../inputs/inputRecords.js';
import type {
  ExternalActionExecutionAuthorizationV1,
  ReviewedActionChildHttpProofV1,
} from '../../../../actions/externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../../../../actions/decisionAuthority.js';
import { readProjectSetupSetChildRpcEffectV1 } from '../../../../actions/projectActionIdsV1.js';
import { isSessionStopChildRootV1 } from '../../../../actions/sessionSectionArchive.js';
import {
  DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
  deploymentChildEffectActionIdForRootV1,
} from '../../../../deployments/deploymentActionIdsV1.js';
import { isDeploymentBackupConfigureNativeAdmissionV1 } from '../../../../deployments/deploymentCandidatePublicationV1.js';
import { readSessionActionChildCreationRpcEffectV1 } from '../../../../sessions/creation/sessionCreationActionIdsV1.js';
import { readProjectServiceMoveChildEffectV1 } from '../../../../workspaces/projectServiceRelocationV1.js';
import {
  BACKUP_RECEIVER_SETUP_CHILDREN_V1,
  isMachineSetupPlanRpcChildV1,
  readSessionAgentReadinessChildActionV1,
} from '../../../managed/actionIdsV1.js';
import { resolveMachineRpcExternalActionEffectV1 } from './routePolicyV1.js';

type RootBinding = ExternalActionExecutionAuthorizationV1['binding'];

/**
 * Reviewed child families of an admitted root that may act on a Machine other
 * than the root's own. Each family names that Machine only through the root's
 * own review; its operand check stays with the family's owner.
 */
export type ReviewedMachineRpcChildFamilyV1 =
  | 'readiness'
  | 'creation'
  | 'setup_plan'
  | 'backup_receiver_setup'
  | 'stop'
  | 'service_move'
  | 'project_setup_set'
  | 'deployment';

/** The receiving Machine a Backup configure root's own reviewed input named, signed into its native admission. */
export function readBackupReceiverMachineIdV1(
  binding: RootBinding | undefined,
): string | null {
  const admission =
    binding?.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
      ? binding.deploymentNativeAdmission
      : undefined;
  return isDeploymentBackupConfigureNativeAdmissionV1(admission) &&
    admission.receiverMachineId
    ? admission.receiverMachineId
    : null;
}

/**
 * The one decision for "which reviewed child of an admitted root may spend
 * this native method on another Machine". Every sender, Home and receiver
 * layer consumes this result and keeps only its own operand checks.
 * `target` is the receiving Machine and the signing installation when the
 * layer knows them; `method` is the unprefixed native method. A layer that
 * holds the signed packet passes its `effectActionId`, which must be the
 * family's effect; the requester-custody seal, which precedes the packet,
 * omits it and gets the family the method itself belongs to.
 */
export function readReviewedMachineRpcChildFamilyV1(input: Readonly<{
  binding: RootBinding | undefined;
  effectActionId?: string | undefined;
  method: string;
  target?: Readonly<{ machineId: string; installationId: string }>;
  reviewedChild?: ReviewedActionChildHttpProofV1;
}>): ReviewedMachineRpcChildFamilyV1 | null {
  const { binding, effectActionId: effect, method, target, reviewedChild } = input;
  if (!binding) return null;
  const root = binding.actionId;
  const fits = (familyEffect: string | null | undefined) =>
    familyEffect !== null && familyEffect !== undefined && (effect === undefined || effect === familyEffect);
  // A readiness or creation proof selects its family; it never falls through to another.
  const readiness = readSessionAgentReadinessChildActionV1(binding, reviewedChild, target);
  if (readiness !== null) {
    return fits(readiness) && resolveMachineRpcExternalActionEffectV1(method, binding, target, reviewedChild) === readiness
      ? 'readiness' : null;
  }
  const creation = readSessionActionChildCreationRpcEffectV1(method, binding, target, reviewedChild);
  if (creation !== null) return fits(creation) ? 'creation' : null;
  if (isMachineSetupPlanRpcChildV1({ rootActionId: root, effectActionId: effect ?? method, method })) return 'setup_plan';
  const receiver = readBackupReceiverMachineIdV1(binding);
  if (receiver !== null && reviewedChild?.actionId === method && fits(reviewedChild.actionId)
    && Object.values(BACKUP_RECEIVER_SETUP_CHILDREN_V1).some((child) => child.action === method && child.role === reviewedChild.role)) {
    return !target || target.machineId === receiver ? 'backup_receiver_setup' : null;
  }
  if (isSessionStopChildRootV1(root) && method === RPC_METHODS.STOP_SESSION && fits('session.stop')) return 'stop';
  if (root === 'projects.service.relocate' && fits(readProjectServiceMoveChildEffectV1(method))) return 'service_move';
  if (fits(readProjectSetupSetChildRpcEffectV1(root, method))) return 'project_setup_set';
  if (binding.deploymentChildRoot === true && method === RPC_METHODS.DAEMON_DEPLOYMENT_CHILD
    && fits(deploymentChildEffectActionIdForRootV1(root, binding.deploymentPreparationAdmission, effect))) return 'deployment';
  return null;
}

/**
 * Operand of a Backup receiver Setup child: exactly the reviewed child input,
 * addressed to the receiver the root's review named, at the root's Home.
 */
export function isBackupReceiverSetupChildOperandV1(
  input: Readonly<{
    binding: RootBinding;
    reviewedChild: ReviewedActionChildHttpProofV1 | undefined;
    machineId: string;
    params: unknown;
  }>,
): boolean {
  const receiver = readBackupReceiverMachineIdV1(input.binding);
  const operand = readRecord(input.params);
  const reviewed = input.reviewedChild;
  const child = Object.values(BACKUP_RECEIVER_SETUP_CHILDREN_V1).find(
    (declared) => declared.action === reviewed?.actionId && declared.role === reviewed.role,
  );
  return (
    receiver !== null &&
    receiver === input.machineId &&
    reviewed !== undefined &&
    child !== undefined &&
    operand.homeId === input.binding.serverIdentityId &&
    operand.machineId === receiver &&
    computeActionInputApprovalDigestV1(child.action, input.params) === reviewed.inputDigest
  );
}

/** Roots whose reviewed Setup children run on a Machine their own review named; they carry the original envelope there. */
export function isReviewedMachineSetupChildRootV1(binding: RootBinding): boolean {
  return (
    isMachineSetupPlanRpcChildV1({
      rootActionId: binding.actionId,
      effectActionId: 'machines.setup.plan',
      method: RPC_METHODS.MACHINE_SETUP_PLAN,
    }) || readBackupReceiverMachineIdV1(binding) !== null
  );
}
