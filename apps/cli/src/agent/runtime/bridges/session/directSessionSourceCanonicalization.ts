import type {
  DirectSessionsProviderId,
  DirectSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import {
  resolveSessionRuntimeIdentityFallback,
  type SessionRuntimeIdentityFallbackResult,
} from '@/agent/runtime/identity';
import type {
  DirectSessionLinkIdentity,
  DirectSessionProviderOps,
} from '@/session/directSessions/providerOps';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

export type CanonicalizedDirectSessionSourceResult = Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeIdentity: SessionRuntimeIdentityFallbackResult;
}>;

type DirectSessionCanonicalizationDeps = Readonly<{
  resolveDirectSessionProviderOps?: (
    providerId: DirectSessionsProviderId,
  ) => Promise<DirectSessionProviderOps | null>;
}>;

async function resolveDirectSessionProviderOps(
  providerId: DirectSessionsProviderId,
): Promise<DirectSessionProviderOps | null> {
  return (await resolveBackendExecutionSurfaces(providerId)).directSessions;
}

export async function resolveDirectSessionLinkIdentity(params: Readonly<{
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Record<string, unknown>;
}>, deps: DirectSessionCanonicalizationDeps = {}): Promise<DirectSessionLinkIdentity> {
  const resolveOps = deps.resolveDirectSessionProviderOps ?? resolveDirectSessionProviderOps;
  const providerOps = await resolveOps(params.providerId);
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

export async function canonicalizeLinkedDirectSessionSource(params: Readonly<{
  providerId: DirectSessionsProviderId;
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  source: DirectSessionsSource;
}>, deps: DirectSessionCanonicalizationDeps = {}): Promise<CanonicalizedDirectSessionSourceResult> {
  const resolveOps = deps.resolveDirectSessionProviderOps ?? resolveDirectSessionProviderOps;
  const providerOps = await resolveOps(params.providerId);
  const runtimeIdentity = resolveSessionRuntimeIdentityFallback({
    metadata: params.metadata,
    providerDefaults: {
      providerId: params.providerId,
      directSessionSource: params.source,
      directSessionRemoteSessionId: params.remoteSessionId,
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
