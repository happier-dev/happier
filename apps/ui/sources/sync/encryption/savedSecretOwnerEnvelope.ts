import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import { encodeBase64 } from '@/encryption/base64';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';

/**
 * The owner's own envelope for a Saved Secret resource data key this device just
 * sealed. Creation, promotion, conversion into E2EE and the Account-mode
 * migration reseal each submit exactly this one envelope with their write; every
 * other recipient is prepared afterwards by the census repair.
 */
export function sealOwnerSavedSecretResourceEnvelope(
    accountId: string,
    resourceDataKey: Uint8Array,
    contentPublicKey: Uint8Array,
): Readonly<{ recipientAccountId: string; encryptedDataKey: string; recipientContentPublicKeyFingerprint: string }> {
    return {
        recipientAccountId: accountId,
        encryptedDataKey: encryptDataKeyForRecipientV0(resourceDataKey, encodeBase64(contentPublicKey, 'base64')),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
    };
}
