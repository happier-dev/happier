import type { AcpRuntimeDefinition } from './_types';

export function assertAcpRuntimeDefinitionSupported(definition: AcpRuntimeDefinition): void {
  if (definition.messageMeta?.enrichIncoming) {
    throw new Error(`ACP backend '${definition.backendId}' declares messageMeta.enrichIncoming, but A.15.2 runtimeCore cannot transform incoming ACP messages yet.`);
  }
}
