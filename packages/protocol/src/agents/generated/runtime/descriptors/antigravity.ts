/**
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export type AntigravityRuntimeDescriptorModeV1 = 'cliPrint' | 'sdk';

type AntigravityRuntimeDescriptorAgentExtra = Readonly<{
  owner: 'antigravity';
  schemaId: 'antigravity.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    runtimeMode?: AntigravityRuntimeDescriptorModeV1;
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
  runtimeMode?: AntigravityRuntimeDescriptorModeV1;
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
  runtimeMode: AntigravityRuntimeDescriptorModeV1 | null;
  providerSessionId: string | null;
  agyConversationId: string | null;
  localharnessSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
}>;

export type BuildAntigravityRuntimeDescriptorV1Params = Readonly<{
  runtimeMode: AntigravityRuntimeDescriptorModeV1;
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

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeConcreteRuntimeMode(value: unknown): AntigravityRuntimeDescriptorModeV1 | null {
  const trimmed = normalizeTrimmedString(value);
  return trimmed === 'cliPrint' || trimmed === 'sdk' ? trimmed : null;
}

function normalizeHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
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
  const descriptor = asRecord(value);
  if (
    !descriptor
    || descriptor.v !== 1
    || descriptor.agentId !== 'antigravity'
    || Object.hasOwn(descriptor, 'providerId')
    || Object.hasOwn(descriptor, 'provider')
  ) return null;

  const agentPayload = asRecord(descriptor.agent) as
    | (AntigravityRuntimeDescriptorAgentPayload & Record<string, unknown>)
    | null;
  if (!agentPayload) return null;
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

export function readStrictCanonicalAntigravityRuntimeDescriptorV1(
  value: unknown,
): CanonicalAntigravityRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || !hasOnlyKeys(descriptor, new Set(['v', 'agentId', 'agent']))) return null;
  const agent = asRecord(descriptor.agent);
  if (
    !agent
    || !hasOnlyKeys(agent, new Set([
      'runtimeMode',
      'providerSessionId',
      'agyConversationId',
      'localharnessSessionId',
      'home',
      'connectedServiceId',
      'connectedServiceProfileId',
      'connectedServiceGroupId',
      'agentExtra',
    ]))
  ) return null;

  if (agent.agentExtra !== undefined) {
    const extra = asRecord(agent.agentExtra);
    if (
      !extra
      || !hasOnlyKeys(extra, new Set(['owner', 'schemaId', 'v', 'runtimeHandle']))
      || extra.owner !== 'antigravity'
      || extra.schemaId !== 'antigravity.agentRuntimeDescriptorExtra'
      || extra.v !== 1
    ) return null;
    if (extra.runtimeHandle !== undefined) {
      const runtimeHandle = asRecord(extra.runtimeHandle);
      if (
        !runtimeHandle
        || !hasOnlyKeys(runtimeHandle, new Set([
          'runtimeMode',
          'providerSessionId',
          'agyConversationId',
          'localharnessSessionId',
          'home',
          'connectedServiceId',
          'connectedServiceProfileId',
          'connectedServiceGroupId',
        ]))
      ) return null;
    }
  }
  return readCanonicalAntigravityRuntimeDescriptorV1(descriptor);
}
