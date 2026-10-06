import { SessionPublicLinkCreateActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { generateStoredContentPublicShareMaterialV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { sealPublicShareDataKeyV1 } from '@happier-dev/protocol/crypto/publicShareEncryptedDataKeyEnvelopeV0';

import { getRandomBytes } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';

export type SessionPublicLinkEnvelopeHostErrorCode =
  | 'cancelled'
  | 'session_access_stale_scope'
  | 'session_data_key_unavailable'
  | 'session_access_session_not_found'
  | 'not_authenticated'
  | 'unsupported_action'
  | 'session_access_request_failed';

export class SessionPublicLinkEnvelopeHostError extends Error {
  constructor(
    readonly code: SessionPublicLinkEnvelopeHostErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'SessionPublicLinkEnvelopeHostError';
  }
}

/**
 * Materializes the private physical half of the key-free logical
 * `session.public_link.create` intent. The Home remains the final
 * authorization/currentness owner: this trusted host only opens the exact-Home
 * current Session DEK already available to its bound Account credential and
 * seals it for the locally retained fragment secret. Plain sessions stay key-free.
 * Caller-authored envelopes are rejected by the strict logical parse before
 * any effect.
 */
export async function materializeSessionPublicLinkCreateBody(params: Readonly<{
  token: string;
  credentials: StoredCredentials | undefined;
  serverHttpBaseUrl: string;
  input: unknown;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ lookupId: string; secret: string; keyDerivation: 'fragment_v1'; encryptedDataKey?: string }>> {
  const logical = SessionPublicLinkCreateActionInputV1Schema.parse(params.input);
  const assertCurrent = async (): Promise<void> => {
    if (params.signal?.aborted) {
      throw new SessionPublicLinkEnvelopeHostError('cancelled');
    }
    if (params.isCurrent) {
      let current = false;
      try {
        current = await params.isCurrent();
      } catch {
        current = false;
      }
      if (!current) throw new SessionPublicLinkEnvelopeHostError('session_access_stale_scope');
    }
  };

  await assertCurrent();
  let rawSession: Awaited<ReturnType<typeof fetchSessionById>>;
  try {
    rawSession = await fetchSessionById({
      token: params.token,
      serverUrl: params.serverHttpBaseUrl,
      sessionId: logical.sessionId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw new SessionPublicLinkEnvelopeHostError('cancelled');
    }
    if (isAuthenticationError(error)) {
      throw new SessionPublicLinkEnvelopeHostError('not_authenticated');
    }
    throw new SessionPublicLinkEnvelopeHostError('session_access_request_failed');
  }
  await assertCurrent();
  if (!rawSession || rawSession.id !== logical.sessionId) {
    throw new SessionPublicLinkEnvelopeHostError('session_access_session_not_found', 404);
  }
  const encryptionMode = (rawSession as Readonly<{ encryptionMode?: unknown }>).encryptionMode === 'plain'
    ? 'plain'
    : 'e2ee';
  const material = { ...generateStoredContentPublicShareMaterialV1(getRandomBytes), keyDerivation: 'fragment_v1' as const };
  if (encryptionMode === 'plain') {
    await assertCurrent();
    return material;
  }

  if (!params.credentials || params.credentials.token !== params.token) {
    throw new SessionPublicLinkEnvelopeHostError('session_data_key_unavailable');
  }
  const sessionDataKey = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: (rawSession as Readonly<{ dataEncryptionKey?: unknown }>).dataEncryptionKey,
  });
  if (!sessionDataKey) {
    throw new SessionPublicLinkEnvelopeHostError('session_data_key_unavailable');
  }
  await assertCurrent();
  const encryptedDataKey = sealPublicShareDataKeyV1({ dataKey: sessionDataKey, secret: material.secret, randomBytes: getRandomBytes });
  await assertCurrent();
  return { ...material, encryptedDataKey };
}
