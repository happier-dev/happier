import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { isMap, isSeq, parseDocument } from 'yaml';
import { DeploymentEnvironmentContentPatchV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentContentPatchV1';
import { DeploymentServiceExportV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';

export type PrivateServiceExportSelection = Readonly<{
  key: string; service: string; containerPort: number; scheme: string;
  privateNetwork: string; hostAddress: string; hostPort: number;
}>;

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
  service.set('ports', [...retained, { target: selection.containerPort, published: String(selection.hostPort),
    host_ip: selection.hostAddress, protocol: 'tcp' }]);
  const serviceExports = (content.ownServer?.serviceExports ?? []).filter(entry => entry.key !== selection.key).map(entry => {
    if (entry.exposure !== 'privateNetwork' || !entry.privateNetwork) return invalid();
    return { ...entry, exposure: 'privateNetwork' as const, privateNetwork: entry.privateNetwork };
  });
  serviceExports.push({ key: selection.key, service: selection.service, containerPort: selection.containerPort,
    scheme: selection.scheme, exposure: 'privateNetwork', privateNetwork: selection.privateNetwork });
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
