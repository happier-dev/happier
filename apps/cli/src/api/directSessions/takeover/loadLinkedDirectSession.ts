import {
  DirectSessionsProviderIdSchema,
  DirectSessionsSourceSchema,
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1,
  RuntimeDescriptorV1Schema,
  writeRuntimeDescriptorV1ToMetadata,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import {
  resolvePersistedCodexRuntimeIdentity,
  type CodexBackendMode,
} from '@happier-dev/agents';
import * as z from 'zod';

import type { Credentials } from '@/persistence';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  canonicalizeLinkedDirectSessionSource,
  resolveDirectSessionLinkIdentity,
} from '@/agent/runtime/bridges/session/directSessionSourceCanonicalization';

function readDirectSessionRuntimeDescriptor(value: Readonly<Record<string, unknown>>): RuntimeDescriptorV1 | null {
  return readRuntimeDescriptorV1FromMetadata(value)
    ?? readRuntimeDescriptorV1(value.runtimeDescriptorV1);
}

function canonicalizeDirectSessionRuntimeDescriptorIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const metadata = value as Record<string, unknown>;
  const topLevelRuntimeDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const directSession = typeof metadata.directSessionV1 === 'object' && metadata.directSessionV1 && !Array.isArray(metadata.directSessionV1)
    ? metadata.directSessionV1 as Record<string, unknown>
    : null;
  const directSessionRuntimeDescriptor = directSession ? readDirectSessionRuntimeDescriptor(directSession) : null;
  const canonicalMetadata = writeRuntimeDescriptorV1ToMetadata(metadata, topLevelRuntimeDescriptor);

  if (!directSession || !directSessionRuntimeDescriptor) {
    return canonicalMetadata;
  }

  return {
    ...canonicalMetadata,
    directSessionV1: {
      ...writeRuntimeDescriptorV1ToMetadata(directSession, directSessionRuntimeDescriptor),
    },
  };
}

function buildCanonicalLinkedDirectSessionMetadata(
  metadata: Readonly<Record<string, unknown>>,
  directSession: Readonly<Record<string, unknown>>,
  runtimeDescriptorV1: RuntimeDescriptorV1 | null,
): Record<string, unknown> {
  if (!runtimeDescriptorV1) return { ...metadata };

  return {
    ...writeRuntimeDescriptorV1ToMetadata(metadata, runtimeDescriptorV1),
    directSessionV1: {
      ...writeRuntimeDescriptorV1ToMetadata(directSession, runtimeDescriptorV1),
    },
  };
}

const DirectSessionMetadataSchema = z
  .preprocess(canonicalizeDirectSessionRuntimeDescriptorIngress, z.object({
    path: z.string().optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    directSessionV1: z
      .object({
        v: z.literal(1),
        providerId: DirectSessionsProviderIdSchema,
        machineId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        source: DirectSessionsSourceSchema,
        linkedAtMs: z.number().int().min(0),
        codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
        runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
      })
      .passthrough(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough());

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
  const directRuntimeDescriptor = readDirectSessionRuntimeDescriptor(direct);
  const normalizedMetadata = buildCanonicalLinkedDirectSessionMetadata(parsed.data, direct, directRuntimeDescriptor);
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsed.data.path === 'string' && parsed.data.path.trim().length > 0 ? parsed.data.path.trim() : null;
  const canonicalized = directRuntimeDescriptor
    ? await resolveDirectSessionLinkIdentity({
        providerId: direct.providerId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
        runtimeDescriptor: directRuntimeDescriptor,
      })
    : await canonicalizeLinkedDirectSessionSource({
        providerId: direct.providerId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      });
  const persistedCodexBackendMode = resolvePersistedCodexRuntimeIdentity(normalizedMetadata)?.backendMode ?? null;
  return {
    ok: true,
    session: {
      rawSession,
      metadata: normalizedMetadata,
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
