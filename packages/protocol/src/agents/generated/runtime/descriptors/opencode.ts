/**
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export type OpenCodeBackendMode = 'server' | 'acp';

type RuntimeDescriptorAgentExtra = Readonly<{
  owner: 'opencode';
  schemaId: 'opencode.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: OpenCodeBackendMode;
    providerSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
  }>;
}>;

export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: 'opencode';
  agent: Readonly<{
    backendMode: OpenCodeBackendMode;
    providerSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
    agentExtra: RuntimeDescriptorAgentExtra;
  }>;
} & Record<string, unknown>>;

export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  agentId: 'opencode';
  backendMode: OpenCodeBackendMode;
  providerSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

export type BuildOpenCodeAgentRuntimeDescriptorParams = Readonly<{
  backendMode?: OpenCodeBackendMode | null;
  providerSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean | string | null;
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

export function normalizeOpenCodeBackendMode(raw: unknown): OpenCodeBackendMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'acp' ? 'acp' : 'server';
}

function normalizeOptionalOpenCodeBackendMode(raw: unknown): OpenCodeBackendMode | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'acp' || value === 'server') return value;
  return null;
}

export function normalizeOpenCodeServerBaseUrl(raw: unknown): string | null {
  const value = normalizeTrimmedString(raw);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'http:') {
      const hostname = parsed.hostname.trim().toLowerCase();
      const isLoopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]';
      if (!isLoopback) return null;
    }
    return parsed.origin.endsWith('/') ? parsed.origin : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export function normalizeOpenCodeServerBaseUrlExplicit(raw: unknown): boolean {
  if (raw === true) return true;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === '1' || value === 'true' || value === 'yes';
}

function buildOpenCodeRuntimeDescriptorAgentExtra(params: BuildOpenCodeAgentRuntimeDescriptorParams): RuntimeDescriptorAgentExtra {
  const backendMode = normalizeOpenCodeBackendMode(params.backendMode);
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const requestedServerBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = requestedServerBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const serverBaseUrlExplicit = Boolean(serverBaseUrl && requestedServerBaseUrlExplicit);

  return {
    owner: 'opencode',
    schemaId: 'opencode.agentRuntimeDescriptorExtra',
    v: 1,
    runtimeHandle: {
      backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
    },
  };
}

function readOpenCodeRuntimeDescriptorAgentExtra(value: unknown): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  const extra = asRecord(value);
  if (!extra || extra.owner !== 'opencode' || extra.schemaId !== 'opencode.agentRuntimeDescriptorExtra' || extra.v !== 1) {
    return null;
  }

  const runtimeHandle = asRecord(extra.runtimeHandle);
  if (!runtimeHandle) return null;

  const backendMode = normalizeOptionalOpenCodeBackendMode(runtimeHandle.backendMode);
  const providerSessionId = readProviderSessionIdCompat(runtimeHandle);
  const serverBaseUrl = normalizeOpenCodeServerBaseUrl(runtimeHandle.serverBaseUrl);
  const serverBaseUrlExplicit = serverBaseUrl
    ? normalizeOpenCodeServerBaseUrlExplicit(runtimeHandle.serverBaseUrlExplicit)
    : false;

  if (!backendMode && !providerSessionId && !serverBaseUrl) return null;
  return {
    agentId: 'opencode',
    backendMode: backendMode ?? 'server',
    providerSessionId,
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}

function readOpenCodeRuntimeDescriptorV1(value: unknown): OpenCodeAgentRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || readAgentIdCompat(descriptor) !== 'opencode') return null;
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
    agentId: 'opencode',
    agent: agentPayload,
  } as OpenCodeAgentRuntimeDescriptorV1;
}

export function buildOpenCodeAgentRuntimeDescriptorV1(
  params: BuildOpenCodeAgentRuntimeDescriptorParams,
): OpenCodeAgentRuntimeDescriptorV1 {
  const backendMode = normalizeOpenCodeBackendMode(params.backendMode);
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const requestedServerBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = requestedServerBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const serverBaseUrlExplicit = Boolean(serverBaseUrl && requestedServerBaseUrlExplicit);

  return {
    v: 1,
    agentId: 'opencode',
    agent: {
      backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      agentExtra: buildOpenCodeRuntimeDescriptorAgentExtra({
        backendMode,
        providerSessionId,
        serverBaseUrl,
        serverBaseUrlExplicit,
      }),
    },
  };
}

export const buildOpenCodeAgentRuntimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1;
export const buildOpenCodeRuntimeIdentityDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1;

export function readCanonicalOpenCodeAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  const descriptor = readOpenCodeRuntimeDescriptorV1(value);
  if (!descriptor) return null;
  const agentPayload = descriptor.agent;

  const agentExtra = readOpenCodeRuntimeDescriptorAgentExtra(agentPayload.agentExtra);
  const backendMode = agentExtra?.backendMode ?? normalizeOptionalOpenCodeBackendMode(agentPayload.backendMode) ?? 'server';
  const providerSessionId = agentExtra?.providerSessionId ?? readProviderSessionIdCompat(agentPayload);
  const payloadServerBaseUrl = normalizeOpenCodeServerBaseUrl(agentPayload.serverBaseUrl);
  const payloadServerBaseUrlExplicit = payloadServerBaseUrl
    ? normalizeOpenCodeServerBaseUrlExplicit(agentPayload.serverBaseUrlExplicit)
    : false;
  const serverBaseUrl = agentExtra?.serverBaseUrl ?? payloadServerBaseUrl;
  const serverBaseUrlExplicit = serverBaseUrl
    ? (agentExtra?.serverBaseUrl ? agentExtra.serverBaseUrlExplicit : payloadServerBaseUrlExplicit)
    : false;

  return {
    agentId: 'opencode',
    backendMode,
    providerSessionId,
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}

export function readStrictCanonicalOpenCodeAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
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
        'serverBaseUrl',
        'serverBaseUrlExplicit',
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
        new Set(['owner', 'schemaId', 'v', 'runtimeHandle']),
      )
      || extra.owner !== 'opencode'
      || extra.schemaId !== 'opencode.agentRuntimeDescriptorExtra'
      || extra.v !== 1
    ) {
      return null;
    }
    if (extra.runtimeHandle !== undefined) {
      const carrier = asRecord(extra.runtimeHandle);
      if (
        !carrier
        || !hasOnlyKeys(
          carrier,
          new Set([
            'backendMode',
            'providerSessionId',
            'vendorSessionId',
            'serverBaseUrl',
            'serverBaseUrlExplicit',
          ]),
        )
      ) {
        return null;
      }
    }
  }
  return readCanonicalOpenCodeAgentRuntimeDescriptorV1(value);
}
