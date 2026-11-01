import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

export { verifyAccountContentPublicKeyBinding as verifyRecipientContentPublicKeyBinding } from '@happier-dev/protocol';

export function encryptDataKeyForRecipientV0(
    sessionDataKey: Uint8Array,
    recipientContentPublicKeyB64: string
): string {
    const recipientPublicKey = decodeBase64(recipientContentPublicKeyB64, 'base64');
    const bundle = encryptBox(sessionDataKey, recipientPublicKey);

    const out = new Uint8Array(1 + bundle.length);
    out[0] = 0;
    out.set(bundle, 1);

    return encodeBase64(out, 'base64');
}
