import { UserResponseSchema, UserRecipientEnvelopeResponseSchema } from '@happier-dev/protocol/social/friends';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';

import { decodeHex } from '@/utils/hex';

export class SessionRecipientEnvelopeBindingError extends Error {
  constructor(readonly code:
    | 'recipient_key_unavailable'
    | 'session_access_invalid_recipient_envelope'
    | 'unsupported_action') {
    super(code);
    this.name = 'SessionRecipientEnvelopeBindingError';
  }
}

/**
 * Resolves the one verified recipient content key used by every trusted CLI
 * Session-envelope host. Canonical server readiness decides whether no key is
 * expected yet; retained key columns never infer Account mode or readiness.
 */
export function resolveVerifiedSessionRecipientContentPublicKey(payload: unknown): Uint8Array | null {
  const parsed = UserRecipientEnvelopeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SessionRecipientEnvelopeBindingError(
      UserResponseSchema.safeParse(payload).success
        ? 'unsupported_action'
        : 'session_access_invalid_recipient_envelope',
    );
  }
  const recipient = parsed.data.user;
  const readiness = recipient.recipientEnvelopeReadiness;
  if (readiness.status === 'unavailable') {
    // The server admits key-free grants for unavailable recipients, including
    // repair-required Accounts. It retains the precise readiness reason; this
    // material resolver only withholds keys and never promotes them to ready.
    return null;
  }
  if (typeof recipient.publicKey !== 'string'
    || typeof recipient.contentPublicKey !== 'string'
    || typeof recipient.contentPublicKeySig !== 'string') {
    throw new SessionRecipientEnvelopeBindingError('recipient_key_unavailable');
  }

  try {
    const contentPublicKey = decodeBase64(recipient.contentPublicKey, 'base64');
    const verified = verifyAccountContentKeyBindingV1({
      accountSigningPublicKey: decodeHex(recipient.publicKey),
      contentPublicKey,
      signature: decodeBase64(recipient.contentPublicKeySig, 'base64'),
    });
    if (verified === null) {
      throw new SessionRecipientEnvelopeBindingError('session_access_invalid_recipient_envelope');
    }
    return contentPublicKey;
  } catch (error) {
    if (error instanceof SessionRecipientEnvelopeBindingError) throw error;
    throw new SessionRecipientEnvelopeBindingError('session_access_invalid_recipient_envelope');
  }
}
