import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type {
  ExternalSessionExecutionSurface,
  ExternalSessionLinkIdentity,
} from './providerOps';

export async function resolveExternalSessionLinkIdentityFromSurface(
  params: Readonly<{
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
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

  return await surface.resolveLinkIdentity({
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor ?? null,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}
