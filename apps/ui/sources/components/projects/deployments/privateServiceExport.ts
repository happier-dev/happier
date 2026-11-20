import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { isMap, isSeq, parseDocument } from 'yaml';
import { DeploymentEnvironmentContentPatchV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentContentPatchV1';
import { DeploymentServiceExportV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { readDeploymentComposeServiceFacts } from './deploymentPreflightWarnings';
import { storedComposeDocumentText } from './storedComposeDocumentText';

/** How other Machines reach the shared service: Happier's own network, or a network this Machine joined. */
export type PrivateServiceExportReach =
  | Readonly<{ kind: 'happierNetwork' }>
  | Readonly<{ kind: 'privateNetwork'; privateNetwork: string; hostAddress: string }>;

export type PrivateServiceExportSelection = Readonly<{
  key: string; service: string; containerPort: number; scheme: string; hostPort?: number; reach: PrivateServiceExportReach;
}>;

type ServiceExport = NonNullable<NonNullable<DeploymentEnvironmentContentV1['ownServer']>['serviceExports']>[number];

/** A private export is shared through a joined network or the Happier network; every surface reads it here. */
export function isPrivateServiceExport(entry: ServiceExport): boolean {
  return entry.exposure === 'privateNetwork' || entry.transport?.kind === 'iroh';
}

export type PrivateServiceExportAuthoring =
  | Readonly<{ kind: 'ready'; machineIds: readonly string[] }>
  | Readonly<{ kind: 'unavailable'; reason: 'platformTarget' | 'readOnly' | 'repository' | 'unsupported' | 'machineMissing' | 'multipleMachines' }>;

/** Authoring consumes the caller's edit decision; network observations belong to the editor. */
export function privateServiceExportAuthoring(
  detail: DeploymentEnvironmentReadDetailV1,
  canEdit: boolean,
): PrivateServiceExportAuthoring {
  // Private sharing publishes a Compose service from a Machine; a platform Environment has none to share.
  if (detail.runtimeTargetLink?.source.kind === 'plugin') return { kind: 'unavailable', reason: 'platformTarget' };
  if (!canEdit) return { kind: 'unavailable', reason: 'readOnly' };
  if (detail.content.definition.kind !== 'stored') return { kind: 'unavailable', reason: 'repository' };
  if (detail.content.ownServer?.serviceExports?.some(entry => !isPrivateServiceExport(entry))) {
    return { kind: 'unavailable', reason: 'unsupported' };
  }
  const runtime = detail.runtimeTargetLink;
  if (runtime?.source.kind !== 'host' || runtime.machines.length === 0) {
    return { kind: 'unavailable', reason: 'machineMissing' };
  }
  if (runtime.machines.length > 1) return { kind: 'unavailable', reason: 'multipleMachines' };
  return { kind: 'ready', machineIds: runtime.machines };
}

const invalid = (): never => { throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' }); };

export function listPrivateServiceExportServices(content: DeploymentEnvironmentContentV1): readonly string[] {
  if (content.definition.kind !== 'stored') return [];
  const document = parseDocument(content.definition.document, { merge: true });
  const services = document.get('services', true);
  if (document.errors.length || !isMap(services)) return [];
  const selected = content.definition.services;
  return services.items.map(item => String(item.key)).filter(name => !selected.length || selected.includes(name));
}

const DATABASE_CONNECTION_SCHEMES = new Map([
  ['postgres', 'postgres'], ['mysql', 'mysql'], ['mariadb', 'mysql'], ['mongo', 'mongodb'], ['redis', 'redis'],
]);
const HTTP_IMAGES = new Set(['nginx', 'httpd', 'caddy']);
const CONVENTIONAL_TCP_SCHEMES = new Map([
  [80, 'http'], [443, 'https'], [3306, 'mysql'], [5432, 'postgres'], [6379, 'redis'], [27017, 'mongodb'],
]);

/** Infer only from declared service facts. An unknown scheme stays editable. */
export function readPrivateServiceSharingScheme(content: DeploymentEnvironmentContentV1, service: string, port: number,
  compose: Awaited<ReturnType<typeof readDeploymentComposeServiceFacts>> | null): string | null {
  const engine = content.template?.data?.find(entry => entry.service === service)?.engine;
  if (engine) return DATABASE_CONNECTION_SCHEMES.get(engine) ?? null;
  const image = compose?.serviceImages.get(service);
  if (image) {
    const official = /^(?:(?:docker\.io\/|index\.docker\.io\/)?library\/)?([a-z0-9_-]+)(?::[^@/]+)?(?:@[^/]+)?$/u.exec(image)?.[1];
    if (official) {
      const database = DATABASE_CONNECTION_SCHEMES.get(official);
      if (database) return database;
      if (HTTP_IMAGES.has(official) && port !== 443) return 'http';
    }
  }
  return compose?.tcpContainerPorts.get(service)?.includes(port) ? CONVENTIONAL_TCP_SCHEMES.get(port) ?? null : null;
}

function publicationTarget(value: unknown): Readonly<{ target: number; protocol: string }> {
  if (typeof value === 'number' || typeof value === 'string') {
    const [ports, protocol = 'tcp'] = String(value).split('/');
    const target = Number(ports?.split(':').at(-1));
    if (!Number.isInteger(target)) return invalid();
    return { target, protocol };
  }
  if (!value || typeof value !== 'object' || !('target' in value)) return invalid();
  const target = Number(value.target);
  if (!Number.isInteger(target)) return invalid();
  return { target, protocol: 'protocol' in value && typeof value.protocol === 'string' ? value.protocol : 'tcp' };
}

function privateExport(entry: ServiceExport) {
  const { key, service, containerPort, scheme } = entry;
  if (entry.transport?.kind === 'iroh' && entry.exposure === 'loopback') {
    return { key, service, containerPort, scheme, exposure: 'loopback' as const, transport: { kind: 'iroh' as const } };
  }
  if (entry.exposure !== 'privateNetwork' || !entry.privateNetwork) return invalid();
  return { ...entry, exposure: 'privateNetwork' as const, privateNetwork: entry.privateNetwork };
}

/** Author the two existing Environment update content operands together. */
export function buildPrivateServiceExportPatch(content: DeploymentEnvironmentContentV1, selection: PrivateServiceExportSelection) {
  const definition = content.definition;
  if (definition.kind !== 'stored') throw Object.assign(new Error('needs_repository'), { code: 'needs_repository' });
  const { hostPort, reach } = selection;
  if (hostPort === undefined && reach.kind === 'privateNetwork') return invalid();
  if (hostPort !== undefined) DeploymentServiceExportV1Schema.shape.containerPort.parse(hostPort);
  const document = parseDocument(definition.document, { merge: true });
  if (document.errors.length || !listPrivateServiceExportServices(content).includes(selection.service)) return invalid();
  const service = document.getIn(['services', selection.service], true);
  if (!isMap(service)) return invalid();
  const ports = service.get('ports', true);
  if (ports !== undefined && !isSeq(ports)) return invalid();
  const currentPorts: unknown[] = ports ? ports.toJSON() : [];
  const retained = currentPorts.filter(value => {
    const port = publicationTarget(value);
    return port.protocol !== 'tcp' || port.target !== selection.containerPort;
  });
  // The Happier network reaches a loopback publication on this Machine; a joined network binds its own address.
  service.set('ports', [...retained, {
    target: selection.containerPort,
    ...(hostPort === undefined ? {} : { published: String(hostPort) }),
    host_ip: reach.kind === 'happierNetwork' ? '127.0.0.1' : reach.hostAddress,
    protocol: 'tcp',
  }]);
  const serviceExports = (content.ownServer?.serviceExports ?? []).filter(entry => entry.key !== selection.key).map(privateExport);
  const shared = { key: selection.key, service: selection.service, containerPort: selection.containerPort, scheme: selection.scheme };
  serviceExports.push(reach.kind === 'happierNetwork'
    ? { ...shared, exposure: 'loopback', transport: { kind: 'iroh' } }
    : { ...shared, exposure: 'privateNetwork', privateNetwork: reach.privateNetwork });
  const patch = {
    definition: { from: 'compose' as const, document: storedComposeDocumentText(document),
      profiles: definition.profiles, services: definition.services,
      ...(definition.primaryService ? { primaryService: definition.primaryService } : {}),
      ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) },
    ownServer: { serviceExports },
  };
  DeploymentEnvironmentContentPatchV1Schema.parse(patch);
  return patch;
}
