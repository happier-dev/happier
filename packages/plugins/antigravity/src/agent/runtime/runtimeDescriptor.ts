import type { ConcreteAntigravityRuntimeMode } from '../lifecycle/runtimeMode.js';

type RuntimeDescriptorEnvelopeV1<TAgentId extends string = string> = Readonly<{
  v: 1;
  agentId: TAgentId;
  agent: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

type AntigravityRuntimeDescriptorAgentExtra = Readonly<{
  owner: 'antigravity';
  schemaId: 'antigravity.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    runtimeMode?: ConcreteAntigravityRuntimeMode;
    providerSessionId?: string;
    agyConversationId?: string;
    localharnessSessionId?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    connectedServiceGroupId?: string;
  }>;
}>;

type AntigravityRuntimeDescriptorAgentPayload = Readonly<{
  runtimeMode?: ConcreteAntigravityRuntimeMode;
  providerSessionId?: string;
  agyConversationId?: string;
  localharnessSessionId?: string;
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  agentExtra?: AntigravityRuntimeDescriptorAgentExtra;
}>;

export type AntigravityRuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: 'antigravity';
  agent: AntigravityRuntimeDescriptorAgentPayload;
} & Record<string, unknown>>;

export type CanonicalAntigravityRuntimeDescriptorV1 = Readonly<{
  agentId: 'antigravity';
  runtimeMode: ConcreteAntigravityRuntimeMode | null;
  providerSessionId: string | null;
  agyConversationId: string | null;
  localharnessSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
}>;

export type BuildAntigravityRuntimeDescriptorV1Params = Readonly<{
  runtimeMode: ConcreteAntigravityRuntimeMode;
  providerSessionId?: string | null;
  agyConversationId?: string | null;
  localharnessSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  connectedServiceGroupId?: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readAgentIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  const hasAgentId = Object.hasOwn(record, 'agentId');
  const hasProviderId = Object.hasOwn(record, 'providerId');
  const agentId = normalizeTrimmedString(record.agentId);
  const providerId = normalizeTrimmedString(record.providerId);
  if ((hasAgentId && !agentId) || (hasProviderId && !providerId)) return null;
  if (agentId && providerId && agentId !== providerId) return null;
  return agentId ?? providerId;
}

function normalizeConcreteRuntimeMode(value: unknown): ConcreteAntigravityRuntimeMode | null {
  const trimmed = normalizeTrimmedString(value);
  return trimmed === 'cliPrint' || trimmed === 'sdk' ? trimmed : null;
}

function normalizeHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
}

function readRuntimeDescriptorV1(value: unknown): RuntimeDescriptorEnvelopeV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1) return null;
  const agentId = readAgentIdCompat(descriptor);
  if (!agentId) return null;
  const rawAgentPayload = asRecord(descriptor.agent) ?? asRecord(descriptor.provider); // legacy `provider` payload-key read-compat
  if (!rawAgentPayload) return null;
  const agentPayload = Object.hasOwn(rawAgentPayload, 'agentExtra')
    ? rawAgentPayload
    : (() => {
      const { providerExtra: legacyExtra, ...rest } = rawAgentPayload; // legacy `providerExtra` read-compat
      return legacyExtra === undefined ? rawAgentPayload : { ...rest, agentExtra: legacyExtra };
    })();
  const {
    providerId: _legacyProviderId,
    provider: _legacyProviderPayload,
    ...canonicalDescriptor
  } = descriptor;
  return {
    ...canonicalDescriptor,
    v: 1,
    agentId,
    agent: agentPayload,
  } as RuntimeDescriptorEnvelopeV1;
}

function readRuntimeDescriptorV1ForAgent<TAgentId extends string>(
  value: unknown,
  agentId: TAgentId,
): RuntimeDescriptorEnvelopeV1<TAgentId> | null {
  const descriptor = readRuntimeDescriptorV1(value);
  return descriptor?.agentId === agentId ? descriptor as RuntimeDescriptorEnvelopeV1<TAgentId> : null;
}

function readMetadataDescriptorInput(metadata: unknown): unknown {
  const record = asRecord(metadata);
  return record?.runtimeDescriptorV1 ?? record?.agentRuntimeDescriptorV1 ?? null;
}

function readAgentExtraRuntimeHandle(value: unknown): Record<string, unknown> | null {
  const extra = asRecord(value);
  if (
    !extra
    || extra.owner !== 'antigravity'
    || extra.schemaId !== 'antigravity.agentRuntimeDescriptorExtra'
    || extra.v !== 1
  ) {
    return null;
  }
  return asRecord(extra.runtimeHandle) ?? null;
}

function buildRuntimeHandle(
  params: BuildAntigravityRuntimeDescriptorV1Params,
): NonNullable<AntigravityRuntimeDescriptorAgentExtra['runtimeHandle']> {
  const providerSessionId = normalizeTrimmedString(params.providerSessionId)
    ?? normalizeTrimmedString(params.agyConversationId)
    ?? normalizeTrimmedString(params.localharnessSessionId);
  return {
    runtimeMode: params.runtimeMode,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(normalizeTrimmedString(params.agyConversationId)
      ? { agyConversationId: normalizeTrimmedString(params.agyConversationId) as string }
      : {}),
    ...(normalizeTrimmedString(params.localharnessSessionId)
      ? { localharnessSessionId: normalizeTrimmedString(params.localharnessSessionId) as string }
      : {}),
    ...(params.home ? { home: params.home } : {}),
    ...(normalizeTrimmedString(params.connectedServiceId)
      ? { connectedServiceId: normalizeTrimmedString(params.connectedServiceId) as string }
      : {}),
    ...(normalizeTrimmedString(params.connectedServiceProfileId)
      ? { connectedServiceProfileId: normalizeTrimmedString(params.connectedServiceProfileId) as string }
      : {}),
    ...(normalizeTrimmedString(params.connectedServiceGroupId)
      ? { connectedServiceGroupId: normalizeTrimmedString(params.connectedServiceGroupId) as string }
      : {}),
  };
}

export function buildAntigravityRuntimeDescriptorV1(
  params: BuildAntigravityRuntimeDescriptorV1Params,
): AntigravityRuntimeDescriptorV1 {
  const runtimeHandle = buildRuntimeHandle(params);
  return {
    v: 1,
    agentId: 'antigravity',
    agent: {
      runtimeMode: params.runtimeMode,
      ...(runtimeHandle.providerSessionId ? { providerSessionId: runtimeHandle.providerSessionId } : {}),
      ...(runtimeHandle.agyConversationId ? { agyConversationId: runtimeHandle.agyConversationId } : {}),
      ...(runtimeHandle.localharnessSessionId ? { localharnessSessionId: runtimeHandle.localharnessSessionId } : {}),
      ...(runtimeHandle.home ? { home: runtimeHandle.home } : {}),
      ...(runtimeHandle.connectedServiceId ? { connectedServiceId: runtimeHandle.connectedServiceId } : {}),
      ...(runtimeHandle.connectedServiceProfileId
        ? { connectedServiceProfileId: runtimeHandle.connectedServiceProfileId }
        : {}),
      ...(runtimeHandle.connectedServiceGroupId
        ? { connectedServiceGroupId: runtimeHandle.connectedServiceGroupId }
        : {}),
      agentExtra: {
        owner: 'antigravity',
        schemaId: 'antigravity.agentRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle,
      },
    },
  };
}

export function readCanonicalAntigravityRuntimeDescriptorV1(
  value: unknown,
): CanonicalAntigravityRuntimeDescriptorV1 | null {
  const descriptor = readRuntimeDescriptorV1ForAgent(value, 'antigravity');
  if (!descriptor) return null;

  const agentPayload = descriptor.agent as AntigravityRuntimeDescriptorAgentPayload & Record<string, unknown>;
  const handle = readAgentExtraRuntimeHandle(agentPayload.agentExtra);
  const runtimeMode = normalizeConcreteRuntimeMode(handle?.runtimeMode)
    ?? normalizeConcreteRuntimeMode(agentPayload.runtimeMode);
  const handleAgyConversationId = normalizeTrimmedString(handle?.agyConversationId);
  const providerAgyConversationId = normalizeTrimmedString(agentPayload.agyConversationId);
  const handleLocalharnessSessionId = normalizeTrimmedString(handle?.localharnessSessionId);
  const providerLocalharnessSessionId = normalizeTrimmedString(agentPayload.localharnessSessionId);
  const agyConversationId = handleAgyConversationId ?? providerAgyConversationId;
  const localharnessSessionId = handleLocalharnessSessionId ?? providerLocalharnessSessionId;
  const providerSessionId = normalizeTrimmedString(handle?.providerSessionId)
    ?? handleAgyConversationId
    ?? handleLocalharnessSessionId
    ?? normalizeTrimmedString(agentPayload.providerSessionId)
    ?? providerAgyConversationId
    ?? providerLocalharnessSessionId;

  return {
    agentId: 'antigravity',
    runtimeMode,
    providerSessionId,
    agyConversationId,
    localharnessSessionId,
    home: normalizeHome(handle?.home) ?? normalizeHome(agentPayload.home),
    connectedServiceId: normalizeTrimmedString(handle?.connectedServiceId)
      ?? normalizeTrimmedString(agentPayload.connectedServiceId),
    connectedServiceProfileId: normalizeTrimmedString(handle?.connectedServiceProfileId)
      ?? normalizeTrimmedString(agentPayload.connectedServiceProfileId),
    connectedServiceGroupId: normalizeTrimmedString(handle?.connectedServiceGroupId)
      ?? normalizeTrimmedString(agentPayload.connectedServiceGroupId),
  };
}

function readLegacyAntigravitySessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CanonicalAntigravityRuntimeDescriptorV1 | null {
  const runtimeMode = normalizeConcreteRuntimeMode(metadataRecord.antigravityRuntimeMode);
  if (!runtimeMode) return null;
  const agyConversationId = normalizeTrimmedString(metadataRecord.agyConversationId)
    ?? normalizeTrimmedString(metadataRecord.antigravityConversationId);
  const localharnessSessionId = normalizeTrimmedString(metadataRecord.localharnessSessionId)
    ?? normalizeTrimmedString(metadataRecord.antigravityLocalharnessSessionId);
  return {
    agentId: 'antigravity',
    runtimeMode,
    providerSessionId: normalizeTrimmedString(metadataRecord.providerSessionId)
      ?? agyConversationId
      ?? localharnessSessionId,
    agyConversationId,
    localharnessSessionId,
    home: normalizeHome(metadataRecord.antigravityRuntimeHome),
    connectedServiceId: normalizeTrimmedString(metadataRecord.connectedServiceId),
    connectedServiceProfileId: normalizeTrimmedString(metadataRecord.connectedServiceProfileId),
    connectedServiceGroupId: normalizeTrimmedString(metadataRecord.connectedServiceGroupId),
  };
}

export function readAntigravitySessionMetadataRuntimeDescriptor(
  metadata: unknown,
): CanonicalAntigravityRuntimeDescriptorV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return readCanonicalAntigravityRuntimeDescriptorV1(readMetadataDescriptorInput(metadataRecord))
    ?? readLegacyAntigravitySessionMetadataRuntimeDescriptor(metadataRecord);
}
