import {
  normalizeCodexBackendMode,
  type CanonicalCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';

type RuntimeDescriptorEnvelopeV1<TProviderId extends string = string> = Readonly<{
  v: 1;
  providerId: TProviderId;
  provider: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

export type CodexSessionMetadataConnectedServiceBinding = Readonly<
  | { source: 'native' }
  | {
      source: 'connected';
      selection: 'profile';
      profileId: string;
    }
  | {
      source: 'connected';
      selection: 'group';
      groupId: string;
      profileId?: string;
    }
>;

type CodexRuntimeControlMode = NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']> | 'mcp';

export type CodexRuntimeDescriptor = Omit<CanonicalCodexAgentRuntimeDescriptorV1, 'backendMode'> & Readonly<{
  backendMode: NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']> | null;
  runtimeKind: NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']> | null;
  runtimeHandle: Readonly<Record<string, unknown>> | null;
}>;

export type PersistedCodexRuntimeIdentity = Readonly<{
  backendMode: CodexRuntimeControlMode;
}>;

export type CodexSpawnRuntimeAffinityCompatFields = Readonly<{
  experimentalCodexAcp?: true;
  codexBackendMode?: NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readRuntimeDescriptorV1(value: unknown): RuntimeDescriptorEnvelopeV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || typeof descriptor.providerId !== 'string' || !descriptor.providerId.trim()) {
    return null;
  }
  const provider = asRecord(descriptor.provider);
  if (!provider) return null;
  return {
    ...descriptor,
    v: 1,
    providerId: descriptor.providerId,
    provider,
  } as RuntimeDescriptorEnvelopeV1;
}

function readRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): RuntimeDescriptorEnvelopeV1<TProviderId> | null {
  const descriptor = readRuntimeDescriptorV1(value);
  return descriptor?.providerId === providerId ? descriptor as RuntimeDescriptorEnvelopeV1<TProviderId> : null;
}

function readRuntimeDescriptorV1FromMetadata(metadata: unknown): RuntimeDescriptorEnvelopeV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return readRuntimeDescriptorV1(metadataRecord.runtimeDescriptorV1)
    ?? readRuntimeDescriptorV1(metadataRecord.agentRuntimeDescriptorV1);
}

function readRawRuntimeDescriptorV1FromMetadata(metadata: unknown): unknown {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return metadataRecord.runtimeDescriptorV1 ?? metadataRecord.agentRuntimeDescriptorV1 ?? null;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCodexRuntimeControlMode(value: unknown): CodexRuntimeControlMode | null {
  if (typeof value === 'string' && value.trim() === 'mcp') return 'mcp';
  return normalizeCodexBackendMode(value);
}

export function toCanonicalCodexRuntimeBackendMode(
  value: CodexRuntimeControlMode | null | undefined,
): NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']> | null {
  return value === 'acp' || value === 'appServer' ? value : null;
}

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function buildCodexRuntimeHandle(descriptor: CodexRuntimeDescriptorInput): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  assignRuntimeHandleValue(runtimeHandle, 'backendMode', descriptor.backendMode);
  assignRuntimeHandleValue(runtimeHandle, 'providerSessionId', descriptor.providerSessionId);
  assignRuntimeHandleValue(runtimeHandle, 'home', descriptor.home);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceId', descriptor.connectedServiceId);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceProfileId', descriptor.connectedServiceProfileId);
  assignRuntimeHandleValue(runtimeHandle, 'connectedServiceGroupId', descriptor.connectedServiceGroupId);
  assignRuntimeHandleValue(runtimeHandle, 'homePath', descriptor.homePath);
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

type CodexRuntimeDescriptorInput = Omit<CanonicalCodexAgentRuntimeDescriptorV1, 'backendMode'> & Readonly<{
  backendMode: NonNullable<CanonicalCodexAgentRuntimeDescriptorV1['backendMode']> | null;
}>;

function toCodexRuntimeDescriptor(
  descriptor: CodexRuntimeDescriptorInput,
): CodexRuntimeDescriptor {
  return {
    ...descriptor,
    runtimeKind: descriptor.backendMode,
    runtimeHandle: buildCodexRuntimeHandle(descriptor),
  };
}

function readLegacyCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
  const backendMode = normalizeCodexBackendMode(metadataRecord.codexBackendMode);
  if (!backendMode) return null;

  return toCodexRuntimeDescriptor({
    providerId: 'codex',
    backendMode,
    providerSessionId: normalizeTrimmedString(metadataRecord.codexSessionId),
    home: null,
    connectedServiceId: null,
    connectedServiceProfileId: null,
    connectedServiceGroupId: null,
    homePath: null,
  });
}

function readGenericCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
  const rawDescriptorInput = readRawRuntimeDescriptorV1FromMetadata(metadataRecord);
  const rawDescriptor = asRecord(rawDescriptorInput);
  const descriptor = readRuntimeDescriptorV1ForProvider(
    readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? rawDescriptorInput,
    'codex',
  ) ?? (rawDescriptor?.providerId === 'codex' ? rawDescriptorInput : null);
  const canonicalDescriptor = readCanonicalCodexAgentRuntimeDescriptorV1(descriptor);
  return canonicalDescriptor ? toCodexRuntimeDescriptor(canonicalDescriptor) : null;
}

export function readCanonicalCodexRuntimeDescriptorV1(
  value: unknown,
): CanonicalCodexAgentRuntimeDescriptorV1 | null {
  return readCanonicalCodexAgentRuntimeDescriptorV1(value);
}

export function readCodexSessionMetadataRuntimeDescriptor(
  metadataRecord: Record<string, unknown>,
): CodexRuntimeDescriptor | null {
  return readGenericCodexSessionMetadataRuntimeDescriptor(metadataRecord)
    ?? readLegacyCodexSessionMetadataRuntimeDescriptor(metadataRecord);
}

export function readCodexSessionMetadataConnectedServiceBindings(
  metadata: unknown,
): Readonly<Record<string, CodexSessionMetadataConnectedServiceBinding>> {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return {};

  const descriptor = readCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  if (descriptor?.home !== 'connectedService' || !descriptor.connectedServiceId) return {};

  if (descriptor.connectedServiceGroupId) {
    return {
      [descriptor.connectedServiceId]: {
        source: 'connected',
        selection: 'group',
        groupId: descriptor.connectedServiceGroupId,
        ...(descriptor.connectedServiceProfileId ? { profileId: descriptor.connectedServiceProfileId } : {}),
      },
    };
  }

  if (!descriptor.connectedServiceProfileId) return {};
  return {
    [descriptor.connectedServiceId]: {
      source: 'connected',
      selection: 'profile',
      profileId: descriptor.connectedServiceProfileId,
    },
  };
}

function hasGenericCodexState(metadata: Record<string, unknown> | null): boolean {
  return [
    'sessionModesV1',
    'sessionModelsV1',
    'sessionConfigOptionsV1',
    'acpSessionModesV1',
    'acpSessionModelsV1',
    'acpConfigOptionsV1',
  ].some((key) => {
    const value = asRecord(metadata?.[key]);
    return value?.provider === 'codex';
  });
}

function readCodexRuntimeDescriptorV1BackendMode(value: unknown): PersistedCodexRuntimeIdentity['backendMode'] | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1) return null;
  return normalizeCodexRuntimeControlMode(descriptor.backendMode);
}

function readCodexSessionLinkBackendMode(value: unknown): PersistedCodexRuntimeIdentity['backendMode'] | null {
  const link = asRecord(value);
  if (!link || link.v !== 1 || link.providerId !== 'codex') return null;
  return normalizeCodexRuntimeControlMode(link.codexBackendMode);
}

function readCodexRuntimeDescriptorProviderControlMode(
  value: unknown,
): PersistedCodexRuntimeIdentity['backendMode'] | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || descriptor.providerId !== 'codex') return null;
  const provider = asRecord(descriptor.provider);
  if (!provider) return null;

  const providerExtra = asRecord(provider.providerExtra);
  const runtimeHandle = providerExtra?.v === 1
    ? asRecord(providerExtra.runtimeHandle) ?? asRecord(providerExtra.runtimeAffinity)
    : null;
  return normalizeCodexRuntimeControlMode(runtimeHandle?.backendMode)
    ?? normalizeCodexRuntimeControlMode(provider.backendMode);
}

export function resolvePersistedCodexRuntimeIdentity(metadata: unknown): PersistedCodexRuntimeIdentity | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const rawDescriptorMode = readCodexRuntimeDescriptorProviderControlMode(
    readRawRuntimeDescriptorV1FromMetadata(metadataRecord),
  );
  if (rawDescriptorMode) {
    return { backendMode: rawDescriptorMode };
  }

  const genericDescriptor = readGenericCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  const genericMode = genericDescriptor?.backendMode ?? null;
  if (genericMode) {
    return { backendMode: genericMode };
  }

  const descriptorMode = readCodexRuntimeDescriptorV1BackendMode(metadataRecord.codexRuntimeDescriptorV1);
  if (descriptorMode) {
    return { backendMode: descriptorMode };
  }

  const affinityMode = normalizeCodexRuntimeControlMode(asRecord(metadataRecord.affinity)?.backendMode);
  if (affinityMode) {
    return { backendMode: affinityMode };
  }

  const persistedMode = normalizeCodexRuntimeControlMode(metadataRecord.codexBackendMode);
  if (persistedMode) {
    return { backendMode: persistedMode };
  }

  const directSession = asRecord(metadataRecord.directSessionV1);
  const nestedMode = normalizeCodexRuntimeControlMode(directSession?.codexBackendMode);
  if (nestedMode) {
    return { backendMode: nestedMode };
  }

  const externalSessionMode = readCodexSessionLinkBackendMode(metadataRecord.externalSessionV1);
  if (externalSessionMode) {
    return { backendMode: externalSessionMode };
  }

  const codexSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  if (codexSessionId && hasGenericCodexState(metadataRecord)) {
    return { backendMode: 'appServer' };
  }

  return null;
}

export function resolvePersistedCodexProviderSessionId(metadata: unknown): string | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const genericDescriptor = readCodexSessionMetadataRuntimeDescriptor(metadataRecord);
  const genericProviderSessionId = genericDescriptor?.providerSessionId ?? '';
  if (genericProviderSessionId) {
    return genericProviderSessionId;
  }

  const legacyProviderSessionId = typeof metadataRecord.codexSessionId === 'string' ? metadataRecord.codexSessionId.trim() : '';
  return legacyProviderSessionId || null;
}

export function buildCodexSpawnRuntimeAffinityCompatFields(
  runtimeIdentity: PersistedCodexRuntimeIdentity | null,
): CodexSpawnRuntimeAffinityCompatFields {
  const backendMode = toCanonicalCodexRuntimeBackendMode(runtimeIdentity?.backendMode);
  if (!backendMode) return {};
  return { codexBackendMode: backendMode };
}
