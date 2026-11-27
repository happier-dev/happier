import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ExternalActionBindingAuthorityV1 } from '@happier-dev/protocol/actions/externalActionBindingAuthority';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  isDeploymentBackupConfigureNativeAdmissionV1,
  isDeploymentTelemetryNativeAdmissionV1,
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
  DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
  DEPLOYMENT_DEPLOY_ACTION_ID_V1,
  DEPLOYMENT_ROLLBACK_ACTION_ID_V1,
  DEPLOYMENT_PROMOTE_ACTION_ID_V1,
  isDeploymentDomainAddActionIdV1,
  isDeploymentDomainRemoveActionIdV1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import type { Tx } from '@/storage/inTx';
import { resolveMachineAdmissionsInTx } from '@/app/machines/machineAccess';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import {
  canDeployDeploymentEnvironment,
  canPromoteToDeploymentEnvironment,
  canTeardownDeploymentEnvironment,
  admitDeploymentMachineInTx,
  admitDeploymentCopyRestoreRecipientInTx,
  projectDeploymentControllerPlacementFailure,
  projectDeploymentRuntimeInstallationReplacedFailure,
} from './deploymentAdmission';
import { readDeploymentRuntimeReinstallMembersInTx, readDeploymentTargetRuntimeInstallations } from './deploymentTargetLinkService';
import {
  readDeploymentReadAuthorizationInTx,
  readDeploymentTargetAuthorizationInTx,
  readRegistryAppUpdateAuthorizationInTx,
} from './deploymentReadAuthorization';
import { readDeploymentPreparationAuthorizationInTx, readDeploymentLinkAdmissionInTx, type DeploymentPreparationAuthorization } from './deploymentPreparationAuthorization';

export type DeploymentRootEnvironmentAdmission =
  | Readonly<{ ok: true; source?: Readonly<{ id: string; revision: number }> }>
  | Readonly<{ ok: false; code?: 'source_changed'; placement?: ActionExecuteFailure;
      /** Private refusing branch for the mint's server diagnostic; never a public code. */
      phase?: string }>;

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
    installationId: string;
    actionId: string;
  }>,
  nativeAdmission: DeploymentNativeAdmissionV1,
  authenticationEvidence:
    | readonly AuthTokenAuthenticationEvidenceV1[]
    | undefined,
): Promise<DeploymentRootEnvironmentAdmission> {
  const domainRoot = isDeploymentDomainChildActionIdV1(root.actionId);
  const ingressUpdateRoot =
    root.actionId === 'deployments.environments.update' &&
    isDeploymentEnvironmentUpdateNativeAdmissionV1(nativeAdmission);
  const configureRoot =
    root.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1;
  const telemetryRoot = root.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1;
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
  if (!environment.ok) return { ok: false, phase: 'environment' };
  // Domain roots keep their own native placement owner; the requester's Environment
  // permission is decided here, once, with the capability the Domain owner requires.
  if (domainRoot) return (isDeploymentDomainAddActionIdV1(root.actionId) || isDeploymentDomainRemoveActionIdV1(root.actionId)
    ? environment.admission.canManage && !environment.row.deletedAt
    : canDeployDeploymentEnvironment(environment.admission, environment.row))
    ? { ok: true } : { ok: false, phase: 'environment_capability' };
  const promoting = 'kind' in nativeAdmission && nativeAdmission.kind === 'promote';
  if (promoting) {
    const source = await loadDeploymentEnvironmentInTx(tx, root.accountId, root.serverIdentityId,
      nativeAdmission.sourceEnvironmentId, authentication);
    if (!source.ok || !canDeployDeploymentEnvironment(source.admission, source.row)
      || !await tx.deployment.findFirst({ where: { id: nativeAdmission.sourceDeploymentId,
        environmentId: source.row.id }, select: { id: true } })) return { ok: false, phase: 'promote_source' };
    if (!canPromoteToDeploymentEnvironment(source.row, environment.row, environment.admission)) {
      return { ok: false, phase: 'promote_destination' };
    }
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
    // Copy executes on a source member, or on the person's own Machine that
    // opens its copy seal of the source backup credential. Both principals are
    // admitted here; the finite signed invocation retains custody.
    if (!environment.admission.canManage || !source.ok || !source.admission.canManage)
      return { ok: false, phase: 'restore_source' };
    const snapshotId = nativeAdmission.source.snapshotId;
    const origin = nativeAdmission.source.origin;
    const sourceRow = source.row;
    const sourceOwner = source.admission.owner;
    const destinationRow = environment.row;
    const destinationLinkId = nativeAdmission.targetLinkId;
    const readSource = (copySealRecipient?: true) => readDeploymentTargetAuthorizationInTx(
      tx,
      sourceRow,
      {
        ...sourceAdmission,
        source: { kind: 'repository', snapshotId },
        environmentId: sourceRow.id,
        targetLinkId: origin.targetLinkId,
      },
      { actorAccountId: root.accountId, owner: sourceOwner },
      undefined,
      copySealRecipient,
    );
    // Only a non-member is read further: a copy seal recipient restores into the
    // destination it serves (its own active runtime member) on the person's own Machine.
    const isCopySealRecipient = async () => {
      const destinationLink = await tx.deploymentTargetLink.findFirst({ where: { id: destinationLinkId,
        environmentId: destinationRow.id, deletedAt: null }, include: { machines: true } });
      return !!destinationLink && destinationRow.runtimeTargetLinkId === destinationLink.id
        && readDeploymentTargetRuntimeInstallations(destinationLink).some(member =>
          member.machineId === root.machineId && member.installationId === root.installationId)
        && (await admitDeploymentCopyRestoreRecipientInTx(tx, root.accountId, root)).ok;
    };
    const sourceRead = (await readSource()) ?? (await isCopySealRecipient() ? await readSource(true) : null);
    if (!sourceRead?.ok) return { ok: false, phase: 'restore_source' };
  }
  if (
    root.actionId !== 'action.operations.get' &&
    !isDeploymentBackupReadActionIdV1(root.actionId)
  ) {
    if (
      !promoting && !(ingressUpdateRoot || configureRoot || telemetryRoot
        ? environment.admission.canManage && !environment.row.deletedAt
        : root.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
        ? canTeardownDeploymentEnvironment(environment.admission, environment.row)
        : canDeployDeploymentEnvironment(
            environment.admission,
            environment.row,
          ))
    )
      return { ok: false, phase: 'environment_capability' };
    if (
      !nativeMemberRoot &&
      environment.row.controllerMachineId !== root.machineId
    ) {
      return {
        ok: false,
        phase: 'controller_placement',
        placement: projectDeploymentControllerPlacementFailure(
          environment.row.controllerMachineId,
        ),
      };
    }
  }
  // Deploy, Rollback and Promote place work on the runtime Link: a reinstalled member
  // is refused here, once, with its reinstall Actions instead of failing later per member.
  if (
    root.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 ||
    root.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1 ||
    root.actionId === DEPLOYMENT_PROMOTE_ACTION_ID_V1
  ) {
    const link = environment.row.runtimeTargetLinkId
      ? await tx.deploymentTargetLink.findFirst({
          where: { id: environment.row.runtimeTargetLinkId, environmentId: environment.row.id, deletedAt: null },
          include: { machines: true },
        })
      : null;
    const [replaced] = await readDeploymentRuntimeReinstallMembersInTx(tx, link);
    if (replaced) {
      return {
        ok: false,
        phase: 'runtime_installation_replaced',
        placement: projectDeploymentRuntimeInstallationReplacedFailure(replaced),
      };
    }
  }
  if (configureRoot) {
    if (!isDeploymentBackupConfigureNativeAdmissionV1(nativeAdmission) ||
      environment.row.revision !== nativeAdmission.expectedRevision) return { ok: false, phase: 'configure_revision' };
    if (nativeAdmission.receiverMachineId !== undefined) {
      const receivers = await resolveMachineAdmissionsInTx(tx, {
        actorAccountId: root.accountId, machineIds: [nativeAdmission.receiverMachineId],
      });
      // Setting up the receiver is Manage on that Machine; its nested Setup rides this admission.
      const receiver = receivers.get(nativeAdmission.receiverMachineId);
      if (receiver?.kind !== 'admitted' || receiver.role !== 'manage' ||
        receiver.installationId !== nativeAdmission.receiverInstallationId ||
        await admitDeploymentMachineInTx(tx, environment.admission.owner,
          nativeAdmission.receiverMachineId, 'target')) return { ok: false, phase: 'configure_receiver' };
    }
  }
  if (telemetryRoot) {
    if (!isDeploymentTelemetryNativeAdmissionV1(nativeAdmission)
      || environment.row.revision !== nativeAdmission.expectedRevision) return { ok: false, phase: 'telemetry_revision' };
    if (nativeAdmission.collector) {
      const placement = await admitDeploymentMachineInTx(tx, environment.admission.owner,
        nativeAdmission.collector.machineId, 'telemetry');
      if (placement) return { ok: false, phase: 'telemetry_collector' };
    }
  }
  if (nativeMemberRoot) {
    if (
      !('kind' in nativeAdmission) ||
      (nativeAdmission.kind !== 'restart' &&
        nativeAdmission.kind !== 'restore' &&
        nativeAdmission.kind !== 'backup')
    ) return { ok: false, phase: 'member_kind' };
    const selected = await readDeploymentTargetAuthorizationInTx(
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
        root,
      );
    if (!selected) return { ok: false, phase: 'member_target' };
    if (!selected.ok) return { ...selected, phase: 'member_target_authorization' };
  }
  return root.actionId !== 'action.operations.get' &&
    !ingressUpdateRoot &&
    !configureRoot && !telemetryRoot
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
      deploymentDatabaseAccess?: ExternalActionExecutionAuthorizationBindingV1['deploymentDatabaseAccess'];
      deploymentTelemetryRead?: ExternalActionExecutionAuthorizationBindingV1['deploymentTelemetryRead'];
    }>
  | Readonly<{ ok: false; code?: Extract<DeploymentPreparationAuthorization, { ok: false }>['code']; placement?: ActionExecuteFailure;
      /** Private refusing branch for the mint's server diagnostic; never a public code. */
      phase?: string }>;

/**
 * The one admission of a parsed root binding's deployment facts: Link,
 * preparation, registry update and read. Mint runs it once and records the
 * Link and database access decisions it produces. A new root relay runs the
 * same admission. Signed finite effects consume the recorded decisions.
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
    callerAuthority?: ExternalActionBindingAuthorityV1;
  }>,
): Promise<DeploymentRootBindingAdmission> {
  const authentication = {
    authenticationAuthority: 'account_automation' as const,
    ...(input.authenticationEvidence ? { authenticationEvidence: input.authenticationEvidence } : {}),
  };
  let deploymentLinkAdmission: NonNullable<ExternalActionExecutionAuthorizationBindingV1['deploymentLinkAdmission']> | undefined;
  if (binding.actionId === 'deployments.targets.link') {
    if (!input.linkEnvironmentId) return { ok: false, phase: 'link_environment_missing' };
    const admitted = await readDeploymentLinkAdmissionInTx(tx, binding, input.linkEnvironmentId, {
      authenticationAuthority: 'account_automation',
      authenticationEvidence: input.linkAuthenticationEvidence,
    });
    if (!admitted) return { ok: false, phase: 'link_admission' };
    deploymentLinkAdmission = admitted;
  }
  if (!input.workflowAdmitted
    && (isDeploymentPreparationActionIdV1(binding.actionId) || binding.deploymentPreparationAdmission !== undefined)) {
    if (!binding.deploymentPreparationAdmission) return { ok: false, phase: 'preparation_admission_missing' };
    const preparation = await readDeploymentPreparationAuthorizationInTx(tx, binding, binding.deploymentPreparationAdmission, authentication);
    if (!preparation.ok) return { ...preparation, phase: 'preparation' };
  }
  if (binding.registryAppUpdateAdmission && !await readRegistryAppUpdateAuthorizationInTx(tx, binding, authentication)) {
    return { ok: false, phase: 'registry_app_update' };
  }
  const qualifiedRead = binding.actionId === ACTION_INVOKE_ACTION_ID_V1
    && binding.deploymentReadAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1;
  let deploymentDatabaseAccess: ExternalActionExecutionAuthorizationBindingV1['deploymentDatabaseAccess'];
  let deploymentTelemetryRead: ExternalActionExecutionAuthorizationBindingV1['deploymentTelemetryRead'];
  if (isDeploymentReadAdmissionActionIdV1(binding.actionId) || qualifiedRead) {
    if (!binding.deploymentReadAdmission) return { ok: false, phase: 'read_admission_missing' };
    const selected = await readDeploymentReadAuthorizationInTx(tx, binding, binding.deploymentReadAdmission, authentication, input.callerAuthority);
    if (!selected) return { ok: false, phase: 'read_admission' };
    if (!selected.ok) return { ...selected, phase: 'read_authorization' };
    deploymentDatabaseAccess = selected.deploymentDatabaseAccess;
    deploymentTelemetryRead = selected.deploymentTelemetryRead;
  }
  return { ok: true, ...(deploymentLinkAdmission ? { deploymentLinkAdmission } : {}),
    ...(deploymentDatabaseAccess ? { deploymentDatabaseAccess } : {}),
    ...(deploymentTelemetryRead ? { deploymentTelemetryRead } : {}) };
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
  callerAuthority?: ExternalActionBindingAuthorityV1,
): Promise<DeploymentRootBindingAdmission> {
  if (nativeAdmission) {
    const environment = await admitDeploymentNativeRootEnvironmentInTx(tx, root, nativeAdmission, authenticationEvidence);
    if (!environment.ok) return environment;
  }
  const recordedLink = root.deploymentLinkAdmission;
  const admitted = await admitDeploymentRootBindingInTx(tx, root, {
    ...(recordedLink ? { linkEnvironmentId: recordedLink.environmentId } : {}),
    workflowAdmitted: root.workflowActionOrigin !== undefined,
    authenticationEvidence,
    linkAuthenticationEvidence: authenticationEvidence,
    callerAuthority,
  });
  if (!admitted.ok) return admitted;
  if (admitted.deploymentLinkAdmission?.environmentId !== recordedLink?.environmentId) return { ok: false, phase: 'link_environment_changed' };
  const currentAccess = admitted.deploymentDatabaseAccess;
  const recordedAccess = root.deploymentDatabaseAccess;
  if (currentAccess?.policyEnvironmentId !== recordedAccess?.policyEnvironmentId || currentAccess?.agentLevel !== recordedAccess?.agentLevel
    || !sameStrictJsonValue(currentAccess?.summary, recordedAccess?.summary)) return { ok: false, phase: 'database_access_changed', code: 'source_changed' };
  if (root.deploymentTelemetryRead && !sameStrictJsonValue(admitted.deploymentTelemetryRead, root.deploymentTelemetryRead)) {
    return { ok: false, code: 'source_changed' };
  }
  return admitted;
}
