import {
  encodeBase64,
  ENCRYPTED_DATA_KEY_V1_BYTES,
  PatchSessionDataKeyEnvelopesResultV1Schema,
  PatchSessionDataKeyEnvelopesV1Schema,
  prepareSessionDataKeyEnvelopeItemV1,
  runSessionDataKeyPreparationPass,
  SessionDataKeyEnvelopePageV1Schema,
  type PatchSessionDataKeyEnvelopesV1,
  type SessionDataKeyEnvelopeItemV1,
  type SessionDataKeyPreparationPassResult,
  OperationUpdateRequiredV1Schema,
  sealEncryptedDataKeyEnvelopeV1,
  SessionInitialAccessDraftV1Schema,
  SessionInitialAccessMaterializedV1Schema,
  SessionSpawnNewInputV2Schema,
  SessionAccessErrorCodeV1Schema,
  type OperationUpdateRequiredV1,
  type SessionAccessErrorCodeV1,
  type SessionInitialAccessDraftV1,
  type SessionInitialAccessMaterializedV1,
} from '@happier-dev/protocol';
import axios from 'axios';
import { setImmediate } from 'node:timers/promises';

import { getRandomBytes } from '@/api/encryption';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  resolveVerifiedSessionRecipientContentPublicKey,
  SessionRecipientEnvelopeBindingError,
} from './sessionRecipientEnvelopeBinding';

export class SessionInitialAccessEnvelopeHostError extends Error {
  constructor(
    readonly code:
      | 'not_authenticated'
      | 'recipient_key_unavailable'
      | 'session_access_invalid_recipient_envelope'
      | 'session_access_request_failed'
      | 'session_access_subject_not_found'
      | 'session_data_key_unavailable'
      | 'unsupported_action',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'SessionInitialAccessEnvelopeHostError';
  }
}

/**
 * Collective grants commit with the row. The physical creator then prepares
 * their authorized audience using the returned row's opened standalone key,
 * never a new proposed key on create-or-rejoin. Plain Sessions need no work.
 */
export async function prepareSessionInitialAccessDataKeyEnvelopes(params: Readonly<{
  fields: Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }>;
  sessionId: string;
  sessionEncryptionMode: 'plain' | 'e2ee';
  resolveSessionDataKey: () => Uint8Array | null;
  token: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
  isScopeCurrent?: () => boolean;
}>): Promise<SessionDataKeyPreparationPassResult | undefined> {
  const collective = params.fields.initialAccess?.grants.some(grant => grant.subject.kind !== 'account')
    || Boolean(params.fields.primaryTeamId);
  if (!collective || params.sessionEncryptionMode === 'plain') return;
  params.signal?.throwIfAborted();
  const key = params.resolveSessionDataKey();
  if (!key || key.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) {
    throw new SessionInitialAccessEnvelopeHostError('session_data_key_unavailable');
  }
  const url = `${params.serverHttpBaseUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/data-key/envelopes`;
  const options = {
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    timeout: configuration.sessionControlHttpTimeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  };
  const assertResponse = (status: number) => {
    if (status === 401 || status === 403) throw new SessionInitialAccessEnvelopeHostError('not_authenticated', status);
    if (status !== 200) throw new SessionInitialAccessEnvelopeHostError('session_access_request_failed', status);
  };
  const result = await runSessionDataKeyPreparationPass<SessionDataKeyEnvelopeItemV1, PatchSessionDataKeyEnvelopesV1['entries'][number]>({
    fetchPage: async cursor => {
      const response = await axios.get<unknown>(url, { ...options,
        params: { state: 'action_required', ...(cursor ? { cursor } : {}) } });
      assertResponse(response.status);
      const page = SessionDataKeyEnvelopePageV1Schema.parse(response.data);
      return page.status === 'not_required' ? { items: [], nextCursor: null } : page;
    },
    itemKey: item => item.recipientAccountId,
    prepareEntries: async items => {
      const entries: Array<PatchSessionDataKeyEnvelopesV1['entries'][number]> = [];
      const failedItemKeys: string[] = [];
      for (const item of items) {
        params.signal?.throwIfAborted();
        const prepared = prepareSessionDataKeyEnvelopeItemV1({ item, sessionDataKey: key, randomBytes: getRandomBytes });
        if (prepared.kind === 'prepared') entries.push(prepared.entry);
        else failedItemKeys.push(item.recipientAccountId);
        // The daemon stays steerable during fan-out; paging is not a crypto slice.
        await setImmediate();
      }
      return { entries, failedItemKeys };
    },
    commitEntries: async entries => {
      const response = await axios.patch<unknown>(url, PatchSessionDataKeyEnvelopesV1Schema.parse({ entries }), options);
      assertResponse(response.status);
      return PatchSessionDataKeyEnvelopesResultV1Schema.parse(response.data).appliedCount;
    },
    isScopeCurrent: () => !params.signal?.aborted && (params.isScopeCurrent?.() ?? true),
  });
  params.signal?.throwIfAborted();
  if (result.status === 'scope_changed') throw new SessionInitialAccessEnvelopeHostError('session_access_request_failed');
  return result;
}

/**
 * A genuinely older component: the target daemon cannot carry initial access,
 * or the Home cannot project recipient readiness. Session sharing being off on
 * this Home is not this error; it is the typed `SessionInitialAccessServerError`
 * `session_access_sharing_unavailable`.
 */
export class SessionInitialAccessUpdateRequiredError extends Error implements OperationUpdateRequiredV1 {
  readonly kind = 'update_required' as const;
  readonly code = 'update_required' as const;
  readonly operation = 'session.spawn_new' as const;
  readonly reason = 'session_initial_access_update_required' as const;
  readonly retryable = false;
  readonly details: OperationUpdateRequiredV1;

  constructor(readonly component: OperationUpdateRequiredV1['component'] = 'server') {
    super('Session initial access requires updated collaboration support');
    this.name = 'SessionInitialAccessUpdateRequiredError';
    this.details = { kind: this.kind, operation: this.operation, reason: this.reason, component };
  }
}

/**
 * Operation-scoped downgrade for a credential-bound create against a Home
 * without the Team-credential feature. The server creates no Session with a
 * lost binding; the caller refuses only this operation and keeps ordinary
 * Session/Home/Provider flows usable. Never strips the binding and retries
 * as a private Session.
 */
export class SessionTeamCredentialBindingUpdateRequiredError extends Error implements OperationUpdateRequiredV1 {
  readonly kind = 'update_required' as const;
  readonly code = 'update_required' as const;
  readonly operation = 'session.spawn_new' as const;
  readonly reason = 'session_team_credential_binding_update_required' as const;
  readonly retryable = false;
  readonly details: OperationUpdateRequiredV1;

  constructor(readonly component: OperationUpdateRequiredV1['component'] = 'server') {
    super('Session Team-credential binding requires updated Team credential support');
    this.name = 'SessionTeamCredentialBindingUpdateRequiredError';
    this.details = { kind: this.kind, operation: this.operation, reason: this.reason, component };
  }
}

/**
 * A strict access rejection returned by the atomic Session-create boundary, or
 * the same answer read from the Home's own `sharing.session` decision before POST.
 */
export class SessionInitialAccessServerError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: SessionAccessErrorCodeV1,
    readonly status: number,
  ) {
    super(code);
    this.name = 'SessionInitialAccessServerError';
  }
}

/** Both HTTP creators preserve authority as top-level fresh-create fields. */
export function buildSessionInitialAccessCreateFields(
  input: Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }>,
  serverSnapshot: CliServerFeaturesSnapshot,
): Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }> {
  const initialAccess = input.initialAccess === undefined
    ? undefined
    : SessionInitialAccessDraftV1Schema.parse(input.initialAccess);
  const primaryTeamId = SessionSpawnNewInputV2Schema.shape.primaryTeamId.parse(input.primaryTeamId);
  if (initialAccess === undefined && primaryTeamId === undefined) return {};
  const decision = resolveCliFeatureDecision({
    featureId: 'sharing.session',
    env: process.env,
    serverSnapshot,
  });
  // The Home's decision is the same one its atomic create enforces, so the
  // refusal is that create's typed answer rather than an update requirement.
  if (decision.state !== 'enabled') {
    throw new SessionInitialAccessServerError('session_access_sharing_unavailable', 409);
  }
  return {
    ...(initialAccess !== undefined ? { initialAccess } : {}),
    ...(primaryTeamId !== undefined ? { primaryTeamId } : {}),
  };
}

/**
 * Adds direct-recipient envelopes only to the private physical create body.
 * The authoring draft remains key-free; collective/Plain grants bypass crypto,
 * and canonical setup-pending readiness remains a valid pending grant.
 */
export async function materializeSessionInitialAccessCreateFields(params: Readonly<{
  fields: Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }>;
  sessionEncryptionMode: 'e2ee' | 'plain';
  sessionDataKey: Uint8Array | null;
  token: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ initialAccess?: SessionInitialAccessMaterializedV1; primaryTeamId?: string | null }>> {
  if (params.sessionEncryptionMode === 'plain' || params.fields.initialAccess === undefined) {
    return params.fields;
  }

  const grants = await Promise.all(params.fields.initialAccess.grants.map(async (grant) => {
    if (grant.subject.kind !== 'account') return grant;
    const response = await axios.get<unknown>(
      `${params.serverHttpBaseUrl}/v1/user/${encodeURIComponent(grant.subject.accountId)}`,
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        validateStatus: () => true,
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new SessionInitialAccessEnvelopeHostError('not_authenticated', response.status);
    }
    if (response.status === 404) {
      throw new SessionInitialAccessEnvelopeHostError('session_access_subject_not_found', response.status);
    }
    if (response.status !== 200) {
      throw new SessionInitialAccessEnvelopeHostError('session_access_request_failed', response.status);
    }

    let recipientContentPublicKey: ReturnType<typeof resolveVerifiedSessionRecipientContentPublicKey>;
    try {
      recipientContentPublicKey = resolveVerifiedSessionRecipientContentPublicKey(response.data);
    } catch (error) {
      if (error instanceof SessionRecipientEnvelopeBindingError) {
        if (error.code === 'unsupported_action') {
          throw new SessionInitialAccessUpdateRequiredError('server');
        }
        throw new SessionInitialAccessEnvelopeHostError(error.code);
      }
      throw error;
    }

    // Caller-authored creation remains key-free. If an internal caller carries
    // stale physical material, replace it from current server readiness rather
    // than turning the caller into a second key-currentness authority.
    const keyFreeGrant = {
      subject: grant.subject,
      accessLevel: grant.accessLevel,
      canApprovePermissions: grant.canApprovePermissions,
    };
    if (recipientContentPublicKey === null) return keyFreeGrant;
    if (params.sessionDataKey === null) {
      throw new SessionInitialAccessEnvelopeHostError('session_data_key_unavailable');
    }
    return {
      ...keyFreeGrant,
      accountEnvelopeInput: {
        v: 1 as const,
        encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
          dataKey: params.sessionDataKey,
          recipientPublicKey: recipientContentPublicKey,
          randomBytes: getRandomBytes,
        })),
      },
    };
  }));

  return {
    ...params.fields,
    initialAccess: SessionInitialAccessMaterializedV1Schema.parse({ grants }),
  };
}

/**
 * Maps only the canonical Team-credential binding refusal to a typed
 * no-effect downgrade. Every other transport failure remains indeterminate
 * rather than a false "nothing happened"; unrelated Session operations stay
 * usable and no Session is created with a stripped binding.
 */
export function readSessionTeamCredentialBindingUpdateRequiredError(body: unknown): SessionTeamCredentialBindingUpdateRequiredError | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { error, ...details } = body as Record<string, unknown>;
  if (error !== 'update_required') return null;
  const parsed = OperationUpdateRequiredV1Schema.safeParse(details);
  if (
    !parsed.success
    || parsed.data.operation !== 'session.spawn_new'
    || parsed.data.reason !== 'session_team_credential_binding_update_required'
    || parsed.data.component !== 'server'
  ) return null;
  return new SessionTeamCredentialBindingUpdateRequiredError(parsed.data.component);
}

/** Preserve only the protocol-owned, secret-free Session access error code. */
export function readSessionInitialAccessServerError(
  body: unknown,
  status: number,
): SessionInitialAccessServerError | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const parsed = SessionAccessErrorCodeV1Schema.safeParse(
    (body as Readonly<Record<string, unknown>>).error,
  );
  return parsed.success ? new SessionInitialAccessServerError(parsed.data, status) : null;
}
