import {
  AgentRuntimeDescriptorV1Schema,
  DirectSessionsProviderIdSchema,
  DirectSessionsSourceSchema,
  normalizeCodexBackendMode,
} from '@happier-dev/protocol';
import {
  readOpenCodeSessionRuntimeHandleFromMetadata,
  readSessionMetadataRuntimeDescriptor,
  resolvePersistedCodexRuntimeIdentity,
  type CodexBackendMode,
} from '@happier-dev/agents';
import * as z from 'zod';

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

type CanonicalCodexRuntimeDescriptor = Readonly<{
  providerId: 'codex';
  vendorSessionId: string | null;
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  connectedServiceGroupId: string | null;
  homePath: string | null;
  backendMode?: CodexBackendMode | null;
}>; 

type CanonicalOpenCodeRuntimeDescriptor = Readonly<{
  vendorSessionId: string | null;
  serverBaseUrl: string | null;
}> | null;

function readNestedDirectSessionRuntimeDescriptor(metadata: Record<string, unknown>) {
  const directSession = typeof metadata.directSessionV1 === 'object' && metadata.directSessionV1 && !Array.isArray(metadata.directSessionV1)
    ? metadata.directSessionV1 as Record<string, unknown>
    : null;
  return {
    codex: readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: directSession?.agentRuntimeDescriptorV1 }, 'codex'),
    opencode: readOpenCodeSessionRuntimeHandleFromMetadata({ agentRuntimeDescriptorV1: directSession?.agentRuntimeDescriptorV1 }),
  };
}

function resolveCanonicalDirectSource(params: Readonly<{
  providerId: z.infer<typeof DirectSessionsProviderIdSchema>;
  source: z.infer<typeof DirectSessionsSourceSchema>;
  codexRuntimeDescriptor: CanonicalCodexRuntimeDescriptor | null;
  openCodeRuntimeDescriptor: CanonicalOpenCodeRuntimeDescriptor;
}>): z.infer<typeof DirectSessionsSourceSchema> {
  if (params.providerId === 'codex' && params.source.kind === 'codexHome') {
    const runtime = params.codexRuntimeDescriptor;
    if (!runtime) return params.source;
    return {
      kind: 'codexHome',
      home: runtime.home === 'connectedService' ? 'connectedService' : 'user',
      ...(runtime.connectedServiceId ? { connectedServiceId: runtime.connectedServiceId } : {}),
      ...(runtime.connectedServiceProfileId ? { connectedServiceProfileId: runtime.connectedServiceProfileId } : {}),
      ...(runtime.connectedServiceGroupId ? { connectedServiceGroupId: runtime.connectedServiceGroupId } : {}),
      ...(runtime.homePath ? { homePath: runtime.homePath } : {}),
    };
  }

  if (params.providerId === 'opencode' && params.source.kind === 'opencodeServer') {
    const runtime = params.openCodeRuntimeDescriptor;
    if (!runtime) return params.source;
    return {
      kind: 'opencodeServer',
      ...(runtime.serverBaseUrl ? { baseUrl: runtime.serverBaseUrl } : {}),
      ...(typeof params.source.directory === 'string' ? { directory: params.source.directory } : {}),
    };
  }

  return params.source;
}

/**
 * Rebuild a direct-session identity for a session that takeover.persist converted
 * (directSessionV1 deleted, externalHistoryImportV1 recorded). The identity is
 * machine-scoped to the requesting machine, and the result still has to pass
 * DirectSessionMetadataSchema. Returns null when the record cannot back a relink.
 */
function rebuildDirectSessionMetadataFromImportRecord(
  metadata: Record<string, unknown>,
  requestMachineId: string | undefined,
): Record<string, unknown> | null {
  const machineId = typeof requestMachineId === 'string' ? requestMachineId.trim() : '';
  if (!machineId) return null;

  const importRecord = metadata.externalHistoryImportV1;
  if (!importRecord || typeof importRecord !== 'object' || Array.isArray(importRecord)) return null;
  const record = importRecord as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (!DirectSessionsProviderIdSchema.safeParse(record.providerId).success) return null;
  if (typeof record.remoteSessionId !== 'string' || !record.remoteSessionId.trim()) return null;
  if (!DirectSessionsSourceSchema.safeParse(record.source).success) return null;
  const importedAtMs = record.importedAtMs;
  if (typeof importedAtMs !== 'number' || !Number.isFinite(importedAtMs) || importedAtMs < 0) return null;

  return {
    ...metadata,
    directSessionV1: {
      v: 1,
      providerId: record.providerId,
      machineId,
      remoteSessionId: record.remoteSessionId,
      source: record.source,
      linkedAtMs: Math.trunc(importedAtMs),
    },
  };
}

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

  let parsed = DirectSessionMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    // takeover.persist converts imported sessions by deleting directSessionV1 and recording
    // externalHistoryImportV1. That conversion must not dead-end re-imports of the same remote
    // session: rebuild the direct identity from the import record so a second take-over/import
    // of the same vendor session stays idempotent.
    const rebuilt = rebuildDirectSessionMetadataFromImportRecord(metadata, params.machineId);
    if (rebuilt) {
      parsed = DirectSessionMetadataSchema.safeParse(rebuilt);
    }
  }
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_direct' };
  }

  const direct = parsed.data.directSessionV1;
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsed.data.path === 'string' && parsed.data.path.trim().length > 0 ? parsed.data.path.trim() : null;
  const nestedRuntimeDescriptor = readNestedDirectSessionRuntimeDescriptor(parsed.data);
  const codexRuntimeDescriptor = (nestedRuntimeDescriptor.codex ?? readSessionMetadataRuntimeDescriptor(parsed.data, 'codex')) as CanonicalCodexRuntimeDescriptor | null;
  const openCodeRuntimeDescriptor = (nestedRuntimeDescriptor.opencode ?? readOpenCodeSessionRuntimeHandleFromMetadata(parsed.data)) as CanonicalOpenCodeRuntimeDescriptor;
  const remoteSessionId = direct.providerId === 'codex'
    ? (codexRuntimeDescriptor?.vendorSessionId ?? direct.remoteSessionId)
    : direct.providerId === 'opencode'
      ? (openCodeRuntimeDescriptor?.vendorSessionId ?? direct.remoteSessionId)
      : direct.remoteSessionId;
  const persistedCodexBackendMode = codexRuntimeDescriptor?.backendMode ?? resolvePersistedCodexRuntimeIdentity(parsed.data)?.backendMode ?? null;
  return {
    ok: true,
    session: {
      rawSession,
      metadata,
      sessionPath,
      providerId: direct.providerId,
      machineId: direct.machineId,
      remoteSessionId,
      source: resolveCanonicalDirectSource({
        providerId: direct.providerId,
        source: direct.source,
        codexRuntimeDescriptor,
        openCodeRuntimeDescriptor,
      }),
      codexBackendMode:
        persistedCodexBackendMode
        ?? normalizeCodexBackendMode(direct.codexBackendMode),
    },
  };
}
