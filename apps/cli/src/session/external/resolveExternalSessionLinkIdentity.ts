import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type {
  ExternalSessionExecutionSurface,
  ExternalSessionLinkIdentity,
} from './providerOps';
import { ExternalSessionProviderFailureError } from './providerOps';
import { preservesExternalSessionSourceIdentity } from './sourceIdentity';

export async function resolveExternalSessionLinkIdentityFromSurface(
  params: Readonly<{
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }>,
  surface: ExternalSessionExecutionSurface | null,
): Promise<ExternalSessionLinkIdentity> {
  if (!surface?.resolveLinkIdentity) {
    return {
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor ?? null,
    };
  }

  const resolved = await surface.resolveLinkIdentity({
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor ?? null,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (
    resolved.remoteSessionId !== params.remoteSessionId
    || !preservesExternalSessionSourceIdentity(params.source, resolved.source)
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'source_invalid',
      message: 'External-session link identity rewrote admitted source identity',
      operation: 'resolveLinkIdentity',
    });
  }
  return resolved;
}
