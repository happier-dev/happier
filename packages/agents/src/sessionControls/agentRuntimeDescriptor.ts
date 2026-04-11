import { normalizeCodexBackendMode, type CodexBackendMode } from '../providerSettings/definitions/codex.js';
import {
  buildCodexRuntimeDescriptorProviderExtra,
} from './codexRuntimeDescriptorExtra.js';
import {
  normalizeOpenCodeServerBaseUrlExplicit,
  type OpenCodeBackendMode,
} from '../providerSettings/definitions/opencode.js';
import { getProviderRuntimeDescriptorReader } from '../providers/runtimeDescriptorReaderRegistry.js';
import { asRecord, normalizeCodexHome, normalizeTrimmedString } from './runtimeDescriptorShared.js';
import type {
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';

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
  return getProviderRuntimeDescriptorReader(providerId)(metadataRecord);
}
