import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { isMap, isSeq, parseDocument } from 'yaml';
import { DeploymentEnvironmentContentPatchV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentContentPatchV1';
import { DeploymentServiceExportV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';

/** How other Machines reach the shared service: Happier's own network, or a network this Machine joined. */
export type PrivateServiceExportReach =
  | Readonly<{ kind: 'happierNetwork' }>
  | Readonly<{ kind: 'privateNetwork'; privateNetwork: string; hostAddress: string }>;

export type PrivateServiceExportSelection = Readonly<{
  key: string; service: string; containerPort: number; scheme: string; hostPort: number; reach: PrivateServiceExportReach;
}>;

type ServiceExport = NonNullable<NonNullable<DeploymentEnvironmentContentV1['ownServer']>['serviceExports']>[number];

/**
 * Whether people can choose the Happier network when sharing. It stays pending until NET-FWD-1110's native-transport
 * and security validation passes (O-DEPLOY 2026-11-10 08:36Z); until then the sheet shows it as not yet available and
 * shares only through joined networks. Saved Happier network exports are listed and kept either way.
 */
export const HAPPIER_NETWORK_SHARING_READY: boolean = false;

/** A private export is shared through a joined network or the Happier network; every surface reads it here. */
export function isPrivateServiceExport(entry: ServiceExport): boolean {
  return entry.exposure === 'privateNetwork' || entry.transport?.kind === 'iroh';
}

export type PrivateServiceExportAuthoring =
  | Readonly<{ kind: 'ready'; machineIds: readonly string[] }>
  | Readonly<{ kind: 'unavailable'; reason: 'readOnly' | 'repository' | 'unsupported' | 'machineMissing' | 'multipleMachines' }>;

/** Authoring consumes the caller's edit decision; network observations belong to the editor. */
export function privateServiceExportAuthoring(
  detail: DeploymentEnvironmentReadDetailV1,
  canEdit: boolean,
): PrivateServiceExportAuthoring {
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
  DeploymentServiceExportV1Schema.shape.containerPort.parse(selection.hostPort);
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
  const reach = selection.reach;
  service.set('ports', [...retained, { target: selection.containerPort, published: String(selection.hostPort),
    host_ip: reach.kind === 'happierNetwork' ? '127.0.0.1' : reach.hostAddress, protocol: 'tcp' }]);
  const serviceExports = (content.ownServer?.serviceExports ?? []).filter(entry => entry.key !== selection.key).map(privateExport);
  const shared = { key: selection.key, service: selection.service, containerPort: selection.containerPort, scheme: selection.scheme };
  serviceExports.push(reach.kind === 'happierNetwork'
    ? { ...shared, exposure: 'loopback', transport: { kind: 'iroh' } }
    : { ...shared, exposure: 'privateNetwork', privateNetwork: reach.privateNetwork });
  const patch = {
    definition: { from: 'compose' as const, document: document.toString(),
      profiles: definition.profiles, services: definition.services,
      ...(definition.primaryService ? { primaryService: definition.primaryService } : {}),
      ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) },
    ownServer: { serviceExports },
  };
  DeploymentEnvironmentContentPatchV1Schema.parse(patch);
  return patch;
}
