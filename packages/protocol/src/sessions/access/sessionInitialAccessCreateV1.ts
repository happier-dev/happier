import { encodeBase64 } from '../../crypto/base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { addSessionTeamsToShareStatementV1 } from '../metadata/sessionMetadataSchemasV1.js';
import { SessionInitialAccessMaterializedV1Schema, type SessionInitialAccessDraftV1, type SessionInitialAccessMaterializedV1 } from './sessionInitialAccessDraftV1.js';

export class SessionInitialAccessEnvelopeHostError extends Error {
  constructor(
    readonly code:
      | 'not_authenticated'
      | 'credential_scope_denied'
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

/** A creator's collective E2EE grants carry their share statement from birth. */
export function addSessionInitialAccessTeamShareStatement<T extends Readonly<Record<string, unknown>>>(
  metadata: T,
  fields: Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }>,
  sessionEncryptionMode: 'e2ee' | 'plain',
): T {
  if (sessionEncryptionMode === 'plain') return metadata;
  return addSessionTeamsToShareStatementV1(metadata, [
    ...(fields.primaryTeamId ? [fields.primaryTeamId] : []),
    ...(fields.initialAccess?.grants ?? []).flatMap(({ subject }) => subject.kind === 'account' ? [] : [subject.teamId]),
  ]);
}

/** Materializes direct-recipient grants using the canonical verified recipient-key adapter. */
export async function materializeSessionInitialAccessCreateFields(params: Readonly<{
  fields: Readonly<{ initialAccess?: SessionInitialAccessDraftV1; primaryTeamId?: string | null }>;
  sessionEncryptionMode: 'e2ee' | 'plain';
  sessionDataKey: Uint8Array | null;
  randomBytes(length: number): Uint8Array;
  resolveRecipientContentPublicKey(accountId: string): Promise<Uint8Array | null>;
}>): Promise<Readonly<{ initialAccess?: SessionInitialAccessMaterializedV1; primaryTeamId?: string | null }>> {
  if (params.sessionEncryptionMode === 'plain' || params.fields.initialAccess === undefined) {
    return params.fields;
  }

  const grants = await Promise.all(params.fields.initialAccess.grants.map(async (grant) => {
    if (grant.subject.kind !== 'account') return grant;
    const recipientContentPublicKey = await params.resolveRecipientContentPublicKey(grant.subject.accountId);

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
          randomBytes: params.randomBytes,
        })),
      },
    };
  }));

  return {
    ...params.fields,
    initialAccess: SessionInitialAccessMaterializedV1Schema.parse({ grants }),
  };
}
