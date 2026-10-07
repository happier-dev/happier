import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { decodeHex } from '@/encryption/hex';
import { getRandomBytes } from '@/platform/cryptoRandom';

/**
 * Chunk size for Session data-key preparation batches passed to `mapCryptoBatchWithYield`.
 *
 * Measured on this corridor's real primitive (Protocol verify + seal, existing batch helper), not
 * derived from the page bound: one `encryptDataKeyForRecipientV0` costs ~5.7-12 ms on an M5 Max
 * (Node 22) and ~44-60 ms on a Linux arm64 shared host. A single seal therefore already exceeds a
 * frame budget on the fastest host measured, so the smallest chunk is the only one that bounds the
 * slice at all. At the 24-entry page bound the default chunk of 32 never yields and held the thread
 * for 126.21 ms in one uninterrupted slice, while chunk 1 capped the longest slice at 5.89 ms for
 * a ~22% increase in total batch time (126.24 ms -> 154.16 ms) — the right trade for a foreground
 * operation that must stay responsive.
 *
 * This bounds local crypto only. It is deliberately unrelated to
 * `SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1`, which bounds one atomic server commit; the page
 * bound is not an implicit crypto budget.
 */
export const SESSION_DATA_KEY_SEAL_CHUNK_SIZE = 1;

export function encryptDataKeyForRecipientV0(
    sessionDataKey: Uint8Array,
    recipientContentPublicKeyB64: string
): string {
    const recipientPublicKey = decodeBase64(recipientContentPublicKeyB64, 'base64');
    return encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionDataKey,
        recipientPublicKey,
        randomBytes: getRandomBytes,
    }), 'base64');
}

export function verifyRecipientContentPublicKeyBinding(params: {
    signingPublicKeyHex: string;
    contentPublicKeyB64: string;
    contentPublicKeySigB64: string;
}): boolean {
    try {
        return verifyAccountContentKeyBindingV1({
            accountSigningPublicKey: decodeHex(params.signingPublicKeyHex),
            contentPublicKey: decodeBase64(params.contentPublicKeyB64, 'base64'),
            signature: decodeBase64(params.contentPublicKeySigB64, 'base64'),
        }) !== null;
    } catch {
        return false;
    }
}
