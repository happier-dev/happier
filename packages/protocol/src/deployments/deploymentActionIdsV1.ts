import type { DeploymentPreparationAdmissionV1 } from './deploymentPreparationAdmissionV1.js';

/** Persisted approval history only; never part of the live Action catalog. */
export const RETIRED_DEPLOYMENT_PUBLISH_ACTION_ID_V1 = 'deployments.publish' as const;

/** The reviewed observer setup consumes only its Link's admitted read scope. */
export const PLATFORM_FAILURE_SETUP_ROLE = 'platform-failure.setup';

export const DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1 = 'deployments.backups.test';
export const DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1 = 'deployments.backups.history';
export const DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1 = 'deployments.backups.inventory';
export const DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 = 'deployments.backups.run';
export const DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 = 'deployments.backups.verify';
export const DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1 = 'deployments.backups.prune';
export const DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 = 'deployments.backups.restore';
export const DEPLOYMENT_BACKUP_ACTION_IDS_V1 = [
  DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1, DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1,
] as const;
export type DeploymentBackupActionIdV1 = typeof DEPLOYMENT_BACKUP_ACTION_IDS_V1[number];
export function isDeploymentBackupActionIdV1(value: string): value is DeploymentBackupActionIdV1 {
  return (DEPLOYMENT_BACKUP_ACTION_IDS_V1 as readonly string[]).includes(value);
}
/** Inventory follows Environment read authority; executing verification retains deploy admission. */
export function isDeploymentBackupInventoryActionIdV1(value: string): value is 'deployments.backups.inventory' {
  return value === DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1;
}
/** Repository inventory and recorded history follow the existing Environment read authority. */
export function isDeploymentBackupReadActionIdV1(value: string): value is 'deployments.backups.inventory' | 'deployments.backups.history' {
  return isDeploymentBackupInventoryActionIdV1(value) || value === DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1;
}

export const DEPLOYMENT_CANCEL_ACTION_ID_V1 = 'deployments.cancel';
export const DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 = 'deployments.publish.prepare';
export const DEPLOYMENT_DEPLOY_ACTION_ID_V1 = 'deployments.deploy';
export const DEPLOYMENT_ROLLBACK_ACTION_ID_V1 = 'deployments.rollback';
export const DEPLOYMENT_TEARDOWN_ACTION_ID_V1 = 'deployments.teardown';
export const DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 = 'deployments.environments.create';
export const DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 = 'deployments.environments.update';
export const DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 = 'deployments.bindings.set';
export const DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1 = 'deployments.receipts.observe';
export const DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 = 'deployments.templates.instantiate';

export const DEPLOYMENT_ACTION_IDS_V1 = [
  'deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify', 'deployments.domains.get', 'deployments.domains.list',
  DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, 'deployments.targets.link', DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1,
  'deployments.environments.controller.set',
  'deployments.targets.unlink', 'deployments.environments.delete',
  'deployments.promote',
  'deployments.restart', DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
  ...DEPLOYMENT_BACKUP_ACTION_IDS_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1,
  DEPLOYMENT_CANCEL_ACTION_ID_V1,
  'deployments.environments.get', 'deployments.receipts.get', DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  'deployments.environments.list', 'deployments.receipts.list', DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1,
  'deployments.observation.get',
  DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1, 'deployments.prepare', DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
  'deployments.health.read', 'deployments.health.current', 'deployments.drift.read', 'deployments.logs.read',
] as const;
export type DeploymentActionIdV1 = typeof DEPLOYMENT_ACTION_IDS_V1[number];
/** Semantic composition/handoff have their own typed ports, never storage HTTP transports. */
export type DeploymentTransportActionIdV1 = Exclude<DeploymentActionIdV1, 'deployments.prepare' | 'deployments.templates.instantiate' | 'deployments.backups.restore' | DeploymentBackupActionIdV1>;
const ids: ReadonlySet<string> = new Set(DEPLOYMENT_ACTION_IDS_V1);
export function isDeploymentActionIdV1(value: string): value is DeploymentActionIdV1 { return ids.has(value); }

export function isDeploymentTargetLinkActionIdV1(value: string): value is 'deployments.targets.link' {
  return value === 'deployments.targets.link';
}

/** Private observation identities require installed requester content custody. */
export function isDeploymentObservationReadActionIdV1(value: string): value is 'deployments.observation.get' {
  return value === 'deployments.observation.get';
}

/** These roots may reuse a Manage-approved definition; the receiving host admits its exact contents. */
export function isStoredDeploymentExecutionActionIdV1(value: string): value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.restart' {
  return value === 'deployments.deploy' || value === 'deployments.rollback' || value === 'deployments.restart';
}

export type DeploymentRootOperationV1 = 'deploy' | 'rollback' | 'promote' | 'teardown';
export function isDeploymentPromoteActionIdV1(value: string): value is 'deployments.promote' {
  return value === 'deployments.promote';
}
/** Native deployment preparation reads use these existing canonical transports. */
export const DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1 = [
  'deployments.environments.get', 'deployments.receipts.list', 'deployments.receipts.get',
] as const;
export type DeploymentDomainChildActionIdV1 = 'deployments.domains.add' | 'deployments.domains.remove' | 'deployments.domains.verify';
export function isDeploymentDomainChildActionIdV1(value: string): value is DeploymentDomainChildActionIdV1 {
  return value === 'deployments.domains.add' || value === 'deployments.domains.remove' || value === 'deployments.domains.verify';
}
export function isDeploymentDomainAddActionIdV1(value: string): value is 'deployments.domains.add' {
  return value === 'deployments.domains.add';
}
export function isDeploymentDomainRemoveActionIdV1(value: string): value is 'deployments.domains.remove' {
  return value === 'deployments.domains.remove';
}
export type DeploymentDomainMetadataReadActionIdV1 = 'deployments.domains.get' | 'deployments.domains.list';
export function isDeploymentDomainMetadataReadActionIdV1(value: string): value is DeploymentDomainMetadataReadActionIdV1 {
  return value === 'deployments.domains.get' || value === 'deployments.domains.list';
}
/** Environment reads retain one Environment without admitting native child effects. */
export function isDeploymentEnvironmentMetadataReadActionIdV1(value: string): value is
  DeploymentDomainMetadataReadActionIdV1 | 'deployments.receipts.get' | 'deployments.receipts.list' | 'deployments.observation.get' {
  return isDeploymentDomainMetadataReadActionIdV1(value)
    || value === 'deployments.receipts.get' || value === 'deployments.receipts.list' || value === 'deployments.observation.get';
}
/** Map native child effects without changing the root's receipt operation. */
export function deploymentChildEffectActionIdForRootV1(value: string, admission?: DeploymentPreparationAdmissionV1,
  requestedEffectActionId?: string):
  DeploymentDomainChildActionIdV1 | 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | undefined {
  if (isDeploymentDomainChildActionIdV1(value)) return value;
  if (value === 'deployments.teardown' && requestedEffectActionId === 'deployments.domains.remove') return requestedEffectActionId;
  if (value === 'deployments.templates.instantiate' && admission?.operation === 'template'
    && admission.mode === 'apply' && admission.deploy !== undefined && requestedEffectActionId === 'deployments.domains.add')
    return requestedEffectActionId;
  if (value === 'deployments.environments.create' && admission?.operation === 'create'
    && admission.mode === 'apply' && admission.catalogApp) return requestedEffectActionId === 'deployments.deploy'
      ? 'deployments.deploy' : 'deployments.domains.add';
  const operation = deploymentOperationForRootActionV1(value, admission);
  return operation ? `deployments.${operation}` as const : undefined;
}
/** A template retains its signed root while spending only its explicit apply/deploy intent. */
export function deploymentOperationForRootActionV1(value: string,
  admission?: DeploymentPreparationAdmissionV1): DeploymentRootOperationV1 | undefined {
  if (value === 'deployments.deploy') return 'deploy';
  if (value === 'deployments.rollback') return 'rollback';
  if (value === 'deployments.promote') return 'promote';
  if (value === 'deployments.teardown') return 'teardown';
  if (value === 'deployments.environments.create' && admission?.operation === 'create'
    && admission.mode === 'apply' && admission.catalogApp) return 'deploy';
  return value === 'deployments.templates.instantiate' && admission?.operation === 'template'
    && admission.mode === 'apply' && admission.deploy !== undefined ? 'deploy' : undefined;
}

/** Intrinsic child Action category, for local operation metadata without a signed root. */
export function isDeploymentChildEffectActionIdV1(value: string):
  value is NonNullable<ReturnType<typeof deploymentChildEffectActionIdForRootV1>> {
  return deploymentChildEffectActionIdForRootV1(value) === value;
}

/** Existing deployment roots whose installed controller may derive finite child work. */
export function isDeploymentChildRootActionIdV1(value: string): value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | DeploymentDomainChildActionIdV1;
export function isDeploymentChildRootActionIdV1(value: string, admission: DeploymentPreparationAdmissionV1 | undefined):
  value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown' | 'deployments.templates.instantiate' | 'deployments.environments.create' | DeploymentDomainChildActionIdV1;
export function isDeploymentChildRootActionIdV1(value: string, admission?: DeploymentPreparationAdmissionV1): boolean {
  return deploymentChildEffectActionIdForRootV1(value, admission) !== undefined;
}

export function isDeploymentReadActionIdV1(value: string): value is
  'deployments.health.current' | 'deployments.health.read' | 'deployments.drift.read' | 'deployments.logs.read' {
  return value === 'deployments.health.current' || isDeploymentNativeReadActionIdV1(value);
}

/** Account-placed deployment roots dispatched through their installed controller, in addition to spec-native Machine Actions. */
export function isDeploymentMachineTransportActionIdV1(value: string): boolean {
  return isDeploymentChildRootActionIdV1(value) || isDeploymentReadActionIdV1(value)
    || value === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || value === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
    || value === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 || isDeploymentTargetLinkActionIdV1(value);
}

export function isDeploymentNativeReadActionIdV1(value: string): value is
  'deployments.health.read' | 'deployments.drift.read' | 'deployments.logs.read' {
  return value === 'deployments.health.read' || value === 'deployments.drift.read' || value === 'deployments.logs.read';
}
