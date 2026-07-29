import {
  RuntimeDescriptorV1Schema,
  writeRuntimeDescriptorV1ForPersistence,
  type RuntimeDescriptorV1,
} from '../runtimeDescriptorV1.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type RuntimeDescriptorMetadataCarrier = Readonly<{
  runtimeDescriptorV1?: unknown;
  // Compat-only ingress for older persisted/session transport carriers.
  agentRuntimeDescriptorV1?: unknown;
}>;

export type LegacyAgentRuntimeDescriptorV1 = RuntimeDescriptorV1;

export type WriteRuntimeDescriptorMetadataOptions = Readonly<{
  mirrorLegacyAgentRuntimeDescriptorV1?: boolean;
}>;

// The descriptor schema owns deployed provider-vocabulary read compatibility so
// every wire carrier (metadata, handoff, runtime events, external links) shares
// the same parser. This alias remains for the legacy metadata API surface.
export const LegacyAgentRuntimeDescriptorV1Schema = RuntimeDescriptorV1Schema;

export function readLegacyAgentRuntimeDescriptorV1(value: unknown): RuntimeDescriptorV1 | null {
  const parsed = LegacyAgentRuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readLegacyAgentRuntimeDescriptorV1FromMetadata(metadata: unknown): RuntimeDescriptorV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return readLegacyAgentRuntimeDescriptorV1(metadataRecord.agentRuntimeDescriptorV1);
}

export function readRuntimeDescriptorV1FromMetadata(metadata: unknown): RuntimeDescriptorV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return readLegacyAgentRuntimeDescriptorV1(metadataRecord.runtimeDescriptorV1)
    ?? readLegacyAgentRuntimeDescriptorV1(metadataRecord.agentRuntimeDescriptorV1);
}

export function readRawRuntimeDescriptorV1FromMetadata(metadata: unknown): unknown {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return metadataRecord.runtimeDescriptorV1 ?? metadataRecord.agentRuntimeDescriptorV1 ?? null;
}

export function writeRuntimeDescriptorV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  descriptor: RuntimeDescriptorV1 | null,
  options: WriteRuntimeDescriptorMetadataOptions = {},
): TMetadata & RuntimeDescriptorMetadataCarrier {
  const {
    runtimeDescriptorV1: _runtimeDescriptorV1,
    agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1,
    ...rest
  } = metadata;
  if (!descriptor) {
    return rest as TMetadata & RuntimeDescriptorMetadataCarrier;
  }

  return {
    ...rest,
    runtimeDescriptorV1: writeRuntimeDescriptorV1ForPersistence(descriptor),
    ...(options.mirrorLegacyAgentRuntimeDescriptorV1
      ? { agentRuntimeDescriptorV1: writeRuntimeDescriptorV1ForPersistence(descriptor) }
      : {}),
  } as TMetadata & RuntimeDescriptorMetadataCarrier;
}
