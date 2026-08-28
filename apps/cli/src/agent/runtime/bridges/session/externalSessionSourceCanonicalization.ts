import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import {
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';
import type {
  ExternalSessionExecutionSurface,
  ExternalSessionLinkIdentity,
} from '@/session/external/providerOps';
import {
  resolveExternalSessionLinkIdentityFromSurface,
} from '@/session/external/resolveExternalSessionLinkIdentity';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

export type CanonicalizedExternalSessionSourceResult = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
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

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Selects the canonical descriptor envelope for an Agent surface without
 * interpreting any field inside its opaque `agent` payload.
 */
export function readExternalAgentSurfaceRuntimeDescriptorV1(
  metadata: Readonly<Record<string, unknown>>,
): RuntimeDescriptorV1 | null {
  const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  const linkData = asRecord(linked?.linkData);
  return readRuntimeDescriptorV1FromMetadata({
    runtimeDescriptorV1: linkData?.runtimeDescriptorV1,
  })
    ?? (linked ? readRuntimeDescriptorV1FromMetadata(linked) : null)
    ?? readRuntimeDescriptorV1FromMetadata(metadata);
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
  return await resolveExternalSessionLinkIdentityFromSurface(params, providerOps);
}

export async function canonicalizeLinkedExternalSessionSource(params: Readonly<{
  agentId: ExternalSessionsAgentId;
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>, deps: ExternalSessionCanonicalizationDeps = {}): Promise<CanonicalizedExternalSessionSourceResult> {
  const resolveOps = deps.resolveExternalSessionProviderOps ?? resolveExternalSessionProviderOps;
  const providerOps = await resolveOps(params.agentId);
  const runtimeDescriptorV1 = readExternalAgentSurfaceRuntimeDescriptorV1(params.metadata);

  if (providerOps?.canonicalizeLinkedSession) {
    const canonicalized = await providerOps.canonicalizeLinkedSession({
      metadata: params.metadata,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
    });
    return {
      remoteSessionId: canonicalized.remoteSessionId,
      source: canonicalized.source,
    };
  }

  if (providerOps?.resolveLinkIdentity) {
    const resolved = await resolveExternalSessionLinkIdentityFromSurface(
      {
        agentId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        runtimeDescriptor: runtimeDescriptorV1,
        metadata: params.metadata,
      },
      providerOps,
    );
    return {
      remoteSessionId: resolved.remoteSessionId,
      source: resolved.source,
    };
  }

  return {
    remoteSessionId: params.remoteSessionId,
    source: params.source,
  };
}
