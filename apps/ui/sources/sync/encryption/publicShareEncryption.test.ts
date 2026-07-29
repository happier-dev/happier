import { describe, expect, it } from 'vitest';

import { decodeBase64 } from '@/encryption/base64';
import {
    decryptDataKeyFromPublicShare,
    encryptDataKeyForPublicShare,
} from './publicShareEncryption';

const LEGACY_PREVIEW_VECTOR = {
    // ui-mobile-preview artifact asset 358465308, sha256
    // bfe325d03ca6fcf7a5e8aa9eedcc7a6bfdc03384c93d5ee12d3bde1079b92ce0,
    // source commit 86d1385864dd528b864a8ba72e4c3201f67aece3.
    token: 'released-preview-public-share-vector',
    dataKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    envelopeB64:
        'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHMJ6ZwXvlgV+Ew6Jtlspr/Sg/SEHyrn8lcqu7Euram/O2gprQ7e4Fe1w3nB1i3RVUrT1cj9PUi4jF5+isG5G/WnzMt54qn3pC0aKPXk8e2w==',
} as const;

describe('public-share encryption compatibility', () => {
    it('keeps the released 165-byte SecretBox writer readable by the current viewer', async () => {
        // Stable ui-mobile-v0.2.0 and ui-web-v0.2.0 plus preview
        // ui-web-v0.2.2-preview.1775585938.1 all use this writer.
        const dataKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const token = 'current-public-share-roundtrip';

        const encrypted = await encryptDataKeyForPublicShare(dataKey, token);
        const opened = await decryptDataKeyFromPublicShare(encrypted, token);

        expect(decodeBase64(encrypted, 'base64')).toHaveLength(165);
        expect(opened).toEqual(dataKey);
    });

    it('keeps the released 103-byte legacy preview vector readable', async () => {
        const opened = await decryptDataKeyFromPublicShare(
            LEGACY_PREVIEW_VECTOR.envelopeB64,
            LEGACY_PREVIEW_VECTOR.token,
        );

        expect(opened).toEqual(decodeBase64(LEGACY_PREVIEW_VECTOR.dataKeyB64, 'base64'));
    });
});
