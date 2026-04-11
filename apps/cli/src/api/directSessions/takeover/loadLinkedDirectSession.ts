import {
  AgentRuntimeDescriptorV1Schema,
  DirectSessionsProviderIdSchema,
  DirectSessionsSourceSchema,
  normalizeCodexBackendMode,
} from '@happier-dev/protocol';
import {
  resolvePersistedCodexRuntimeIdentity,
  type CodexBackendMode,
} from '@happier-dev/agents';
import * as z from 'zod';

import { getDirectSessionProviderOps } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';

const DirectSessionMetadataSchema = z
  .object({
    path: z.string().optional(),
    directSessionV1: z
      .object({
        v: z.literal(1),
        providerId: DirectSessionsProviderIdSchema,
        machineId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        source: DirectSessionsSourceSchema,
        linkedAtMs: z.number().int().min(0),
        codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
        agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
      })
      .passthrough(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough();

export type LoadedLinkedDirectSession = Readonly<{
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  sessionPath: string | null;
  providerId: z.infer<typeof DirectSessionsProviderIdSchema>;
  machineId: string;
  remoteSessionId: string;
  source: z.infer<typeof DirectSessionsSourceSchema>;
  codexBackendMode: CodexBackendMode | null;
}>;

export async function loadLinkedDirectSession(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  machineId?: string;
}>): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedDirectSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'provider_unavailable'; error: string }>
> {
  const rawSession = await fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId }).catch(() => null);
  if (!rawSession) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_not_found' };
  }

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
  if (!metadata) {
    return { ok: false, errorCode: 'provider_unavailable', error: 'session_metadata_unavailable' };
  }

  const parsed = DirectSessionMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_direct' };
  }

  const direct = parsed.data.directSessionV1;
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsed.data.path === 'string' && parsed.data.path.trim().length > 0 ? parsed.data.path.trim() : null;
  const providerOps = await getDirectSessionProviderOps(direct.providerId).catch(() => null);
  const canonicalized = providerOps?.canonicalizeLinkedSession
    ? await providerOps.canonicalizeLinkedSession({
        metadata: parsed.data,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      })
    : {
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      };
  const persistedCodexBackendMode = resolvePersistedCodexRuntimeIdentity(parsed.data)?.backendMode ?? null;
  return {
    ok: true,
    session: {
      rawSession,
      metadata,
      sessionPath,
      providerId: direct.providerId,
      machineId: direct.machineId,
      remoteSessionId: canonicalized.remoteSessionId,
      source: canonicalized.source,
      codexBackendMode:
        persistedCodexBackendMode
        ?? normalizeCodexBackendMode(direct.codexBackendMode),
    },
  };
}
