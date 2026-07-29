/**
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export const CODEX_BACKEND_MODES = ['acp', 'appServer'] as const;

export type CodexBackendMode = (typeof CODEX_BACKEND_MODES)[number];

export function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === 'mcp') return 'appServer';
  if (trimmed === 'appServer') return 'appServer';
  if (trimmed === 'acp' || trimmed === 'mcp_resume') return 'acp';
  return null;
}

type CodexRuntimeDescriptorAgentExtra = Readonly<{
  owner: 'codex';
  schemaId: 'codex.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: CodexBackendMode;
    providerSessionId?: string;
    homePath?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    connectedServiceGroupId?: string;
  }>;
  runtimeAffinity?: Readonly<Record<string, unknown>>;
}>;

type CodexAgentRuntimeDescriptorAgentPayload = Readonly<{
  backendMode: CodexBackendMode;
  providerSessionId?: string;
  homePath?: string;
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  agentExtra?: CodexRuntimeDescriptorAgentExtra;
}>;

export type CodexAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: 'codex';
  agent: CodexAgentRuntimeDescriptorAgentPayload;
} & Record<string, unknown>>;

export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{
  agentId: 'codex';
  backendMode: CodexBackendMode | null;
  providerSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
  homePath: string | null;
}>;

export type BuildCodexAgentRuntimeDescriptorParams = Readonly<{
  backendMode: CodexBackendMode;
  providerSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  connectedServiceGroupId?: string | null;
  homePath?: string | null;
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
  return trimmed || null;
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

function readProviderSessionIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(record.providerSessionId)
    ?? normalizeTrimmedString(record.vendorSessionId); // legacy vendorSessionId read-compat
}

function normalizeCodexHome(value: unknown): CanonicalCodexAgentRuntimeDescriptorV1['home'] {
  return value === 'user' || value === 'connectedService' ? value : null;
}

function normalizeCodexConnectedServiceFields(params: Readonly<{
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
  homePath: string | null;
}>): Readonly<{
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
  homePath: string | null;
}> {
  if (params.home === 'connectedService') {
    return {
      connectedServiceId: params.connectedServiceId,
      connectedServiceProfileId: params.connectedServiceProfileId,
      connectedServiceGroupId: params.connectedServiceGroupId,
      homePath: params.homePath,
    };
  }
  return {
    connectedServiceId: null,
    connectedServiceProfileId: null,
    connectedServiceGroupId: null,
    homePath: params.homePath,
  };
}

function buildCodexRuntimeHandleAgentExtra(
  params: BuildCodexAgentRuntimeDescriptorParams,
): CodexRuntimeDescriptorAgentExtra {
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: normalizeTrimmedString(params.connectedServiceId),
    connectedServiceProfileId: normalizeTrimmedString(params.connectedServiceProfileId),
    connectedServiceGroupId: normalizeTrimmedString(params.connectedServiceGroupId),
    homePath: normalizeTrimmedString(params.homePath),
  });
  return {
    owner: 'codex',
    schemaId: 'codex.agentRuntimeDescriptorExtra',
    v: 1,
    runtimeHandle: {
      backendMode: params.backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceFields.connectedServiceId ? { connectedServiceId: connectedServiceFields.connectedServiceId } : {}),
      ...(connectedServiceFields.connectedServiceProfileId
        ? { connectedServiceProfileId: connectedServiceFields.connectedServiceProfileId }
        : {}),
      ...(connectedServiceFields.connectedServiceGroupId
        ? { connectedServiceGroupId: connectedServiceFields.connectedServiceGroupId }
        : {}),
      ...(connectedServiceFields.homePath ? { homePath: connectedServiceFields.homePath } : {}),
    },
  };
}

function readCodexRuntimeHandleCompatCarrier(value: unknown): Record<string, unknown> | null {
  const extra = asRecord(value);
  if (!extra || extra.owner !== 'codex' || extra.schemaId !== 'codex.agentRuntimeDescriptorExtra' || extra.v !== 1) {
    return null;
  }
  return asRecord(extra.runtimeHandle) ?? asRecord(extra.runtimeAffinity);
}

function readCanonicalCodexAgentExtra(value: unknown) {
  const runtimeHandle = readCodexRuntimeHandleCompatCarrier(value);
  if (!runtimeHandle) return null;

  const home = normalizeCodexHome(runtimeHandle.home);
  const connectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: normalizeTrimmedString(runtimeHandle.connectedServiceId),
    connectedServiceProfileId: normalizeTrimmedString(runtimeHandle.connectedServiceProfileId),
    connectedServiceGroupId: normalizeTrimmedString(runtimeHandle.connectedServiceGroupId),
    homePath: normalizeTrimmedString(runtimeHandle.homePath),
  });
  return {
    backendMode: normalizeCodexBackendMode(runtimeHandle.backendMode),
    providerSessionId: readProviderSessionIdCompat(runtimeHandle),
    home,
    ...connectedServiceFields,
  };
}

export function readCodexAgentRuntimeDescriptorV1(value: unknown): CodexAgentRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || readAgentIdCompat(descriptor) !== 'codex') return null;
  const rawAgentPayload = asRecord(descriptor.agent) ?? asRecord(descriptor.provider); // legacy `provider` payload-key read-compat
  if (!rawAgentPayload) return null;
  const backendMode = normalizeCodexBackendMode(rawAgentPayload.backendMode);
  if (!backendMode) return null;
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
    agentId: 'codex',
    agent: {
      ...agentPayload,
      backendMode,
    },
  } as CodexAgentRuntimeDescriptorV1;
}

export function buildCodexAgentRuntimeDescriptorV1(
  params: BuildCodexAgentRuntimeDescriptorParams,
): CodexAgentRuntimeDescriptorV1 {
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: normalizeTrimmedString(params.connectedServiceId),
    connectedServiceProfileId: normalizeTrimmedString(params.connectedServiceProfileId),
    connectedServiceGroupId: normalizeTrimmedString(params.connectedServiceGroupId),
    homePath: normalizeTrimmedString(params.homePath),
  });

  return {
    v: 1,
    agentId: 'codex',
    agent: {
      backendMode: params.backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceFields.connectedServiceId ? { connectedServiceId: connectedServiceFields.connectedServiceId } : {}),
      ...(connectedServiceFields.connectedServiceProfileId
        ? { connectedServiceProfileId: connectedServiceFields.connectedServiceProfileId }
        : {}),
      ...(connectedServiceFields.connectedServiceGroupId
        ? { connectedServiceGroupId: connectedServiceFields.connectedServiceGroupId }
        : {}),
      ...(connectedServiceFields.homePath ? { homePath: connectedServiceFields.homePath } : {}),
      agentExtra: buildCodexRuntimeHandleAgentExtra({
        ...params,
        providerSessionId,
        home,
        ...connectedServiceFields,
      }),
    },
  };
}

export const buildCodexAgentRuntimeDescriptor = buildCodexAgentRuntimeDescriptorV1;

export function readCanonicalCodexAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalCodexAgentRuntimeDescriptorV1 | null {
  const descriptor = readCodexAgentRuntimeDescriptorV1(value);
  if (!descriptor) return null;
  const agentExtra = readCanonicalCodexAgentExtra(descriptor.agent.agentExtra);
  const home = agentExtra?.home ?? normalizeCodexHome(descriptor.agent.home);
  const connectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: agentExtra?.connectedServiceId ?? normalizeTrimmedString(descriptor.agent.connectedServiceId),
    connectedServiceProfileId:
      agentExtra?.connectedServiceProfileId ?? normalizeTrimmedString(descriptor.agent.connectedServiceProfileId),
    connectedServiceGroupId:
      agentExtra?.connectedServiceGroupId ?? normalizeTrimmedString(descriptor.agent.connectedServiceGroupId),
    homePath: agentExtra?.homePath ?? normalizeTrimmedString(descriptor.agent.homePath),
  });

  return {
    agentId: 'codex',
    backendMode: agentExtra?.backendMode ?? normalizeCodexBackendMode(descriptor.agent.backendMode),
    providerSessionId: agentExtra?.providerSessionId ?? readProviderSessionIdCompat(descriptor.agent),
    home,
    ...connectedServiceFields,
  };
}

export function readStrictCanonicalCodexAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalCodexAgentRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (
    !descriptor
    || !hasOnlyKeys(
      descriptor,
      new Set(['v', 'agentId', 'providerId', 'agent', 'provider']),
    )
  ) {
    return null;
  }
  const payload = asRecord(descriptor.agent) ?? asRecord(descriptor.provider);
  if (
    !payload
    || !hasOnlyKeys(
      payload,
      new Set([
        'backendMode',
        'providerSessionId',
        'vendorSessionId',
        'homePath',
        'home',
        'connectedServiceId',
        'connectedServiceProfileId',
        'connectedServiceGroupId',
        'agentExtra',
        'providerExtra',
      ]),
    )
  ) {
    return null;
  }
  const extraInput = payload.agentExtra ?? payload.providerExtra;
  if (extraInput !== undefined) {
    const extra = asRecord(extraInput);
    if (
      !extra
      || !hasOnlyKeys(
        extra,
        new Set(['owner', 'schemaId', 'v', 'runtimeHandle', 'runtimeAffinity']),
      )
      || extra.owner !== 'codex'
      || extra.schemaId !== 'codex.agentRuntimeDescriptorExtra'
      || extra.v !== 1
    ) {
      return null;
    }
    const carrierInput = extra.runtimeHandle ?? extra.runtimeAffinity;
    if (carrierInput !== undefined) {
      const carrier = asRecord(carrierInput);
      if (
        !carrier
        || !hasOnlyKeys(
          carrier,
          new Set([
            'backendMode',
            'providerSessionId',
            'vendorSessionId',
            'homePath',
            'home',
            'connectedServiceId',
            'connectedServiceProfileId',
            'connectedServiceGroupId',
          ]),
        )
      ) {
        return null;
      }
    }
  }
  return readCanonicalCodexAgentRuntimeDescriptorV1(value);
}
