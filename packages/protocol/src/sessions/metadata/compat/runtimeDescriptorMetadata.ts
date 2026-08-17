import {
  RuntimeDescriptorV1Schema,
  writeRuntimeDescriptorV1ForPersistence,
  type RuntimeDescriptorV1,
} from '../runtimeDescriptorV1.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function descriptorValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) =>
        descriptorValuesEqual(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) =>
      Object.hasOwn(rightRecord, key)
      && descriptorValuesEqual(leftRecord[key], rightRecord[key]));
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

/**
 * Projects the canonical Runtime descriptor into the provider-vocabulary
 * descriptor consumed by the supported predecessor. This is a wire-only
 * adapter: current readers normalize the result back to `agentId`/`agent`.
 */
export function projectRuntimeDescriptorV1ForPredecessor(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const descriptor = RuntimeDescriptorV1Schema.parse(value);
  const agent = asRecord(descriptor.agent);
  if (!agent) {
    throw new Error('Invalid canonical runtime descriptor agent payload');
  }
  const {
    agentExtra,
    providerExtra: existingProviderExtra,
    providerSessionId,
    ...agentPayload
  } = agent;
  if (
    agentExtra !== undefined
    && existingProviderExtra !== undefined
    && !descriptorValuesEqual(agentExtra, existingProviderExtra)
  ) {
    throw new Error(
      'Conflicting canonical and predecessor runtime descriptor payloads',
    );
  }
  const {
    agentId,
    agent: _agent,
    agentIdentity: _agentIdentity,
    providerId: _providerId,
    provider: _provider,
    ...descriptorPayload
  } = descriptor;
  return {
    ...descriptorPayload,
    v: 1,
    providerId: agentId,
    provider: {
      ...agentPayload,
      ...(providerSessionId !== undefined
        ? { vendorSessionId: providerSessionId }
        : {}),
      ...(agentExtra !== undefined || existingProviderExtra !== undefined
        ? { providerExtra: agentExtra ?? existingProviderExtra }
        : {}),
    },
  };
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
