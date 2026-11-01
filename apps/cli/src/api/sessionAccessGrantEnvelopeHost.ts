import axios from 'axios';
import { SessionAccessGrantSetActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { SessionAccessErrorCodeV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { addSessionTeamsToShareStatementV1, SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionAccessErrorCodeV1, SetSessionAccessGrantRequestV1 } from '@happier-dev/protocol';

import { getRandomBytes } from '@/api/encryption';
import { openSessionDataEncryptionKeyForReseal } from '@/api/client/openSessionDataEncryptionKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  resolveVerifiedSessionRecipientContentPublicKey,
  SessionRecipientEnvelopeBindingError,
} from '@/api/session/sessionRecipientEnvelopeBinding';
import { runSessionRecipientEnvelopePass } from '@/api/session/sessionCreationInitialAccess';

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
 * States, on a device holding the key, that this Session is shared with a Team. It lands
 * before the grant so a member's wake finds it. Failing it never fails the grant: the
 * Session stays on the manager path, and the Team share keeps its key-free contract.
 */
export async function recordSessionTeamShareStatement(params: Readonly<{
  token: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  sessionId: string;
  teamId: string;
  signal?: AbortSignal;
}>): Promise<void> {
  try {
    const session = await fetchSessionById({
        token: params.token,
      serverUrl: params.serverHttpBaseUrl,
      sessionId: params.sessionId,
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!session || session.encryptionMode === 'plain') return;
    if (!openSessionDataEncryptionKeyForReseal({ credential: params.credentials, session })) return;
    await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => updateSessionMetadataWithRetry({
      token: params.token,
      credentials: params.credentials,
      sessionId: params.sessionId,
      rawSession: session,
      updater: metadata => addSessionTeamsToShareStatementV1(metadata, [params.teamId]),
      ...(params.signal ? { currentness: { signal: params.signal } } : {}),
    }));
  } catch (error) {
    if (params.signal?.aborted) throw error;
    logger.warn('[SESSION ACCESS] Team share statement not recorded', {
      sessionId: params.sessionId, code: error instanceof Error && 'code' in error ? error.code : 'unknown',
    });
  }
}

/**
 * Delivers one Session's owed recipient keys from this key holder's own envelope.
 *
 * The Home's audience census is the only worklist, so the history horizon, removal and
 * recipient readiness stay its decisions; a wake carries no recipient. Sealed bytes are
 * all the Home receives. Recipients stay pending unless the key opens this Session's own
 * metadata and that metadata holds a key holder's Team share statement. This proves key
 * possession only: the Home still decides who is in that Team.
 */
export async function prepareSessionRecipientEnvelopes(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  sessionId: string;
  signal: AbortSignal;
  isScopeCurrent: () => boolean;
}>): Promise<void> {
  await runSessionRecipientEnvelopePass({
    sessionId: params.sessionId,
    token: params.credentials.token,
    serverHttpBaseUrl: params.serverHttpBaseUrl,
    signal: params.signal,
    isScopeCurrent: params.isScopeCurrent,
    resolveSessionDataKey: async () => {
      const session = await fetchSessionById({
            token: params.credentials.token,
        serverUrl: params.serverHttpBaseUrl,
        sessionId: params.sessionId,
        signal: params.signal,
      });
      if (!session) return null;
      const opened = openSessionDataEncryptionKeyForReseal({ credential: params.credentials, session });
      return opened?.sharedMetadata.teamShareStatementV1 ? opened.dataKey : null;
    },
  });
}

/**
 * Materializes the private physical half of a key-free direct-grant Action.
 *
 * The Home remains the final authorization/currentness owner. This trusted
 * host only opens material already available to its exact Account credential,
 * verifies the recipient binding, and seals the existing Session DEK. Team,
 * Group, Plain, and recipient-setup paths remain key-free, though a Team or Group
 * share first records this holder's share statement; an existing grant
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
  /** Set when only the owner's layout update lets this host seal the key. */
  repairActionId?: 'session.access.layout.update';
}>> {
  const logical = SessionAccessGrantSetActionInputV1Schema.parse(params.input);
  if (logical.subject.kind !== 'account') {
    if (params.credentials?.token === params.token) {
      await recordSessionTeamShareStatement({
        token: params.token,
        credentials: params.credentials,
        serverHttpBaseUrl: params.serverHttpBaseUrl,
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
        sessionId: logical.sessionId,
        teamId: logical.subject.teamId,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    }
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

  // The Home names this key; only one that opens this Session's metadata is sealed onward.
  const sessionDataKey = openSessionDataEncryptionKeyForReseal({ credential: params.credentials, session: rawSession })?.dataKey;
  if (!sessionDataKey) {
    return rawSession.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
      ? { input: logical, retainedEnvelopeFallback: true }
      : { input: logical, retainedEnvelopeFallback: true, repairActionId: 'session.access.layout.update' };
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
