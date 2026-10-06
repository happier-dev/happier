import axios from 'axios';
import { SessionAccessGrantSetActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { SessionAccessErrorCodeV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { SessionAccessErrorCodeV1, SetSessionAccessGrantRequestV1 } from '@happier-dev/protocol';

import { getRandomBytes } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  resolveVerifiedSessionRecipientContentPublicKey,
  SessionRecipientEnvelopeBindingError,
} from '@/api/session/sessionRecipientEnvelopeBinding';

export class SessionAccessGrantEnvelopeHostError extends Error {
  constructor(
    readonly code: SessionAccessErrorCodeV1
      | 'session_data_key_unavailable'
      | 'session_access_request_failed'
      | 'session_access_stale_scope'
      | 'not_authenticated'
      | 'unsupported_action',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'SessionAccessGrantEnvelopeHostError';
  }
}

function authorizationHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function throwReadFailure(params: Readonly<{
  status: number;
  data: unknown;
  missing: 'session_access_subject_not_found' | 'unsupported_action';
}>): never {
  const record = params.data !== null && typeof params.data === 'object'
    ? params.data as Readonly<Record<string, unknown>>
    : null;
  const named = SessionAccessErrorCodeV1Schema.safeParse(record?.error);
  if (named.success) {
    throw new SessionAccessGrantEnvelopeHostError(named.data, params.status);
  }
  if (params.status === 401 || params.status === 403) {
    throw new SessionAccessGrantEnvelopeHostError('not_authenticated', params.status);
  }
  if (params.status === 404) {
    throw new SessionAccessGrantEnvelopeHostError(params.missing, params.status);
  }
  if (params.status === 405 || params.status === 501) {
    throw new SessionAccessGrantEnvelopeHostError('unsupported_action', params.status);
  }
  throw new SessionAccessGrantEnvelopeHostError('session_access_request_failed', params.status);
}

/**
 * Materializes the private physical half of a key-free direct-grant Action.
 *
 * The Home remains the final authorization/currentness owner. This trusted
 * host only opens material already available to its exact Account credential,
 * verifies the recipient binding, and seals the existing Session DEK. Team,
 * Group, Plain, and recipient-setup paths remain key-free; an existing grant
 * is not treated as proof that its recipient-envelope tuple is usable.
 */
export async function materializeSessionAccessGrantEnvelope(params: Readonly<{
  token: string;
  credentials: StoredCredentials | undefined;
  serverHttpBaseUrl: string;
  /** Exact Home feature projection; only an explicit current-access decision may widen detail. */
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  input: unknown;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  input: SetSessionAccessGrantRequestV1;
  retainedEnvelopeFallback: boolean;
}>> {
  const logical = SessionAccessGrantSetActionInputV1Schema.parse(params.input);
  if (logical.subject.kind !== 'account') {
    return { input: logical, retainedEnvelopeFallback: false };
  }
  const recipientAccountId = logical.subject.accountId;
  const assertCurrent = async (): Promise<void> => {
    if (params.signal?.aborted) {
      throw new SessionAccessGrantEnvelopeHostError('session_access_stale_scope');
    }
    if (params.isCurrent) {
      let current = false;
      try {
        current = await params.isCurrent();
      } catch {
        current = false;
      }
      if (!current) throw new SessionAccessGrantEnvelopeHostError('session_access_stale_scope');
    }
  };

  await assertCurrent();
  const rawSession = await fetchSessionById({
    token: params.token,
    serverUrl: params.serverHttpBaseUrl,
    sessionId: logical.sessionId,
    ...(params.serverFeaturesSnapshot
      ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  await assertCurrent();
  if (!rawSession || rawSession.id !== logical.sessionId) {
    throw new SessionAccessGrantEnvelopeHostError('session_access_session_not_found', 404);
  }
  if (rawSession.encryptionMode === 'plain') {
    return { input: logical, retainedEnvelopeFallback: false };
  }

  if (!params.credentials || params.credentials.token !== params.token) {
    return { input: logical, retainedEnvelopeFallback: true };
  }

  const sessionDataKey = openSessionDataEncryptionKey({
    credential: params.credentials,
    encryptedDataEncryptionKeyBase64: rawSession.dataEncryptionKey,
  });
  if (!sessionDataKey) {
    return { input: logical, retainedEnvelopeFallback: true };
  }
  await assertCurrent();

  const recipientResponse = await axios.get<unknown>(
    `${params.serverHttpBaseUrl}/v1/user/${encodeURIComponent(recipientAccountId)}`,
    {
      headers: authorizationHeaders(params.token),
      timeout: configuration.sessionControlHttpTimeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    },
  );
  await assertCurrent();
  if (recipientResponse.status !== 200) {
    throwReadFailure({
      status: recipientResponse.status,
      data: recipientResponse.data,
      missing: 'session_access_subject_not_found',
    });
  }
  let recipientContentPublicKey: ReturnType<typeof resolveVerifiedSessionRecipientContentPublicKey>;
  try {
    recipientContentPublicKey = resolveVerifiedSessionRecipientContentPublicKey(recipientResponse.data);
  } catch (error) {
    if (error instanceof SessionRecipientEnvelopeBindingError) {
      throw new SessionAccessGrantEnvelopeHostError(error.code);
    }
    throw error;
  }
  if (recipientContentPublicKey === null) {
    return { input: logical, retainedEnvelopeFallback: false };
  }

  const encryptedDataKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: sessionDataKey,
    recipientPublicKey: recipientContentPublicKey,
    randomBytes: getRandomBytes,
  }));
  await assertCurrent();

  return {
    input: {
      ...logical,
      accountEnvelopeInput: {
        v: 1,
        encryptedDataKey,
      },
    },
    retainedEnvelopeFallback: false,
  };
}
