import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import { readRuntimeDescriptorV1ForAgent } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';

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
  // The runtime descriptor an Agent returns is persisted on the link and later
  // outranks session metadata when the host resolves the Session's backend
  // target. It is therefore host routing authority, not vendor payload: the
  // descriptor an Agent contributes may only name the Agent that was admitted.
  if (
    resolved.runtimeDescriptor
    && !readRuntimeDescriptorV1ForAgent(resolved.runtimeDescriptor, params.agentId)
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'source_invalid',
      message: 'External-session link identity returned a runtime descriptor for another Agent',
      operation: 'resolveLinkIdentity',
    });
  }
  return resolved;
}
