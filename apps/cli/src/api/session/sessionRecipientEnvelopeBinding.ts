import { resolveVerifiedSessionRecipientContentPublicKey as resolvePortableRecipientKey } from '@happier-dev/protocol/sessions/access/sessionRecipientEnvelopeBindingV1';
import { decodeHex } from '@/utils/hex';
export { SessionRecipientEnvelopeBindingError } from '@happier-dev/protocol/sessions/access/sessionRecipientEnvelopeBindingV1';

export function resolveVerifiedSessionRecipientContentPublicKey(payload: unknown): Uint8Array | null {
  return resolvePortableRecipientKey(payload, decodeHex);
}
