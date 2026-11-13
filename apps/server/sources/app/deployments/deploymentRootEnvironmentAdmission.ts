import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  isDeploymentBackupConfigureNativeAdmissionV1,
  isDeploymentEnvironmentUpdateNativeAdmissionV1,
  isDeploymentPreparationActionIdV1,
  isDeploymentReadAdmissionActionIdV1,
  type ExternalActionExecutionAuthorizationBindingV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  isDeploymentBackupActionIdV1,
  isDeploymentDomainChildActionIdV1,
} from '@happier-dev/protocol';
import {
  isDeploymentBackupReadActionIdV1,
  DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import type { Tx } from '@/storage/inTx';
import { resolveMachineAdmissionsInTx } from '@/app/machines/machineAccess';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import {
  canDeployDeploymentEnvironment,
  canTeardownDeploymentEnvironment,
  admitDeploymentMachineInTx,
  projectDeploymentControllerPlacementFailure,
} from './deploymentAdmission';
import {
  readDeploymentReadAuthorizationInTx,
  readDeploymentTargetAuthorizationInTx,
  readRegistryAppUpdateAuthorizationInTx,
} from './deploymentReadAuthorization';
import { readDeploymentPreparationAuthorizationInTx, readDeploymentLinkAdmissionInTx, type DeploymentPreparationAuthorization } from './deploymentPreparationAuthorization';

export type DeploymentRootEnvironmentAdmission =
  | Readonly<{ ok: true; source?: Readonly<{ id: string; revision: number }> }>
  | Readonly<{ ok: false; placement?: ActionExecuteFailure }>;

/**
 * The one Environment admission for a native deployment root. Mint runs it once
 * per root, and a person-presented root relay runs it again at each start,
 * restart or retry; signed child calls of admitted work do not repeat it.
 */
export async function admitDeploymentNativeRootEnvironmentInTx(
  tx: Tx,
  root: Readonly<{
    accountId: string;
    serverIdentityId: string;
    machineId: string;
    actionId: string;
  }>,
  nativeAdmission: DeploymentNativeAdmissionV1,
  authenticationEvidence:
    | readonly AuthTokenAuthenticationEvidenceV1[]
    | undefined,
): Promise<DeploymentRootEnvironmentAdmission> {
  // Domain children carry their own native admission owner.
  if (isDeploymentDomainChildActionIdV1(root.actionId)) return { ok: true };
  const ingressUpdateRoot =
    root.actionId === 'deployments.environments.update' &&
    isDeploymentEnvironmentUpdateNativeAdmissionV1(nativeAdmission);
  const configureRoot =
    root.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1;
  const nativeMemberRoot =
    root.actionId === 'deployments.restart' ||
    root.actionId === 'deployments.backups.restore' ||
    isDeploymentBackupActionIdV1(root.actionId);
  const authentication = {
    authenticationAuthority: 'account_automation' as const,
    authenticationEvidence,
  };
  const environment = await loadDeploymentEnvironmentInTx(
    tx,
    root.accountId,
    root.serverIdentityId,
    nativeAdmission.environmentId,
    authentication,
  );
  if (!environment.ok) return { ok: false };
  if ('kind' in nativeAdmission && nativeAdmission.kind === 'promote') {
    if (!environment.admission.canManage) return { ok: false };
    const source = await loadDeploymentEnvironmentInTx(tx, root.accountId, root.serverIdentityId,
      nativeAdmission.sourceEnvironmentId, authentication);
    if (!source.ok || !canDeployDeploymentEnvironment(source.admission, source.row)
      || !await tx.deployment.findFirst({ where: { id: nativeAdmission.sourceDeploymentId,
        environmentId: source.row.id }, select: { id: true } })) return { ok: false };
  }
  if (
    'kind' in nativeAdmission &&
    nativeAdmission.kind === 'restore' &&
    nativeAdmission.source.kind === 'repository' &&
    nativeAdmission.source.origin
  ) {
    const source = await loadDeploymentEnvironmentInTx(
      tx,
      root.accountId,
      root.serverIdentityId,
      nativeAdmission.source.origin.environmentId,
      authentication,
    );
    // The reviewed revision belongs to the destination, not the source read.
    const { expectedRevision: _expectedRevision, ...sourceAdmission } =
      nativeAdmission;
    // Copy executes on an existing source member. Both principals are
    // admitted here; the finite signed invocation retains custody.
    if (
      !environment.admission.canManage ||
      !source.ok ||
      !source.admission.canManage ||
      !(await readDeploymentTargetAuthorizationInTx(
        tx,
        source.row,
        {
          ...sourceAdmission,
          environmentId: source.row.id,
          targetLinkId: nativeAdmission.source.origin.targetLinkId,
        },
        { actorAccountId: root.accountId, owner: source.admission.owner },
      ))
    )
      return { ok: false };
  }
  if (
    root.actionId !== 'action.operations.get' &&
    !isDeploymentBackupReadActionIdV1(root.actionId)
  ) {
    if (
      !(ingressUpdateRoot || configureRoot
        ? environment.admission.canManage && !environment.row.deletedAt
        : root.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
        ? canTeardownDeploymentEnvironment(environment.admission, environment.row)
        : canDeployDeploymentEnvironment(
            environment.admission,
            environment.row,
          ))
    )
      return { ok: false };
    if (
      !nativeMemberRoot &&
      environment.row.controllerMachineId !== root.machineId
    ) {
      return {
        ok: false,
        placement: projectDeploymentControllerPlacementFailure(
          environment.row.controllerMachineId,
        ),
      };
    }
  }
  if (configureRoot) {
    if (!isDeploymentBackupConfigureNativeAdmissionV1(nativeAdmission) ||
      environment.row.revision !== nativeAdmission.expectedRevision) return { ok: false };
    if (nativeAdmission.receiverMachineId !== undefined) {
      const receivers = await resolveMachineAdmissionsInTx(tx, {
        actorAccountId: root.accountId, machineIds: [nativeAdmission.receiverMachineId],
      });
      if (receivers.get(nativeAdmission.receiverMachineId)?.kind !== 'admitted' ||
        await admitDeploymentMachineInTx(tx, environment.admission.owner,
          nativeAdmission.receiverMachineId, 'target')) return { ok: false };
    }
  }
  if (nativeMemberRoot) {
    if (
      !('kind' in nativeAdmission) ||
      (nativeAdmission.kind !== 'restart' &&
        nativeAdmission.kind !== 'restore' &&
        nativeAdmission.kind !== 'backup') ||
      !(await readDeploymentTargetAuthorizationInTx(
        tx,
        environment.row,
        nativeAdmission,
        nativeAdmission.kind === 'restore' &&
          nativeAdmission.source.kind === 'repository' &&
          nativeAdmission.source.origin
          ? {
              actorAccountId: root.accountId,
              owner: environment.admission.owner,
            }
          : undefined,
      ))
    )
      return { ok: false };
  }
  return root.actionId !== 'action.operations.get' &&
    !ingressUpdateRoot &&
    !configureRoot
    ? {
        ok: true,
        source: {
          id: environment.admission.source.id,
          revision: environment.admission.source.revision,
        },
      }
    : { ok: true };
}

export type DeploymentRootBindingAdmission =
  | Readonly<{
      ok: true;
      deploymentLinkAdmission?: NonNullable<ExternalActionExecutionAuthorizationBindingV1['deploymentLinkAdmission']>;
    }>
  | Readonly<{ ok: false; code?: Extract<DeploymentPreparationAuthorization, { ok: false }>['code'] }>;

/**
 * The one admission of a parsed root binding's deployment facts: Link,
 * preparation, registry update and read. Mint runs it once and records the
 * Link admission it produces; a person-presented relay runs the same function
 * again, so it re-decides exactly what mint decided.
 */
export async function admitDeploymentRootBindingInTx(
  tx: Tx,
  binding: ExternalActionExecutionAuthorizationBindingV1,
  input: Readonly<{
    /** The Link Environment mint derived from input, or the relay's recorded one. */
    linkEnvironmentId?: string;
    /** Installed Workflow children were narrowed against their signed parent. */
    workflowAdmitted: boolean;
    authenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
    linkAuthenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined;
  }>,
): Promise<DeploymentRootBindingAdmission> {
  const authentication = {
    authenticationAuthority: 'account_automation' as const,
    ...(input.authenticationEvidence ? { authenticationEvidence: input.authenticationEvidence } : {}),
  };
  let deploymentLinkAdmission: NonNullable<ExternalActionExecutionAuthorizationBindingV1['deploymentLinkAdmission']> | undefined;
  if (binding.actionId === 'deployments.targets.link') {
    if (!input.linkEnvironmentId) return { ok: false };
    const admitted = await readDeploymentLinkAdmissionInTx(tx, binding, input.linkEnvironmentId, {
      authenticationAuthority: 'account_automation',
      authenticationEvidence: input.linkAuthenticationEvidence,
    });
    if (!admitted) return { ok: false };
    deploymentLinkAdmission = admitted;
  }
  if (!input.workflowAdmitted
    && (isDeploymentPreparationActionIdV1(binding.actionId) || binding.deploymentPreparationAdmission !== undefined)) {
    if (!binding.deploymentPreparationAdmission) return { ok: false };
    const preparation = await readDeploymentPreparationAuthorizationInTx(tx, binding, binding.deploymentPreparationAdmission, authentication);
    if (!preparation.ok) return preparation;
  }
  if (binding.registryAppUpdateAdmission && !await readRegistryAppUpdateAuthorizationInTx(tx, binding, authentication)) {
    return { ok: false };
  }
  const managedDataRead = binding.actionId === ACTION_INVOKE_ACTION_ID_V1
    && binding.deploymentReadAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1;
  if ((isDeploymentReadAdmissionActionIdV1(binding.actionId) || managedDataRead)
    && (!binding.deploymentReadAdmission
      || !await readDeploymentReadAuthorizationInTx(tx, binding, binding.deploymentReadAdmission, authentication))) {
    return { ok: false };
  }
  return deploymentLinkAdmission ? { ok: true, deploymentLinkAdmission } : { ok: true };
}

/**
 * Every root relay, daemon-signed or person-presented, re-enters the admission
 * its mint ran: the native Environment owner, then the binding admission owner.
 * Signed child calls within admitted work retain that job's admission.
 */
export async function readCurrentDeploymentRootEnvironmentAdmissionInTx(
  tx: Tx,
  root: ExternalActionExecutionAuthorizationBindingV1,
  nativeAdmission: DeploymentNativeAdmissionV1 | undefined,
  authenticationEvidence: readonly AuthTokenAuthenticationEvidenceV1[] | undefined,
): Promise<DeploymentRootBindingAdmission> {
  if (nativeAdmission
    && !(await admitDeploymentNativeRootEnvironmentInTx(tx, root, nativeAdmission, authenticationEvidence)).ok) return { ok: false };
  const recordedLink = root.deploymentLinkAdmission;
  const admitted = await admitDeploymentRootBindingInTx(tx, root, {
    ...(recordedLink ? { linkEnvironmentId: recordedLink.environmentId } : {}),
    workflowAdmitted: root.workflowActionOrigin !== undefined,
    authenticationEvidence,
    linkAuthenticationEvidence: authenticationEvidence,
  });
  if (!admitted.ok) return admitted;
  return admitted.deploymentLinkAdmission?.environmentId === recordedLink?.environmentId ? admitted : { ok: false };
}
