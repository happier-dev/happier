import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { Credentials } from '@/persistence';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import { createSpawnConcurrencyGate, type SpawnConcurrencyGate } from '@/daemon/spawn/createSpawnConcurrencyGate';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { SessionSnapshotRefreshReasonInput } from '@/api/session/sessionSnapshotRefreshReason';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type ExistingSessionAttachContext = Readonly<{
  ok: true;
  attachPayload: SessionAttachFilePayload;
  vendorResumeId: string | null;
  sessionPath: string | null;
  metadata: Record<string, unknown> | null;
}>;

export type ExistingSessionAttachContextFailureReason =
  | 'missingSessionId'
  | 'missingToken'
  | 'notAuthenticated'
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

let existingSessionAttachLookupGate: SpawnConcurrencyGate | null = null;

function getExistingSessionAttachLookupGate(): SpawnConcurrencyGate {
  existingSessionAttachLookupGate ??= createSpawnConcurrencyGate(configuration.daemonReattachCatchUpConcurrency);
  return existingSessionAttachLookupGate;
}

function resolveLastObservedMessageSeq(rawSession: Readonly<{ seq?: unknown }>): number | undefined {
  const seq = rawSession.seq;
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

function resolveExistingSessionMetadata(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): Record<string, unknown> | null {
  return resolveSessionStoredContentEncryptionMode(params.rawSession) === 'plain'
    ? tryParseJsonRecord(typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '')
    : params.credentials
      ? tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession })
      : null;
}

function resolveExistingSessionPath(metadata: Record<string, unknown> | null): string | null {
  const path = typeof metadata?.path === 'string' ? metadata.path.trim() : '';
  return path || null;
}

function buildExistingSessionAttachContext(params: Readonly<{
  rawSession: Readonly<{
    metadata?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
    seq?: unknown;
  }>;
  backendTarget: BackendTargetRefV1;
  credentials: Credentials | null;
}>): ExistingSessionAttachContext | ExistingSessionAttachContextFailure {
  const metadata = resolveExistingSessionMetadata({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  const sessionPath = resolveExistingSessionPath(metadata);
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const lastObservedMessageSeq = resolveLastObservedMessageSeq(params.rawSession);
  if (mode === 'plain') {
    return {
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
      },
      vendorResumeId: resolveVendorResumeIdForExistingSession({
        backendTarget: params.backendTarget,
        credentials: params.credentials,
        rawSession: params.rawSession,
      }),
      sessionPath,
      metadata,
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
      ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
    },
    vendorResumeId: resolveVendorResumeIdForExistingSession({
      backendTarget: params.backendTarget,
      credentials: params.credentials,
      rawSession: params.rawSession,
    }),
    sessionPath,
    metadata,
  };
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  backendTarget: BackendTargetRefV1;
  credentials: Credentials | null;
  reason?: SessionSnapshotRefreshReasonInput;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return { ok: false, reason: 'missingSessionId' };
  if (!token) return { ok: false, reason: 'missingToken' };

  try {
    const raw = await getExistingSessionAttachLookupGate().run(() =>
      fetchSessionByIdCompat({
        token,
        sessionId,
        reason: _params.reason ?? 'manual-recovery',
      }));
    if (!raw) return { ok: false, reason: 'sessionNotFound' };

    return buildExistingSessionAttachContext({
      rawSession: raw,
      backendTarget: _params.backendTarget,
      credentials: _params.credentials,
    });
  } catch (error) {
    if (isAuthenticationError(error)) return { ok: false, reason: 'notAuthenticated' };
    return { ok: false, reason: 'fetchFailed' };
  }
}
