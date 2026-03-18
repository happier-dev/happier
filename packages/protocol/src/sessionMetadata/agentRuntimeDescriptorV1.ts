import { z } from 'zod';

type AgentRuntimeDescriptorProviderShape = Readonly<Record<string, unknown>>;

export type AgentRuntimeDescriptorProviderExtraV1 = Readonly<{
  owner: string;
  schemaId: string;
  v: number;
} & Record<string, unknown>>;

export type AgentRuntimeDescriptorEnvelopeV1<
  TProviderId extends string = string,
  TProvider extends AgentRuntimeDescriptorProviderShape = AgentRuntimeDescriptorProviderShape,
> = Readonly<{
  v: 1;
  providerId: TProviderId;
  provider: TProvider;
} & Record<string, unknown>>;

type CodexAgentRuntimeDescriptorProvider = Readonly<{
  backendMode: 'mcp' | 'acp' | 'appServer';
  vendorSessionId?: string;
  homePath?: string;
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  providerExtra?: Readonly<AgentRuntimeDescriptorProviderExtraV1 & {
    runtimeAffinity?: Readonly<{
      backendMode?: 'mcp' | 'acp' | 'appServer';
      vendorSessionId?: string;
      homePath?: string;
      home?: 'user' | 'connectedService';
      connectedServiceId?: string;
      connectedServiceProfileId?: string;
    }>;
  }>;
}>;

type OpenCodeAgentRuntimeDescriptorProvider = Readonly<{
  backendMode: 'server' | 'acp';
  vendorSessionId?: string;
  serverBaseUrl?: string;
  serverBaseUrlExplicit?: true;
  providerExtra?: Readonly<AgentRuntimeDescriptorProviderExtraV1 & {
    runtimeHandle?: Readonly<{
      backendMode?: 'server' | 'acp';
      vendorSessionId?: string;
      serverBaseUrl?: string;
      serverBaseUrlExplicit?: true;
    }>;
  }>;
}>;

type PiAgentRuntimeDescriptorProvider = Readonly<{
  resumeStrategy: 'sessionFileBySessionId';
  vendorSessionId?: string;
}>;

export type CodexAgentRuntimeDescriptorV1 = AgentRuntimeDescriptorEnvelopeV1<'codex', CodexAgentRuntimeDescriptorProvider>;
export type OpenCodeAgentRuntimeDescriptorV1 = AgentRuntimeDescriptorEnvelopeV1<'opencode', OpenCodeAgentRuntimeDescriptorProvider>;
export type PiAgentRuntimeDescriptorV1 = AgentRuntimeDescriptorEnvelopeV1<'pi', PiAgentRuntimeDescriptorProvider>;
export type AgentRuntimeDescriptorV1 = AgentRuntimeDescriptorEnvelopeV1;

type CanonicalAgentRuntimeDescriptorByProviderId = {
  codex: Readonly<{
    providerId: 'codex';
    backendMode: 'mcp' | 'acp' | 'appServer' | null;
    vendorSessionId: string | null;
    home: 'user' | 'connectedService' | null;
    connectedServiceId: string | null;
    connectedServiceProfileId: string | null;
    homePath: string | null;
  }>;
  opencode: Readonly<{
    providerId: 'opencode';
    backendMode: 'server' | 'acp' | null;
    vendorSessionId: string | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
  pi: Readonly<{
    providerId: 'pi';
    resumeStrategy: 'sessionFileBySessionId' | null;
    vendorSessionId: string | null;
  }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCodexBackendMode(value: unknown): CanonicalAgentRuntimeDescriptorByProviderId['codex']['backendMode'] {
  return value === 'mcp' || value === 'acp' || value === 'appServer' ? value : null;
}

function normalizeCodexHome(value: unknown): CanonicalAgentRuntimeDescriptorByProviderId['codex']['home'] {
  return value === 'user' || value === 'connectedService' ? value : null;
}

function normalizeOpenCodeBackendMode(value: unknown): CanonicalAgentRuntimeDescriptorByProviderId['opencode']['backendMode'] {
  return value === 'server' || value === 'acp' ? value : null;
}

function normalizeOpenCodeServerBaseUrlExplicit(value: unknown): boolean {
  return value === true;
}

function readCanonicalCodexProviderExtra(value: unknown) {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  const runtimeAffinity = asRecord(extra.runtimeAffinity);
  if (!runtimeAffinity) return null;

  const home = normalizeCodexHome(runtimeAffinity.home);
  return {
    backendMode: normalizeCodexBackendMode(runtimeAffinity.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeAffinity.vendorSessionId),
    home,
    connectedServiceId: home === 'connectedService' ? normalizeTrimmedString(runtimeAffinity.connectedServiceId) : null,
    connectedServiceProfileId: home === 'connectedService'
      ? normalizeTrimmedString(runtimeAffinity.connectedServiceProfileId)
      : null,
    homePath: normalizeTrimmedString(runtimeAffinity.homePath),
  };
}

function readCanonicalOpenCodeProviderExtra(value: unknown) {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  const runtimeHandle = asRecord(extra.runtimeHandle);
  if (!runtimeHandle) return null;

  return {
    backendMode: normalizeOpenCodeBackendMode(runtimeHandle.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeHandle.vendorSessionId),
    serverBaseUrl: normalizeTrimmedString(runtimeHandle.serverBaseUrl),
    serverBaseUrlExplicit: normalizeOpenCodeServerBaseUrlExplicit(runtimeHandle.serverBaseUrlExplicit),
  };
}

function createAgentRuntimeDescriptorProviderSchema(zod: typeof z) {
  return zod.object({
    providerExtra: createAgentRuntimeDescriptorProviderExtraV1Schema(zod).optional(),
  }).passthrough();
}

function createAgentRuntimeDescriptorProviderExtraV1Schema(zod: typeof z) {
  return zod.object({
    owner: zod.string().min(1),
    schemaId: zod.string().min(1),
    v: zod.number().int().min(1),
  }).passthrough();
}

export function createAgentRuntimeDescriptorV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    providerId: zod.string().min(1),
    provider: createAgentRuntimeDescriptorProviderSchema(zod),
  }).passthrough();
}

export const AgentRuntimeDescriptorV1Schema = createAgentRuntimeDescriptorV1Schema(z);

function buildCodexRuntimeAffinityProviderExtra(params: Readonly<{
  backendMode: 'mcp' | 'acp' | 'appServer';
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>): NonNullable<CodexAgentRuntimeDescriptorProvider['providerExtra']> {
  return {
    owner: 'codex',
    schemaId: 'codex.agentRuntimeDescriptorExtra',
    v: 1,
    runtimeAffinity: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.homePath ? { homePath: params.homePath } : {}),
      ...(params.home ? { home: params.home } : {}),
      ...(params.home === 'connectedService' && params.connectedServiceId
        ? { connectedServiceId: params.connectedServiceId }
        : {}),
      ...(params.home === 'connectedService' && params.connectedServiceProfileId
        ? { connectedServiceProfileId: params.connectedServiceProfileId }
        : {}),
    },
  };
}

export function buildCodexAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: 'mcp' | 'acp' | 'appServer';
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>): CodexAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.homePath ? { homePath: params.homePath } : {}),
      ...(params.home ? { home: params.home } : {}),
      ...(params.home === 'connectedService' && params.connectedServiceId
        ? { connectedServiceId: params.connectedServiceId }
        : {}),
      ...(params.home === 'connectedService' && params.connectedServiceProfileId
        ? { connectedServiceProfileId: params.connectedServiceProfileId }
        : {}),
      providerExtra: buildCodexRuntimeAffinityProviderExtra(params),
    },
  };
}

export function buildOpenCodeAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: 'server' | 'acp';
  vendorSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): OpenCodeAgentRuntimeDescriptorV1 {
  const providerExtraRuntimeHandle = {
    backendMode: params.backendMode,
    ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
    ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
  } satisfies NonNullable<NonNullable<OpenCodeAgentRuntimeDescriptorProvider['providerExtra']>['runtimeHandle']>;

  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
      ...(params.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      providerExtra: {
        owner: 'opencode',
        schemaId: 'opencode.agentRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: providerExtraRuntimeHandle,
      },
    },
  };
}

export function buildPiAgentRuntimeDescriptorV1(params: Readonly<{
  resumeStrategy: 'sessionFileBySessionId';
  vendorSessionId?: string | null;
}>): PiAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'pi',
    provider: {
      resumeStrategy: params.resumeStrategy,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
    },
  };
}

export function readAgentRuntimeDescriptorV1(value: unknown): AgentRuntimeDescriptorV1 | null {
  const parsed = AgentRuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readAgentRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'codex'): CodexAgentRuntimeDescriptorV1 | null;
export function readAgentRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'opencode'): OpenCodeAgentRuntimeDescriptorV1 | null;
export function readAgentRuntimeDescriptorV1ForProvider(value: unknown, providerId: 'pi'): PiAgentRuntimeDescriptorV1 | null;
export function readAgentRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): AgentRuntimeDescriptorEnvelopeV1<TProviderId> | null;
export function readAgentRuntimeDescriptorV1ForProvider<TProviderId extends string>(
  value: unknown,
  providerId: TProviderId,
): AgentRuntimeDescriptorEnvelopeV1<TProviderId> | null {
  const parsed = readAgentRuntimeDescriptorV1(value);
  return parsed?.providerId === providerId ? parsed as AgentRuntimeDescriptorEnvelopeV1<TProviderId> : null;
}

export function readCanonicalAgentRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'codex',
): CanonicalAgentRuntimeDescriptorByProviderId['codex'] | null;
export function readCanonicalAgentRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'opencode',
): CanonicalAgentRuntimeDescriptorByProviderId['opencode'] | null;
export function readCanonicalAgentRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'pi',
): CanonicalAgentRuntimeDescriptorByProviderId['pi'] | null;
export function readCanonicalAgentRuntimeDescriptorV1ForProvider(
  value: unknown,
  providerId: 'codex' | 'opencode' | 'pi',
) {
  switch (providerId) {
    case 'codex': {
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(value, 'codex');
      if (!descriptor) return null;
      const providerExtra = readCanonicalCodexProviderExtra(descriptor.provider.providerExtra);
      const home = providerExtra?.home ?? normalizeCodexHome(descriptor.provider.home);
      return {
        providerId: 'codex' as const,
        backendMode: providerExtra?.backendMode ?? normalizeCodexBackendMode(descriptor.provider.backendMode),
        vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(descriptor.provider.vendorSessionId),
        home,
        connectedServiceId: providerExtra?.connectedServiceId
          ?? (home === 'connectedService' ? normalizeTrimmedString(descriptor.provider.connectedServiceId) : null),
        connectedServiceProfileId: providerExtra?.connectedServiceProfileId
          ?? (home === 'connectedService' ? normalizeTrimmedString(descriptor.provider.connectedServiceProfileId) : null),
        homePath: providerExtra?.homePath ?? normalizeTrimmedString(descriptor.provider.homePath),
      };
    }
    case 'opencode': {
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(value, 'opencode');
      if (!descriptor) return null;
      const providerExtra = readCanonicalOpenCodeProviderExtra(descriptor.provider.providerExtra);
      return {
        providerId: 'opencode' as const,
        backendMode: providerExtra?.backendMode ?? normalizeOpenCodeBackendMode(descriptor.provider.backendMode),
        vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(descriptor.provider.vendorSessionId),
        serverBaseUrl: providerExtra?.serverBaseUrl ?? normalizeTrimmedString(descriptor.provider.serverBaseUrl),
        serverBaseUrlExplicit: providerExtra?.serverBaseUrlExplicit ?? normalizeOpenCodeServerBaseUrlExplicit(descriptor.provider.serverBaseUrlExplicit),
      };
    }
    case 'pi': {
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(value, 'pi');
      if (!descriptor) return null;
      return {
        providerId: 'pi' as const,
        resumeStrategy: descriptor.provider.resumeStrategy === 'sessionFileBySessionId'
          ? 'sessionFileBySessionId'
          : null,
        vendorSessionId: normalizeTrimmedString(descriptor.provider.vendorSessionId),
      };
    }
  }
}
