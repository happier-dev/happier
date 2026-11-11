import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  isDeploymentBackupConfigureNativeAdmissionV1,
  isDeploymentEnvironmentUpdateNativeAdmissionV1,
  type ExternalActionExecutionAuthorizationBindingV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  isDeploymentBackupActionIdV1,
  isDeploymentDomainChildActionIdV1,
} from '@happier-dev/protocol';
import {
  isDeploymentBackupReadActionIdV1,
  DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import type { Tx } from '@/storage/inTx';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import {
  canDeployDeploymentEnvironment,
  projectDeploymentControllerPlacementFailure,
} from './deploymentAdmission';
import {
  readDeploymentReadAuthorizationInTx,
  readDeploymentTargetAuthorizationInTx,
} from './deploymentReadAuthorization';

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
          source: { ...nativeAdmission.source, origin: undefined },
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
  if (
    configureRoot &&
    isDeploymentBackupConfigureNativeAdmissionV1(nativeAdmission) &&
    environment.row.revision !== nativeAdmission.expectedRevision
  )
    return { ok: false };
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

/**
 * A person-presented root re-enters the same Environment admission its mint ran:
 * native roots through the native owner above, read roots through the read
 * admission owner. Roots without an Environment admission pass unchanged.
 */
export async function hasCurrentDeploymentRootEnvironmentAdmissionInTx(
  tx: Tx,
  root: ExternalActionExecutionAuthorizationBindingV1,
  nativeAdmission: DeploymentNativeAdmissionV1 | undefined,
  authenticationEvidence:
    | readonly AuthTokenAuthenticationEvidenceV1[]
    | undefined,
): Promise<boolean> {
  if (
    nativeAdmission &&
    !(
      await admitDeploymentNativeRootEnvironmentInTx(
        tx,
        root,
        nativeAdmission,
        authenticationEvidence,
      )
    ).ok
  )
    return false;
  if (
    root.deploymentReadAdmission &&
    !(await readDeploymentReadAuthorizationInTx(
      tx,
      root,
      root.deploymentReadAdmission,
      { authenticationAuthority: 'account_automation', authenticationEvidence },
    ))
  )
    return false;
  return true;
}
