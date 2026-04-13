import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readAcpConfiguredBackendV1FromMetadata, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { Credentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export type ExistingSessionAttachContext = Readonly<{
  ok: true;
  attachPayload: SessionAttachFilePayload;
  vendorResumeId: string | null;
  backendTarget: BackendTargetRefV1 | null;
}>;

export type ExistingSessionAttachContextFailureReason =
  | 'missingSessionId'
  | 'missingToken'
  | 'fetchFailed'
  | 'sessionNotFound'
  | 'missingCredentials'
  | 'invalidEncryptionKey';

export type ExistingSessionAttachContextFailure = Readonly<{
  ok: false;
  reason: ExistingSessionAttachContextFailureReason;
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tryReadExistingSessionMetadataRecord(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): Record<string, unknown> | null {
  const rawMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
  if (!rawMetadata) return null;
  if (params.rawSession.encryptionMode === 'plain') {
    return tryParseJsonRecord(rawMetadata);
  }
  if (!params.credentials) return null;
  return tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  });
}

function readConfiguredAcpBackendIdFromFlavor(metadata: Record<string, unknown>): string | null {
  const flavor = typeof metadata.flavor === 'string' ? metadata.flavor.trim() : '';
  if (!flavor.startsWith('acp:')) return null;
  const backendId = flavor.slice(4).trim();
  return backendId || null;
}

function resolveExistingSessionBackendTarget(metadataRecord: Record<string, unknown> | null): BackendTargetRefV1 | null {
  if (!metadataRecord) return null;

  const configuredBackendId = readAcpConfiguredBackendV1FromMetadata(metadataRecord)?.backendId
    ?? readConfiguredAcpBackendIdFromFlavor(metadataRecord);
  if (configuredBackendId) {
    return {
      kind: 'configuredAcpBackend',
      backendId: configuredBackendId,
    };
  }

  const agentId = resolveAgentIdFromSessionMetadata(metadataRecord);
  if (!agentId || agentId === 'customAcp') {
    return null;
  }

  return {
    kind: 'builtInAgent',
    agentId,
  };
}

function buildExistingSessionAttachContext(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): ExistingSessionAttachContext | ExistingSessionAttachContextFailure {
  const metadataRecord = tryReadExistingSessionMetadataRecord({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  const backendTarget = resolveExistingSessionBackendTarget(metadataRecord);
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return {
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      backendTarget,
      vendorResumeId: resolveVendorResumeIdForExistingSession({
        agent: undefined,
        credentials: params.credentials,
        metadataRecord,
        rawSession: params.rawSession,
      }),
    };
  }

  if (!params.credentials) return { ok: false, reason: 'missingCredentials' };

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  if (ctx.encryptionKey.length !== 32) return { ok: false, reason: 'invalidEncryptionKey' };

  return {
    ok: true,
    attachPayload: {
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
      encryptionVariant: ctx.encryptionVariant,
    },
    backendTarget,
    vendorResumeId: resolveVendorResumeIdForExistingSession({
      agent: undefined,
      credentials: params.credentials,
      metadataRecord,
      rawSession: params.rawSession,
    }),
  };
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  credentials: Credentials | null;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return { ok: false, reason: 'missingSessionId' };
  if (!token) return { ok: false, reason: 'missingToken' };

  try {
    const raw = await fetchSessionByIdCompat({ token, sessionId });
    if (!raw) return { ok: false, reason: 'sessionNotFound' };

    return buildExistingSessionAttachContext({
      rawSession: raw,
      credentials: _params.credentials,
    });
  } catch {
    return { ok: false, reason: 'fetchFailed' };
  }
}
