import { describe, expect, it } from 'vitest';

import { buildCreateSessionShareRequest } from './buildCreateSessionShareRequest';

describe('buildCreateSessionShareRequest', () => {
    it('omits encryptedDataKey for plaintext sessions', () => {
        const req = buildCreateSessionShareRequest({
            sessionEncryptionMode: 'plain',
            userId: 'u2',
            accessLevel: 'view',
        });
        expect(req).toEqual({ userId: 'u2', accessLevel: 'view' });
    });

    it('requires encryptedDataKey for encrypted sessions', () => {
        expect(() =>
            buildCreateSessionShareRequest({
                sessionEncryptionMode: 'e2ee',
                userId: 'u2',
                accessLevel: 'edit',
            }),
        ).toThrow('encryptedDataKey required');

        const req = buildCreateSessionShareRequest({
            sessionEncryptionMode: 'e2ee',
            userId: 'u2',
            accessLevel: 'edit',
            encryptedDataKey: 'AA==',
        });
        expect(req).toEqual({ userId: 'u2', accessLevel: 'edit', encryptedDataKey: 'AA==' });
    });
});

