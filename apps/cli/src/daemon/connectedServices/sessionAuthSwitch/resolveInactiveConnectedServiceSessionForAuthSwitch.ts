import {
  inferAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import { resolveCatalogAgentId } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';
import { resolveExistingSessionAttachContext } from '@/daemon/sessionEncryption/resolveExistingSessionAttachContext';

type ResolveExistingSessionAttachContext = typeof resolveExistingSessionAttachContext;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function readConnectedServiceMaterializationIdentity(
  raw: unknown,
): ConnectedServiceMaterializationIdentityV1 | null {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function resolveInactiveConnectedServiceSessionForAuthSwitch(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  agentId: CatalogAgentId;
  resolveAttachContext?: ResolveExistingSessionAttachContext;
}>): Promise<Readonly<{
  agentId: CatalogAgentId;
  connectedServices: ConnectedServiceBindingsV1;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  vendorResumeId?: string | null;
  /**
   * The session working directory (from the session metadata `path`). The inactive-switch
   * shared-state continuity check needs this to drive the provider's source-aware resume
   * reachability probe (e.g. the Pi native `~/.pi/agent/sessions/--<cwd>--` root). Without it the
   * switch cannot prove a genuinely-resumable inactive session is reachable and fail-closes.
   */
  cwd?: string | null;
  /**
   * The raw (decrypted) session metadata. Surfaced so the provider-agnostic catalog helper
   * (`resolveConnectedServiceCandidatePersistedSessionFile`) can derive the persisted session-file
   * hint at the call site — the SAME seam the tracked spawn path uses — keeping this resolver free of
   * provider knowledge.
   */
  metadata?: Record<string, unknown> | null;
}> | null> {
  const token = typeof params.credentials.token === 'string' ? params.credentials.token.trim() : '';
  if (!token) return null;

  const resolver = params.resolveAttachContext ?? resolveExistingSessionAttachContext;
  const attachContext = await resolver({
    token,
    sessionId: params.sessionId,
    backendTarget: { kind: 'builtInAgent', agentId: params.agentId },
    credentials: params.credentials,
  }).catch(() => null);
  if (!attachContext?.ok) return null;

  const metadata = attachContext.metadata;
  if (!metadata) return null;
  const inferredAgentId = inferAgentIdFromSessionMetadata(metadata, params.agentId);
  const agentId = resolveCatalogAgentId(inferredAgentId);
  const materializationIdentity = readConnectedServiceMaterializationIdentity(
    metadata.connectedServiceMaterializationIdentityV1,
  );
  const cwd = readNonEmptyString(attachContext.sessionPath)
    ?? readNonEmptyString(metadata.path);
  const vendorResumeId = readNonEmptyString(attachContext.vendorResumeId)
    ?? resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
  return {
    agentId,
    connectedServices: readConnectedServiceBindingsOrEmpty(metadata.connectedServices),
    metadata,
    ...(materializationIdentity ? { connectedServiceMaterializationIdentityV1: materializationIdentity } : {}),
    ...(vendorResumeId ? { vendorResumeId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
