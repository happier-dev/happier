import { describe, expect, it } from 'vitest';

import {
    createAppLockKeys,
    isSealedAppLockCredential,
    openAppLockCredential,
    rewrapAppLockPassword,
    sealAppLockCredential,
    unwrapAppLockKeyWithPassword,
    unwrapAppLockKeyWithRecoveryKey,
} from './appLockCrypto';

// Low scrypt cost keeps the suite fast; production parameters live in the module.
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 } as const;

describe('appLockCrypto', () => {
    it('unwraps the data key with the right password or recovery key only', async () => {
        const created = await createAppLockKeys('correct horse', FAST_KDF);

        const viaPassword = await unwrapAppLockKeyWithPassword(created.wrapped, 'correct horse');
        expect(viaPassword).not.toBeNull();
        expect(Array.from(viaPassword!)).toEqual(Array.from(created.dataKey));
        expect(await unwrapAppLockKeyWithPassword(created.wrapped, 'wrong horse')).toBeNull();

        const viaRecovery = await unwrapAppLockKeyWithRecoveryKey(created.wrapped, created.recoveryKey);
        expect(Array.from(viaRecovery!)).toEqual(Array.from(created.dataKey));
        const otherRecoveryKey = (await createAppLockKeys('x', FAST_KDF)).recoveryKey;
        expect(await unwrapAppLockKeyWithRecoveryKey(created.wrapped, otherRecoveryKey)).toBeNull();
    });

    it('replaces the password without changing the data key', async () => {
        const created = await createAppLockKeys('old password', FAST_KDF);
        const rewrapped = await rewrapAppLockPassword(created.wrapped, created.dataKey, 'new password', FAST_KDF);

        expect(await unwrapAppLockKeyWithPassword(rewrapped, 'old password')).toBeNull();
        expect(Array.from((await unwrapAppLockKeyWithPassword(rewrapped, 'new password'))!)).toEqual(Array.from(created.dataKey));
        expect(Array.from((await unwrapAppLockKeyWithRecoveryKey(rewrapped, created.recoveryKey))!)).toEqual(Array.from(created.dataKey));
    });

    it('seals credentials so that readers without the data key see no credentials', async () => {
        const { dataKey } = await createAppLockKeys('pw', FAST_KDF);
        const otherKey = (await createAppLockKeys('pw', FAST_KDF)).dataKey;
        const plain = JSON.stringify({ token: 'secret-token', secret: 'secret-value' });

        const sealed = await sealAppLockCredential(dataKey, plain);
        expect(isSealedAppLockCredential(sealed)).toBe(true);
        expect(isSealedAppLockCredential(plain)).toBe(false);
        expect(sealed).not.toContain('secret-token');
        // An app version without app lock parses stored credentials as JSON; a sealed value must not parse.
        expect(() => JSON.parse(sealed)).toThrow();

        expect(await openAppLockCredential(dataKey, sealed)).toBe(plain);
        expect(await openAppLockCredential(otherKey, sealed)).toBeNull();
    });
});
