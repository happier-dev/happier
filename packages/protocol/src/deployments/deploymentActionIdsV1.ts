import type { DeploymentPreparationAdmissionV1 } from './deploymentPreparationAdmissionV1.js';
export const DEPLOYMENT_ACTION_IDS_V1 = [
  'deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify', 'deployments.domains.get', 'deployments.domains.list',
  'deployments.environments.create', 'deployments.environments.update', 'deployments.targets.link', 'deployments.deploy', 'deployments.rollback',
  'deployments.environments.controller.set',
  'deployments.targets.unlink', 'deployments.environments.delete',
  'deployments.promote',
  'deployments.teardown',
  'deployments.cancel',
  'deployments.environments.get', 'deployments.receipts.get', 'deployments.bindings.set',
  'deployments.environments.list', 'deployments.receipts.list',
  'deployments.publish', 'deployments.publish.prepare', 'deployments.prepare', 'deployments.templates.instantiate',
  'deployments.health.read', 'deployments.drift.read', 'deployments.logs.read',
] as const;
export type DeploymentActionIdV1 = typeof DEPLOYMENT_ACTION_IDS_V1[number];
/** Semantic composition/handoff have their own typed ports, never storage HTTP transports. */
export type DeploymentTransportActionIdV1 = Exclude<DeploymentActionIdV1, 'deployments.publish' | 'deployments.prepare' | 'deployments.templates.instantiate'>;
const ids: ReadonlySet<string> = new Set(DEPLOYMENT_ACTION_IDS_V1);
export function isDeploymentActionIdV1(value: string): value is DeploymentActionIdV1 { return ids.has(value); }

export type DeploymentRootOperationV1 = 'deploy' | 'rollback' | 'promote' | 'teardown';
export type DeploymentDomainChildActionIdV1 = 'deployments.domains.add' | 'deployments.domains.remove' | 'deployments.domains.verify';
export function isDeploymentDomainChildActionIdV1(value: string): value is DeploymentDomainChildActionIdV1 {
  return value === 'deployments.domains.add' || value === 'deployments.domains.remove' || value === 'deployments.domains.verify';
}
/** Domain effects retain their own root; they are never deployment receipt operations. */
export function deploymentChildEffectActionIdForRootV1(value: string, admission?: DeploymentPreparationAdmissionV1):
  DeploymentDomainChildActionIdV1 | 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | undefined {
  if (isDeploymentDomainChildActionIdV1(value)) return value;
  if (value === 'deployments.environments.create' && admission?.operation === 'create'
    && admission.mode === 'apply' && admission.catalogApp) return 'deployments.domains.add';
  const operation = deploymentOperationForRootActionV1(value, admission);
  return operation && operation !== 'teardown' ? `deployments.${operation}` as const : undefined;
}
/** A template retains its signed root while spending only its explicit apply/deploy intent. */
export function deploymentOperationForRootActionV1(value: string,
  admission?: DeploymentPreparationAdmissionV1): DeploymentRootOperationV1 | undefined {
  if (value === 'deployments.deploy') return 'deploy';
  if (value === 'deployments.rollback') return 'rollback';
  if (value === 'deployments.promote') return 'promote';
  if (value === 'deployments.teardown') return 'teardown';
  if (value === 'deployments.publish' && admission?.operation === 'publish') return 'deploy';
  return value === 'deployments.templates.instantiate' && admission?.operation === 'template'
    && admission.mode === 'apply' && admission.deploy !== undefined ? 'deploy' : undefined;
}

/** Existing deployment roots whose installed controller may derive finite child work. */
export function isDeploymentChildRootActionIdV1(value: string): value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | DeploymentDomainChildActionIdV1;
export function isDeploymentChildRootActionIdV1(value: string, admission: DeploymentPreparationAdmissionV1 | undefined):
  value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.templates.instantiate' | 'deployments.publish' | 'deployments.environments.create' | DeploymentDomainChildActionIdV1;
export function isDeploymentChildRootActionIdV1(value: string, admission?: DeploymentPreparationAdmissionV1): boolean {
  return deploymentChildEffectActionIdForRootV1(value, admission) !== undefined;
}
