import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentDomainReadItemV1, DeploymentDomainReadPageV1 } from '@happier-dev/deployments';
import { deploymentEnvironmentRoute } from './deploymentNavigation';

type Domain = Pick<DeploymentDomainReadItemV1, 'content' | 'title'> & Readonly<{ domain: Pick<DeploymentDomainReadItemV1['domain'], 'id'> }>;
export type ConnectionDomains = Readonly<{ status: 'loading' | 'ready' | 'empty' | 'unavailable' | 'denied';
  items: readonly Domain[]; reason?: string }> & Partial<Pick<DeploymentDomainReadPageV1, 'coverage' | 'hasNextPage'>>;
export type DeploymentConnection = Readonly<{
  kind: 'database' | 'volume' | 'domain' | 'reference'; id: string; service: string | null;
  /** Resource identity/declaration only; never a credential value or inferred reachability. */
  resource: string; source: Readonly<{ kind: 'environment' | 'service'; id: string }>;
  configure: ReturnType<typeof deploymentEnvironmentRoute>;
  targetEnvironmentId?: string; export?: string; via?: string;
}>;

/** A read projection of P40/P45 declarations, using the same database keys and configuration destinations.
 * No Compose parsing, secret inspection, connectivity check or additional read belongs here. */
export function projectDeploymentConnections(detail: DeploymentEnvironmentDetailV1, domains: ConnectionDomains) {
  const environment = detail.environment;
  const address = { serverId: environment.serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id };
  const source = { kind: 'environment', id: environment.id } as const;
  const items: DeploymentConnection[] = [];
  for (const data of detail.content.template?.data ?? []) items.push({ kind: 'database', id: data.service,
    service: data.service, resource: data.engine, source, configure: deploymentEnvironmentRoute({ ...address, database: data.service }) });
  for (const link of detail.targetLinks) if (link.targetLink.role === 'data') items.push({ kind: 'database', id: link.targetLink.id,
    service: null, resource: link.content?.data?.engine ?? link.targetLink.targetKind, source,
    configure: deploymentEnvironmentRoute({ ...address, database: link.targetLink.id }) });
  for (const volume of detail.content.template?.volumes ?? []) items.push({ kind: 'volume', id: volume.id,
    service: volume.service, resource: volume.target, source: { kind: 'service', id: volume.service },
    configure: deploymentEnvironmentRoute({ ...address, tab: 'settings' }) });
  for (const domain of domains.items) if (domain.content.hostname) items.push({ kind: 'domain', id: domain.domain.id,
    service: domain.content.target.service ?? null, resource: domain.content.hostname,
    source: domain.content.target.service ? { kind: 'service', id: domain.content.target.service } : source,
    configure: deploymentEnvironmentRoute({ ...address, tab: 'domains' }) });
  for (const binding of detail.content.bindings) if (binding.purpose === 'variable' && binding.source.kind === 'reference') {
    items.push({ kind: 'reference', id: binding.phase + ':' + binding.name, service: null, resource: binding.source.export, source,
      targetEnvironmentId: binding.source.environmentId, export: binding.source.export, via: binding.source.via,
      configure: deploymentEnvironmentRoute({ ...address, tab: 'variables' }) });
  }
  const declarations = detail.content.template ? 'known' : 'unknown';
  const status = domains.status === 'loading' && items.length === 0 ? 'loading'
    : declarations === 'unknown' || domains.coverage === 'partial' || domains.hasNextPage === true || !['ready', 'empty'].includes(domains.status) ? 'partial'
    : items.length === 0 ? 'empty' : 'ready';
  return { status, items, declarations, domains: { status: domains.status, reason: domains.reason ?? null, coverage: domains.coverage, hasNextPage: domains.hasNextPage } } as const;
}
