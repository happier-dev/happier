import { readAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import type { CodexBackendMode } from '../providerSettings/definitions/codex.js';
import {
  buildCodexRuntimeDescriptorProviderExtra,
  readCodexRuntimeDescriptorProviderExtra,
} from './codexRuntimeDescriptorExtra.js';
import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  type OpenCodeBackendMode,
} from '../providerSettings/definitions/opencode.js';
import {
  readOpenCodeRuntimeDescriptorProviderExtra,
} from './opencodeRuntimeDescriptorExtra.js';

type SupportedRuntimeDescriptorProviderId = 'codex' | 'opencode' | 'pi';

type SharedRuntimeDescriptorByProviderId = {
  codex: Readonly<{
    providerId: 'codex';
    backendMode: CodexBackendMode | null;
    vendorSessionId: string | null;
    home: 'user' | 'connectedService' | null;
    connectedServiceId: string | null;
    connectedServiceProfileId: string | null;
    homePath: string | null;
  }>;
  opencode: Readonly<{
    providerId: 'opencode';
    backendMode: OpenCodeBackendMode | null;
    vendorSessionId: string | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
  pi: Readonly<{
    providerId: 'pi';
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

function normalizeCodexBackendMode(value: unknown): CodexBackendMode | null {
  return value === 'mcp' || value === 'acp' || value === 'appServer' ? value : null;
}

function normalizeCodexHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
}

export function buildCodexAgentRuntimeDescriptor(params: Readonly<{
  backendMode: CodexBackendMode;
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>): Readonly<{
  v: 1;
  providerId: 'codex';
  provider: {
    backendMode: CodexBackendMode;
    vendorSessionId?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
    providerExtra: {
      owner: 'codex';
      schemaId: 'codex.agentRuntimeDescriptorExtra';
      v: 1;
      runtimeAffinity?: {
        backendMode?: CodexBackendMode;
        vendorSessionId?: string;
        home?: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
      };
    };
  };
}> {
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceId = home === 'connectedService' ? normalizeTrimmedString(params.connectedServiceId) : null;
  const connectedServiceProfileId = home === 'connectedService'
    ? normalizeTrimmedString(params.connectedServiceProfileId)
    : null;
  const homePath = normalizeTrimmedString(params.homePath);

  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(homePath ? { homePath } : {}),
      providerExtra: {
        owner: 'codex',
        schemaId: 'codex.agentRuntimeDescriptorExtra',
        ...buildCodexRuntimeDescriptorProviderExtra({
          backendMode: params.backendMode,
          vendorSessionId,
          home,
          connectedServiceId,
          connectedServiceProfileId,
          homePath,
        }),
      },
    },
  };
}

export function buildOpenCodeAgentRuntimeDescriptor(params: Readonly<{
  backendMode: OpenCodeBackendMode;
  vendorSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): Readonly<{
  v: 1;
  providerId: 'opencode';
  provider: {
    backendMode: OpenCodeBackendMode;
    vendorSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
    providerExtra: {
      owner: 'opencode';
      schemaId: 'opencode.agentRuntimeDescriptorExtra';
      v: 1;
      runtimeHandle?: {
        backendMode?: OpenCodeBackendMode;
        vendorSessionId?: string;
        serverBaseUrl?: string;
        serverBaseUrlExplicit?: true;
      };
  };
};
}> {
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const rawServerBaseUrl = normalizeTrimmedString(params.serverBaseUrl);
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = serverBaseUrlExplicit ? rawServerBaseUrl : null;

  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode: params.backendMode,
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrl && serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      providerExtra: {
        owner: 'opencode',
        schemaId: 'opencode.agentRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: {
          backendMode: params.backendMode,
          ...(vendorSessionId ? { vendorSessionId } : {}),
          ...(serverBaseUrl ? { serverBaseUrl } : {}),
          ...(serverBaseUrl && serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
        },
      },
    },
  };
}

function normalizeCodexConnectedServiceFields(params: Readonly<{
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>): Readonly<{
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}> {
  if (params.home === 'connectedService') {
    return {
      connectedServiceId: params.connectedServiceId,
      connectedServiceProfileId: params.connectedServiceProfileId,
      homePath: params.homePath,
    };
  }
  return {
    connectedServiceId: null,
    connectedServiceProfileId: null,
    homePath: params.homePath,
  };
}

export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'codex',
): SharedRuntimeDescriptorByProviderId['codex'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'opencode',
): SharedRuntimeDescriptorByProviderId['opencode'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: 'pi',
): SharedRuntimeDescriptorByProviderId['pi'] | null;
export function readSessionMetadataRuntimeDescriptor(
  metadata: unknown,
  providerId: SupportedRuntimeDescriptorProviderId,
): SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  switch (providerId) {
    case 'codex': {
      const rawDescriptor = asRecord(metadataRecord.agentRuntimeDescriptorV1);
      const rawProvider = rawDescriptor?.providerId === 'codex' ? asRecord(rawDescriptor.provider) : null;
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'codex');
      const providerExtra = readCodexRuntimeDescriptorProviderExtra(rawProvider?.providerExtra);
      const provider = descriptor?.provider ?? rawProvider;
      if (!provider) return null;

      const home = providerExtra?.home ?? normalizeCodexHome(provider.home);
      const codexConnectedServiceFields = normalizeCodexConnectedServiceFields({
        home,
        connectedServiceId: providerExtra?.connectedServiceId ?? normalizeTrimmedString(provider.connectedServiceId),
        connectedServiceProfileId: providerExtra?.connectedServiceProfileId ?? normalizeTrimmedString(provider.connectedServiceProfileId),
        homePath: providerExtra?.homePath ?? normalizeTrimmedString(provider.homePath),
      });

      return {
        providerId: 'codex',
        backendMode: providerExtra?.backendMode ?? normalizeCodexBackendMode(provider.backendMode),
        vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId),
        home,
        connectedServiceId: codexConnectedServiceFields.connectedServiceId,
        connectedServiceProfileId: codexConnectedServiceFields.connectedServiceProfileId,
        homePath: codexConnectedServiceFields.homePath,
      };
    }
    case 'opencode': {
      const rawDescriptor = asRecord(metadataRecord.agentRuntimeDescriptorV1);
      const rawProvider = rawDescriptor?.providerId === 'opencode' ? asRecord(rawDescriptor.provider) : null;
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'opencode');
      const providerExtra = readOpenCodeRuntimeDescriptorProviderExtra(rawProvider?.providerExtra);
      const provider = descriptor?.provider ?? rawProvider;
      if (!provider) return null;

      return {
        providerId: 'opencode',
        backendMode: providerExtra?.backendMode ?? normalizeOpenCodeBackendMode(provider.backendMode),
        vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(provider.vendorSessionId),
        serverBaseUrl: providerExtra?.serverBaseUrl ?? normalizeOpenCodeServerBaseUrl(provider.serverBaseUrl),
        serverBaseUrlExplicit: providerExtra?.serverBaseUrlExplicit ?? normalizeOpenCodeServerBaseUrlExplicit(provider.serverBaseUrlExplicit),
      };
    }
    case 'pi': {
      const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadataRecord.agentRuntimeDescriptorV1, 'pi');
      if (!descriptor) return null;
      return {
        providerId: 'pi',
        vendorSessionId: normalizeTrimmedString(descriptor.provider.vendorSessionId),
      };
    }
  }
}
