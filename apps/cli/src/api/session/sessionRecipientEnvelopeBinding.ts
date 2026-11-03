import { resolveVerifiedSessionRecipientContentPublicKey as resolvePortableRecipientKey } from '@happier-dev/protocol/sessions';
import { decodeHex } from '@/utils/hex';
export { SessionRecipientEnvelopeBindingError } from '@happier-dev/protocol/sessions';

export function resolveVerifiedSessionRecipientContentPublicKey(payload: unknown): Uint8Array | null {
  return resolvePortableRecipientKey(payload, decodeHex);
}
