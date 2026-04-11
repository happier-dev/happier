import { buildOpenCodeAgentRuntimeDescriptor } from '@happier-dev/agents';
import {
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
  type AgentRuntimeDescriptorV1,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import type { DirectSessionLinkIdentity } from '@/backends/directSessions/providerOps';

export function resolveOpenCodeDirectSessionLinkIdentity(params: Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
}>): DirectSessionLinkIdentity {
  const canonicalRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.runtimeDescriptor, 'opencode');
  const runtimeVendorSessionId = canonicalRuntimeDescriptor?.vendorSessionId ?? '';
  const remoteSessionId = runtimeVendorSessionId || params.remoteSessionId;

  const backendMode =
    params.source.kind === 'opencodeServer'
      ? 'server'
      : canonicalRuntimeDescriptor?.backendMode === 'acp' || canonicalRuntimeDescriptor?.backendMode === 'server'
        ? canonicalRuntimeDescriptor.backendMode
        : null;
  if (!backendMode) {
    return {
      remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor ?? null,
    };
  }

  const serverBaseUrl = canonicalRuntimeDescriptor?.serverBaseUrl
    ?? (params.source.kind === 'opencodeServer' && typeof params.source.baseUrl === 'string' && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : undefined);
  const directory = params.source.kind === 'opencodeServer' && typeof params.source.directory === 'string'
    ? params.source.directory.trim()
    : '';
  const source: DirectSessionsSource = params.source.kind === 'opencodeServer'
    ? {
        kind: 'opencodeServer',
        ...(serverBaseUrl ? { baseUrl: serverBaseUrl } : {}),
        ...(directory ? { directory } : {}),
      }
    : params.source;

  return {
    remoteSessionId,
    source,
    vendorMetadata: {
      opencodeBackendMode: backendMode,
      ...(serverBaseUrl ? { opencodeServerBaseUrl: serverBaseUrl } : {}),
      ...((canonicalRuntimeDescriptor?.serverBaseUrlExplicit ?? Boolean(serverBaseUrl))
        ? { opencodeServerBaseUrlExplicit: true }
        : {}),
    },
    runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptor({
      backendMode,
      vendorSessionId: remoteSessionId,
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...((canonicalRuntimeDescriptor?.serverBaseUrlExplicit ?? Boolean(serverBaseUrl)) ? { serverBaseUrlExplicit: true } : {}),
    }),
  };
}
