import type { AgentTerminalSessionStateUpdate as SessionStateUpdateV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  type AgentExternalSessionLinkData,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeAgentRuntimeDescriptorV1,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  readOpenCodeSessionRuntimeHandleFromMetadata,
} from '../../../identity/runtimeDescriptor.js';
import {
  type OpenCodeExternalSessionSource,
} from './client.js';

export type OpenCodeExternalSessionResolvedIdentity = Readonly<{
  providerSessionId: string;
  source: OpenCodeExternalSessionSource;
  runtimeDescriptor?: OpenCodeAgentRuntimeDescriptorV1;
  vendorMetadata?: AgentExternalSessionLinkData;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

function buildSessionStateUpdates(params: Readonly<{
  providerSessionId: string;
  runtimeDescriptor: OpenCodeAgentRuntimeDescriptorV1;
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
}>): AgentExternalSessionLinkData {
  return {
    opencodeSessionId: params.providerSessionId,
    opencodeBackendMode: params.backendMode,
    ...(params.serverBaseUrl ? { opencodeServerBaseUrl: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrl && params.serverBaseUrlExplicit ? { opencodeServerBaseUrlExplicit: true } : {}),
  };
}

/**
 * The exact External Sessions source the host admitted and persisted is the
 * identity authority. A runtime descriptor is data this leaf derived from that
 * source for runtime connection semantics; letting it win here rewrites the
 * source the host is about to compare against, and the host then correctly
 * refuses its own link as `source_invalid`.
 */
function readAdmittedServerBaseUrl(
  source: OpenCodeExternalSessionSource,
): string | undefined {
  const admitted = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
  return admitted || undefined;
}

export function resolveOpenCodeExternalSessionIdentity(params: Readonly<{
  providerSessionId: string;
  source: OpenCodeExternalSessionSource;
  runtimeDescriptor?: unknown;
  metadata?: Readonly<Record<string, unknown>>;
}>): OpenCodeExternalSessionResolvedIdentity {
  const canonicalRuntimeDescriptor = readCanonicalOpenCodeAgentRuntimeDescriptorV1(params.runtimeDescriptor);
  const providerSessionId = canonicalRuntimeDescriptor?.providerSessionId ?? params.providerSessionId;
  const backendMode = 'server';
  const managedEndpoint = params.source.managedEndpoint === true;

  const serverBaseUrl = managedEndpoint
    ? undefined
    : readAdmittedServerBaseUrl(params.source)
      ?? canonicalRuntimeDescriptor?.serverBaseUrl
      ?? undefined;
  const serverBaseUrlExplicit = Boolean(serverBaseUrl);
  const directory =
    typeof params.source.directory === 'string'
      ? params.source.directory.trim()
      : '';
  const source: OpenCodeExternalSessionSource = {
    kind: 'opencodeServer',
    ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
    ...(!serverBaseUrl && managedEndpoint
      ? { managedEndpoint: true as const }
      : {}),
    ...(directory ? { directory } : {}),
  };
  const runtimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1({
    backendMode,
    providerSessionId,
    ...(serverBaseUrl ? { serverBaseUrl } : {}),
    ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
  });
  const metadataPatch = buildOpenCodeMetadataPatch({
    providerSessionId,
    backendMode,
    serverBaseUrl,
    serverBaseUrlExplicit,
  });

  return {
    providerSessionId,
    source,
    runtimeDescriptor,
    vendorMetadata: metadataPatch,
    sessionStateUpdates: buildSessionStateUpdates({ providerSessionId, runtimeDescriptor }),
  };
}

export function resolveOpenCodeLinkedExternalSessionIdentity(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  providerSessionId: string;
  source: OpenCodeExternalSessionSource;
  runtimeDescriptor?: unknown;
}>): OpenCodeExternalSessionResolvedIdentity {
  const canonicalRuntimeDescriptor = readCanonicalOpenCodeAgentRuntimeDescriptorV1(
    params.runtimeDescriptor,
  );
  const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata(params.metadata);
  const managedEndpoint = params.source.managedEndpoint === true;
  const baseUrl = managedEndpoint
    ? ''
    : readAdmittedServerBaseUrl(params.source)
      ?? canonicalRuntimeDescriptor?.serverBaseUrl
      ?? runtimeHandle.serverBaseUrl
      ?? '';
  const directory =
    typeof params.source.directory === 'string'
      ? params.source.directory.trim()
      : '';
  const source: OpenCodeExternalSessionSource = {
    kind: 'opencodeServer',
    ...(baseUrl ? { baseUrl } : {}),
    ...(!baseUrl && managedEndpoint
      ? { managedEndpoint: true as const }
      : {}),
    ...(directory ? { directory } : {}),
  };
  const providerSessionId = canonicalRuntimeDescriptor?.providerSessionId
    ?? runtimeHandle.providerSessionId
    ?? params.providerSessionId;
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
    sessionStateUpdates: buildSessionStateUpdates({ providerSessionId, runtimeDescriptor }),
  };
}
