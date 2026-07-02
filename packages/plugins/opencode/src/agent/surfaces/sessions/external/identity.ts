import {
  type ExternalSessionsSource,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import {
  type ExternalSessionResolvedIdentityV1,
  type SessionStateUpdateV1,
} from '@happier-dev/agents';

import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  readOpenCodeSessionRuntimeHandleFromMetadata,
} from '../../../identity/runtimeDescriptor.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildSessionStateUpdates(params: Readonly<{
  providerSessionId: string;
  runtimeDescriptor: RuntimeDescriptorV1;
}>): SessionStateUpdateV1[] {
  return [
    {
      fieldId: 'identity.runtimeDescriptor',
      value: params.runtimeDescriptor,
    },
    {
      fieldId: 'identity.providerSessionId',
      value: params.providerSessionId,
    },
  ];
}

function buildOpenCodeMetadataPatch(params: Readonly<{
  providerSessionId: string;
  backendMode: 'server' | 'acp';
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): Record<string, unknown> {
  return {
    opencodeSessionId: params.providerSessionId,
    opencodeBackendMode: params.backendMode,
    ...(params.serverBaseUrl ? { opencodeServerBaseUrl: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrl && params.serverBaseUrlExplicit ? { opencodeServerBaseUrlExplicit: true } : {}),
  };
}

export function resolveOpenCodeExternalSessionIdentity(params: Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Readonly<Record<string, unknown>>;
}>): ExternalSessionResolvedIdentityV1 {
  const canonicalRuntimeDescriptor = readCanonicalOpenCodeAgentRuntimeDescriptorV1(params.runtimeDescriptor);
  const providerSessionId = canonicalRuntimeDescriptor?.providerSessionId ?? params.providerSessionId;
  const backendMode =
    params.source.kind === 'opencodeServer'
      ? 'server'
      : canonicalRuntimeDescriptor?.backendMode === 'acp' || canonicalRuntimeDescriptor?.backendMode === 'server'
        ? canonicalRuntimeDescriptor.backendMode
        : null;

  if (!backendMode) {
    return {
      providerSessionId,
      source: params.source,
    };
  }

  const serverBaseUrl =
    canonicalRuntimeDescriptor?.serverBaseUrl
    ?? (params.source.kind === 'opencodeServer'
      && typeof params.source.baseUrl === 'string'
      && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : undefined);
  const directory =
    params.source.kind === 'opencodeServer' && typeof params.source.directory === 'string'
      ? params.source.directory.trim()
      : '';
  const source: ExternalSessionsSource = params.source.kind === 'opencodeServer'
    ? {
        kind: 'opencodeServer',
        ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
        ...(directory ? { directory } : {}),
      }
    : params.source;
  const runtimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1({
    backendMode,
    providerSessionId,
    ...(serverBaseUrl ? { serverBaseUrl } : {}),
    ...((canonicalRuntimeDescriptor?.serverBaseUrlExplicit ?? Boolean(serverBaseUrl)) ? { serverBaseUrlExplicit: true } : {}),
  });
  const metadataPatch = buildOpenCodeMetadataPatch({
    providerSessionId,
    backendMode,
    serverBaseUrl,
    serverBaseUrlExplicit: canonicalRuntimeDescriptor?.serverBaseUrlExplicit ?? Boolean(serverBaseUrl),
  });

  return {
    providerSessionId,
    source,
    runtimeDescriptor,
    vendorMetadata: metadataPatch,
    externalSessionMetadata: metadataPatch,
    sessionStateUpdates: buildSessionStateUpdates({ providerSessionId, runtimeDescriptor }),
  };
}

export function resolveOpenCodeLinkedExternalSessionIdentity(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  providerSessionId: string;
  source: ExternalSessionsSource;
}>): ExternalSessionResolvedIdentityV1 {
  const externalSession = asRecord(params.metadata.externalSessionV1);
  const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata({
    ...params.metadata,
    runtimeDescriptorV1: externalSession?.runtimeDescriptorV1 ?? params.metadata.runtimeDescriptorV1,
    agentRuntimeDescriptorV1: externalSession?.agentRuntimeDescriptorV1 ?? params.metadata.agentRuntimeDescriptorV1,
  });
  const baseUrl =
    runtimeHandle.serverBaseUrl
    ?? (params.source.kind === 'opencodeServer' && typeof params.source.baseUrl === 'string'
      ? params.source.baseUrl.trim()
      : '');
  const directory =
    params.source.kind === 'opencodeServer' && typeof params.source.directory === 'string'
      ? params.source.directory.trim()
      : '';
  const source: ExternalSessionsSource = {
    kind: 'opencodeServer',
    ...(baseUrl ? { baseUrl } : {}),
    ...(directory ? { directory } : {}),
  };
  const providerSessionId = runtimeHandle.providerSessionId ?? params.providerSessionId;
  const runtimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1({
    backendMode: 'server',
    providerSessionId,
    ...(baseUrl ? { serverBaseUrl: baseUrl } : {}),
    ...(baseUrl ? { serverBaseUrlExplicit: true } : {}),
  });
  const metadataPatch = buildOpenCodeMetadataPatch({
    providerSessionId,
    backendMode: 'server',
    serverBaseUrl: baseUrl,
    serverBaseUrlExplicit: Boolean(baseUrl),
  });

  return {
    providerSessionId,
    source,
    runtimeDescriptor,
    vendorMetadata: metadataPatch,
    externalSessionMetadata: metadataPatch,
    sessionStateUpdates: buildSessionStateUpdates({ providerSessionId, runtimeDescriptor }),
  };
}
