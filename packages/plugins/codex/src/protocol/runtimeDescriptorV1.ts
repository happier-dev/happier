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

type CodexRuntimeDescriptorProviderExtra = Readonly<{
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

type CodexAgentRuntimeDescriptorProvider = Readonly<{
  backendMode: CodexBackendMode;
  providerSessionId?: string;
  homePath?: string;
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  providerExtra?: CodexRuntimeDescriptorProviderExtra;
}>;

export type CodexAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'codex';
  provider: CodexAgentRuntimeDescriptorProvider;
} & Record<string, unknown>>;

export type CanonicalCodexAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'codex';
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

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readProviderSessionIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(record.providerSessionId)
    ?? normalizeTrimmedString(record.vendorSessionId);
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

function buildCodexRuntimeHandleProviderExtra(
  params: BuildCodexAgentRuntimeDescriptorParams,
): CodexRuntimeDescriptorProviderExtra {
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

function readCanonicalCodexProviderExtra(value: unknown) {
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

function readCodexRuntimeDescriptorV1(value: unknown): CodexAgentRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || descriptor.providerId !== 'codex') return null;
  const provider = asRecord(descriptor.provider);
  if (!provider) return null;
  const backendMode = normalizeCodexBackendMode(provider.backendMode);
  if (!backendMode) return null;
  return {
    ...descriptor,
    v: 1,
    providerId: 'codex',
    provider: {
      ...provider,
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
    providerId: 'codex',
    provider: {
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
      providerExtra: buildCodexRuntimeHandleProviderExtra({
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
  const descriptor = readCodexRuntimeDescriptorV1(value);
  if (!descriptor) return null;
  const providerExtra = readCanonicalCodexProviderExtra(descriptor.provider.providerExtra);
  const home = providerExtra?.home ?? normalizeCodexHome(descriptor.provider.home);
  const connectedServiceFields = normalizeCodexConnectedServiceFields({
    home,
    connectedServiceId: providerExtra?.connectedServiceId ?? normalizeTrimmedString(descriptor.provider.connectedServiceId),
    connectedServiceProfileId:
      providerExtra?.connectedServiceProfileId ?? normalizeTrimmedString(descriptor.provider.connectedServiceProfileId),
    connectedServiceGroupId:
      providerExtra?.connectedServiceGroupId ?? normalizeTrimmedString(descriptor.provider.connectedServiceGroupId),
    homePath: providerExtra?.homePath ?? normalizeTrimmedString(descriptor.provider.homePath),
  });

  return {
    providerId: 'codex',
    backendMode: providerExtra?.backendMode ?? normalizeCodexBackendMode(descriptor.provider.backendMode),
    providerSessionId: providerExtra?.providerSessionId ?? readProviderSessionIdCompat(descriptor.provider),
    home,
    ...connectedServiceFields,
  };
}
