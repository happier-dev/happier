import { describe, expect, it } from 'vitest';
import { PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES } from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';
import {
    decryptDataKeyFromPublicShare,
    encryptDataKeyForPublicShare,
} from './publicShareEncryption';

describe('public-share encryption compatibility', () => {
    it('keeps the released current SecretBox writer readable by the current viewer', async () => {
        // Stable ui-mobile-v0.2.0 and ui-web-v0.2.0 plus preview
        // ui-web-v0.2.2-preview.1775585938.1 all use this writer.
        const dataKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const token = 'current-public-share-roundtrip';

        const encrypted = await encryptDataKeyForPublicShare(dataKey, token);
        const opened = await decryptDataKeyFromPublicShare(encrypted, token);

        expect(decodeBase64(encrypted, 'base64')).toHaveLength(PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES);
        expect(opened).toEqual(dataKey);
    });

});
