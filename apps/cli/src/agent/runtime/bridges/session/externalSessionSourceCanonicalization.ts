import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import {
  resolveSessionRuntimeIdentityFallback,
  type SessionRuntimeIdentityFallbackResult,
} from '@/agent/runtime/identity';
import type {
  ExternalSessionLinkIdentity,
  ExternalSessionExecutionSurface,
} from '@/session/external/providerOps';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

export type CanonicalizedExternalSessionSourceResult = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeIdentity: SessionRuntimeIdentityFallbackResult;
}>;

type ExternalSessionCanonicalizationDeps = Readonly<{
  resolveExternalSessionProviderOps?: (
    agentId: ExternalSessionsAgentId,
  ) => Promise<ExternalSessionExecutionSurface | null>;
}>;

async function resolveExternalSessionProviderOps(
  agentId: ExternalSessionsAgentId,
): Promise<ExternalSessionExecutionSurface | null> {
  return (await resolveBackendExecutionSurfaces(agentId)).externalSession;
}

export async function resolveExternalSessionLinkIdentity(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Record<string, unknown>;
}>, deps: ExternalSessionCanonicalizationDeps = {}): Promise<ExternalSessionLinkIdentity> {
  const resolveOps = deps.resolveExternalSessionProviderOps ?? resolveExternalSessionProviderOps;
  const providerOps = await resolveOps(params.agentId);
  if (!providerOps?.resolveLinkIdentity) {
    return {
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor ?? null,
    };
  }
  return await providerOps.resolveLinkIdentity({
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor ?? null,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

export async function canonicalizeLinkedExternalSessionSource(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>, deps: ExternalSessionCanonicalizationDeps = {}): Promise<CanonicalizedExternalSessionSourceResult> {
  const resolveOps = deps.resolveExternalSessionProviderOps ?? resolveExternalSessionProviderOps;
  const providerOps = await resolveOps(params.agentId);
  const runtimeIdentity = resolveSessionRuntimeIdentityFallback({
    metadata: params.metadata,
    providerDefaults: {
      agentId: params.agentId,
      externalSessionSource: params.source,
      externalSessionRemoteSessionId: params.remoteSessionId,
    },
  });

  if (providerOps?.canonicalizeLinkedSession) {
    const canonicalized = await providerOps.canonicalizeLinkedSession({
      metadata: params.metadata,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
    });
    return {
      remoteSessionId: canonicalized.remoteSessionId,
      source: canonicalized.source,
      runtimeIdentity,
    };
  }

  if (providerOps?.resolveLinkIdentity) {
    const resolved = await providerOps.resolveLinkIdentity({
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      runtimeDescriptor: runtimeIdentity.runtimeDescriptorV1,
      metadata: params.metadata,
    });
    return {
      remoteSessionId: resolved.remoteSessionId,
      source: resolved.source,
      runtimeIdentity,
    };
  }

  return {
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    runtimeIdentity,
  };
}
