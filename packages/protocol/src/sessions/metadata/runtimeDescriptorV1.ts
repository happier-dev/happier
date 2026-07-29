import { z } from 'zod';
import { getGeneratedRuntimeDescriptorContributionV1 } from '../../agents/runtimeDescriptorContributionsV1.js';
import {
  PluginContributionIdentityV1Schema,
  resolveAgentIdFromPersistedContributionIdentityV1,
  resolvePersistedContributionIdentityV1FromAgentId,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';

type RuntimeDescriptorAgentShape = Readonly<Record<string, unknown>>;

export type RuntimeDescriptorAgentExtraV1 = Readonly<{
  owner: string;
  schemaId: string;
  v: number;
} & Record<string, unknown>>;

export type RuntimeDescriptorEnvelopeV1<
  TAgentId extends string = string,
  TAgent extends RuntimeDescriptorAgentShape = RuntimeDescriptorAgentShape,
> = Readonly<{
  v: 1;
  agentId: TAgentId;
  agent: TAgent;
} & Record<string, unknown>>;

export type RuntimeDescriptorV1 = RuntimeDescriptorEnvelopeV1;
export type PersistedRuntimeDescriptorV1 =
  | RuntimeDescriptorV1
  | Readonly<{
      v: 1;
      agentIdentity: PluginContributionIdentityV1;
      agent: RuntimeDescriptorAgentShape;
    } & Record<string, unknown>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeLegacyRuntimeDescriptorPayloadKeys(record: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(record, 'provider')) return record;
  const { provider: legacyPayload, ...rest } = record;
  if (Object.hasOwn(record, 'agent')) return rest;
  const payloadRecord = asRecord(legacyPayload);
  if (!payloadRecord) return { ...rest, agent: legacyPayload };
  if (!Object.hasOwn(payloadRecord, 'providerExtra')) return { ...rest, agent: payloadRecord };
  const { providerExtra: legacyExtra, ...payloadRest } = payloadRecord;
  const agentPayload = Object.hasOwn(payloadRecord, 'agentExtra')
    ? payloadRest
    : { ...payloadRest, agentExtra: legacyExtra };
  return { ...rest, agent: agentPayload };
}

function normalizeDeployedRuntimeDescriptorV1(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;

  const hasAgentIdentity = Object.hasOwn(record, 'agentIdentity');
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const agentId = typeof record.agentId === 'string' && record.agentId.trim()
    ? record.agentId.trim()
    : null;
  const agentIdentity = hasAgentIdentity
    ? PluginContributionIdentityV1Schema.safeParse(record.agentIdentity)
    : null;
  if (hasAgentIdentity && !agentIdentity?.success) return undefined;
  const identityAgentId = agentIdentity?.success
    ? resolveAgentIdFromPersistedContributionIdentityV1(agentIdentity.data)
    : null;
  if (hasAgentIdentity && !identityAgentId) return undefined;
  if (identityAgentId && agentId && identityAgentId !== agentId) return undefined;

  const {
    agentIdentity: _persistedAgentIdentity,
    ...withoutAgentIdentity
  } = record;
  const identityNormalized = identityAgentId
    ? { ...withoutAgentIdentity, agentId: identityAgentId }
    : withoutAgentIdentity;
  if (!hasProviderId) {
    return normalizeLegacyRuntimeDescriptorPayloadKeys(identityNormalized);
  }

  const providerId = typeof record.providerId === 'string' && record.providerId.trim()
    ? record.providerId.trim()
    : null;
  const normalizedAgentId = identityAgentId ?? agentId;
  if (!providerId || ((hasAgentId || hasAgentIdentity) && (!normalizedAgentId || normalizedAgentId !== providerId))) {
    return undefined;
  }

  const { providerId: _legacyProviderId, ...canonical } = identityNormalized;
  return normalizeLegacyRuntimeDescriptorPayloadKeys({
    ...canonical,
    agentId: normalizedAgentId ?? providerId,
  });
}

function createRuntimeDescriptorAgentSchema(zod: typeof z) {
  return zod.object({
    agentExtra: createRuntimeDescriptorAgentExtraV1Schema(zod).optional(),
  }).passthrough();
}

function createRuntimeDescriptorAgentExtraV1Schema(zod: typeof z) {
  return zod.object({
    owner: zod.string().min(1),
    schemaId: zod.string().min(1),
    v: zod.number().int().min(1),
  }).passthrough();
}

export function createRuntimeDescriptorV1Schema(zod: typeof z) {
  return zod.preprocess(
    normalizeDeployedRuntimeDescriptorV1,
    zod.object({
      v: zod.literal(1),
      agentId: zod.string().min(1),
      agent: createRuntimeDescriptorAgentSchema(zod),
    }).passthrough(),
  );
}

export const RuntimeDescriptorV1Schema = createRuntimeDescriptorV1Schema(z);

export function readRuntimeDescriptorV1(value: unknown): RuntimeDescriptorV1 | null {
  const parsed = RuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function writeRuntimeDescriptorV1ForPersistence(
  value: RuntimeDescriptorV1,
): PersistedRuntimeDescriptorV1 {
  const descriptor = RuntimeDescriptorV1Schema.parse(value);
  const identity = resolvePersistedContributionIdentityV1FromAgentId(descriptor.agentId);
  if (!identity) return descriptor;
  const {
    agentId: _runtimeAgentId,
    ...rest
  } = descriptor;
  return {
    ...rest,
    agentIdentity: identity,
  };
}

export function readRuntimeDescriptorV1ForAgent<TAgentId extends string>(
  value: unknown,
  agentId: TAgentId,
): RuntimeDescriptorEnvelopeV1<TAgentId> | null;
export function readRuntimeDescriptorV1ForAgent<TAgentId extends string>(
  value: unknown,
  agentId: TAgentId,
): RuntimeDescriptorEnvelopeV1<TAgentId> | null {
  const parsed = readRuntimeDescriptorV1(value);
  return parsed?.agentId === agentId ? parsed as RuntimeDescriptorEnvelopeV1<TAgentId> : null;
}

export function readCanonicalRuntimeDescriptorV1ForAgent(
  value: unknown,
  agentId: string,
): Readonly<Record<string, unknown>> | null;
export function readCanonicalRuntimeDescriptorV1ForAgent(
  value: unknown,
  agentId: string,
) {
  const contribution = getGeneratedRuntimeDescriptorContributionV1(agentId);
  if (!contribution) return null;
  const descriptor = readRuntimeDescriptorV1ForAgent(value, agentId);
  return contribution.readCanonicalDescriptor(descriptor) as Readonly<Record<string, unknown>> | null;
}
