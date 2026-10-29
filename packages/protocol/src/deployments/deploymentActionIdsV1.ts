export const DEPLOYMENT_ACTION_IDS_V1 = [
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

/** Existing deployment roots whose installed controller may derive finite child work. */
export function isDeploymentChildRootActionIdV1(value: string): value is 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' {
  return value === 'deployments.deploy' || value === 'deployments.rollback' || value === 'deployments.promote';
}
