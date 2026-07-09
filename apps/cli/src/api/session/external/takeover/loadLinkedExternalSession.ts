import {
  ExternalSessionsProviderIdSchema,
  ExternalSessionsSourceSchema,
  normalizeLinkedExternalSessionMetadataV1,
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1,
  RuntimeDescriptorV1Schema,
  type RuntimeDescriptorV1,
  type CodexBackendMode,
} from '@happier-dev/protocol';
import {
  resolvePersistedCodexRuntimeIdentity,
} from '@happier-dev/plugins-codex/agent/identity/runtimeDescriptor';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import * as z from 'zod';

import type { Credentials } from '@/persistence';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  canonicalizeLinkedExternalSessionSource,
  resolveExternalSessionLinkIdentity,
} from '@/agent/runtime/bridges/session/externalSessionSourceCanonicalization';

function readExternalSessionRuntimeDescriptor(value: Readonly<Record<string, unknown>>): RuntimeDescriptorV1 | null {
  return readRuntimeDescriptorV1FromMetadata(value)
    ?? readRuntimeDescriptorV1(value.runtimeDescriptorV1);
}

function applyRuntimeDescriptorSessionStateBinding(
  metadata: Readonly<Record<string, unknown>>,
  runtimeDescriptor: RuntimeDescriptorV1 | null,
): Record<string, unknown> {
  return applyRuntimeDescriptorSessionMetadata(
    metadata as Record<string, unknown>,
    runtimeDescriptor,
  );
}

function canonicalizeExternalSessionRuntimeDescriptorIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const metadata = normalizeLinkedExternalSessionMetadataV1(value) ?? value as Record<string, unknown>;
  const topLevelRuntimeDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const externalSession = typeof metadata.externalSessionV1 === 'object' && metadata.externalSessionV1 && !Array.isArray(metadata.externalSessionV1)
    ? metadata.externalSessionV1 as Record<string, unknown>
    : null;
  const externalSessionRuntimeDescriptor = externalSession ? readExternalSessionRuntimeDescriptor(externalSession) : null;
  const canonicalMetadata = applyRuntimeDescriptorSessionStateBinding(metadata, topLevelRuntimeDescriptor);

  if (!externalSession || !externalSessionRuntimeDescriptor) {
    return canonicalMetadata;
  }

  return {
      ...canonicalMetadata,
    externalSessionV1: {
      ...applyRuntimeDescriptorSessionStateBinding(externalSession, externalSessionRuntimeDescriptor),
    },
  };
}

function buildCanonicalLinkedExternalSessionMetadata(
  metadata: Readonly<Record<string, unknown>>,
  externalSession: Readonly<Record<string, unknown>>,
  runtimeDescriptorV1: RuntimeDescriptorV1 | null,
): Record<string, unknown> {
  if (!runtimeDescriptorV1) return { ...metadata };

  return {
    ...applyRuntimeDescriptorSessionStateBinding(metadata, runtimeDescriptorV1),
    externalSessionV1: {
      ...applyRuntimeDescriptorSessionStateBinding(externalSession, runtimeDescriptorV1),
    },
  };
}

const ExternalSessionMetadataSchema = z
  .preprocess(canonicalizeExternalSessionRuntimeDescriptorIngress, z.object({
    path: z.string().optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    externalSessionV1: z
      .object({
        v: z.literal(1),
        providerId: ExternalSessionsProviderIdSchema,
        machineId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        source: ExternalSessionsSourceSchema,
        linkedAtMs: z.number().int().min(0),
        codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
        runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
      })
      .passthrough(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough());

export type LoadedLinkedExternalSession = Readonly<{
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  sessionPath: string | null;
  providerId: z.infer<typeof ExternalSessionsProviderIdSchema>;
  machineId: string;
  remoteSessionId: string;
  source: z.infer<typeof ExternalSessionsSourceSchema>;
  codexBackendMode: CodexBackendMode | null;
}>;

export async function loadLinkedExternalSession(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  machineId?: string;
}>): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedExternalSession }>
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

  const parsed = ExternalSessionMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_external' };
  }

  const direct = parsed.data.externalSessionV1;
  const directRuntimeDescriptor = readExternalSessionRuntimeDescriptor(direct);
  const normalizedMetadata = buildCanonicalLinkedExternalSessionMetadata(parsed.data, direct, directRuntimeDescriptor);
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsed.data.path === 'string' && parsed.data.path.trim().length > 0 ? parsed.data.path.trim() : null;
  const canonicalized = directRuntimeDescriptor
    ? await resolveExternalSessionLinkIdentity({
        providerId: direct.providerId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
        runtimeDescriptor: directRuntimeDescriptor,
      })
    : await canonicalizeLinkedExternalSessionSource({
        providerId: direct.providerId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      });
  const persistedCodexBackendMode = normalizeCodexBackendMode(
    resolvePersistedCodexRuntimeIdentity(normalizedMetadata)?.backendMode,
  );
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
