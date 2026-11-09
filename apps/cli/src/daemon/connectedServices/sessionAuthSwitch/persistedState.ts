import type { ConnectedServiceBindingsV2, ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata, resolveAgentNativeTranscriptPathFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type { CatalogAgentId } from '@/agent/catalog/types';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { readConnectedServiceBindingsOrEmpty } from "@/daemon/connectedServices/sessionAuthSwitch/credentialApplicationState";
import { readConnectedServiceMaterializationIdentityFromMetadata } from "@/daemon/connectedServices/materialization/identity";

export function tryReadSessionMetadataRecord(
  input: Readonly<{
    rawSession: Readonly<{
      metadata?: unknown;
      encryptionMode?: unknown;
      metadataLayoutVersion?: unknown;
      ownerMetadata?: unknown;
      dataEncryptionKey?: unknown;
    }>;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  }>,
): Record<string, unknown> | null {
  return tryDecryptSessionOwnerMetadataView({
    credentials: input.credentials,
    accountEncryptionMode: input.accountEncryptionMode,
    rawSession: input.rawSession,
  });
}

export async function resolvePersistedConnectedServiceSwitchSessionState(
  input: Readonly<{
    token: string;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    sessionId: string;
  }>,
): Promise<Readonly<{ metadata: Record<string, unknown> | null; archivedAt: unknown }>> {
  const token = input.token.trim();
  if (!token) return { metadata: null, archivedAt: undefined };
  const [rawSession, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionByIdCompat({ reason: 'session-control',
      token,
      sessionId: input.sessionId,
    }),
    fetchAccountEncryptionCurrentness({ token }),
  ]);
  if (!rawSession) return { metadata: null, archivedAt: undefined };
  const metadata = tryReadSessionMetadataRecord({
    rawSession,
    credentials: input.credentials,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
  });
  return { metadata, archivedAt: rawSession.archivedAt };
}

export async function resolveInactiveConnectedServiceSessionContext(
  input: Readonly<{
    token: string;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    sessionId: string;
    currentMachineId: string;
  }>,
): Promise<Readonly<{
  /** Absent when the Session declares no Agent this daemon has installed. */
  agentId: CatalogAgentId | null;
  connectedServices: ConnectedServiceBindingsV2;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  vendorResumeId?: string;
  /**
   * Session working directory (from the decrypted session metadata `path`). The inactive-switch
   * shared-state continuity check needs it to drive the source-aware resume-reachability probe and
   * to reconstruct the deterministic target materialized root; without it the switch fail-closes a
   * genuinely-resumable inactive session.
   */
  cwd?: string;
  /**
   * Provider-owned persisted vendor session-file hint derived from inactive session metadata.
   * Shared daemon continuity code must obtain this through the backend catalog, not by reading
   * provider-specific metadata fields directly.
   */
  candidatePersistedSessionFile?: string;
  metadata?: Record<string, unknown> | null;
}> | null> {
  const [rawSession, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionByIdCompat({ reason: 'session-control',
      token: input.token,
      sessionId: input.sessionId,
    }),
    fetchAccountEncryptionCurrentness({ token: input.token }),
  ]);
  const metadata = rawSession
    ? tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
      })
    : null;
  if (!metadata) return null;
  const agentId = resolveCatalogAgentId(
    resolveAgentIdFromSessionMetadata(metadata),
  );
  const materializationIdentity =
    readConnectedServiceMaterializationIdentityFromMetadata(metadata);
  const vendorResumeId = agentId
    ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
    : null;
  const candidatePersistedSessionFile = agentId
    ? resolveAgentNativeTranscriptPathFromSessionMetadata(agentId, metadata)
    : null;
  const cwd = resolveSessionMachineWorkspacePath({
    metadata,
    currentMachineId: input.currentMachineId,
    candidatePath: metadata.path,
  });
  return {
    agentId,
    metadata,
    connectedServices: readConnectedServiceBindingsOrEmpty(
      metadata.connectedServices,
    ),
    ...(materializationIdentity
      ? { connectedServiceMaterializationIdentityV1: materializationIdentity }
      : {}),
    ...(vendorResumeId ? { vendorResumeId } : {}),
    ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
