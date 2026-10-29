import { describe, expect, it } from 'vitest';
import { decryptSecretValue, sealSecretsDeep, unsealSecretsDeep } from './secretSettings';

describe('secretSettings', () => {
    it('unsealSecretsDeep decrypts encryptedValue into value and drops encryptedValue', () => {
        const key = new Uint8Array(32).fill(7);
        const sealed = sealSecretsDeep({ secret: { _isSecretValue: true, value: 'sk-test' } }, key);
        const container: any = (sealed as any).secret;
        expect(container.encryptedValue?.t).toBe('enc-v1');

        const unsealed = unsealSecretsDeep(sealed, key);
        const out: any = (unsealed as any).secret;
        expect(out.value).toBe('sk-test');
        expect(out.encryptedValue).toBeUndefined();
    });

    it('preserves whitespace-only plaintext secret bytes instead of falling back to encrypted data', () => {
        const key = new Uint8Array(32).fill(7);
        const sealed = sealSecretsDeep({ secret: { _isSecretValue: true, value: 'sk-test' } }, key) as any;

        expect(
            decryptSecretValue(
                {
                    _isSecretValue: true,
                    value: '   ',
                    encryptedValue: sealed.secret.encryptedValue,
                },
                key,
            ),
        ).toBe('   ');
    });

    it('returns null for encrypted secrets when no key is available', () => {
        const key = new Uint8Array(32).fill(7);
        const sealed = sealSecretsDeep({ secret: { _isSecretValue: true, value: 'sk-test' } }, key) as any;

        expect(
            decryptSecretValue(
                {
                    _isSecretValue: true,
                    encryptedValue: sealed.secret.encryptedValue,
                },
                null,
            ),
        ).toBeNull();
    });

    it('refuses to leave a marked plaintext secret unsealed when no local key is available', () => {
        const input = { secret: { _isSecretValue: true, value: 'sk-test' } };

        expect(() => sealSecretsDeep(input, null)).toThrow(
            expect.objectContaining({
                code: 'local_secret_unavailable',
                message: 'Local settings secret key is unavailable',
            }),
        );
    });

    it('keeps ordinary non-secret settings usable when no local key is available', () => {
        const input = { analyticsOptOut: true };

        expect(sealSecretsDeep(input, null)).toBe(input);
    });
});
