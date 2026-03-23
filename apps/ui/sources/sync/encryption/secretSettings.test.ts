import { describe, expect, it } from 'vitest';
import { decryptSecretValue, sealSecretsDeep, unsealSecretsDeep } from './secretSettings';

describe('secretSettings', () => {
    it('sealSecretsDeep encrypts SecretString.value into SecretString.encryptedValue and drops SecretString.value', () => {
        const key = new Uint8Array(32).fill(7);
        const delta = {
            secrets: [
                { id: 'k1', name: 'Key', encryptedValue: { _isSecretValue: true, value: 'sk-test' } },
            ],
        };

        const sealed = sealSecretsDeep(delta, key);
        const item: any = (sealed as any).secrets[0];
        expect(item.encryptedValue?.value).toBeUndefined();
        expect(item.encryptedValue?.encryptedValue?.t).toBe('enc-v1');
        expect(typeof item.encryptedValue?.encryptedValue?.c).toBe('string');
        expect(item.encryptedValue.encryptedValue.c.length).toBeGreaterThan(0);
    });

    it('sealSecretsDeep does not encrypt objects without secret marker', () => {
        const key = new Uint8Array(32).fill(7);
        const delta = { value: 'not-a-secret', encryptedValue: undefined };
        // Without `_isSecretValue: true`, we must not seal it (avoids false positives across the app).
        const sealed = sealSecretsDeep(delta, key);
        expect((sealed as any).value).toBe('not-a-secret');
    });

    it('decryptSecretValue returns plaintext if value is present (does not mutate input)', () => {
        const key = new Uint8Array(32).fill(7);
        const input: any = { _isSecretValue: true, value: 'sk-plain', encryptedValue: undefined };
        const out = decryptSecretValue(input, key);
        expect(out).toBe('sk-plain');
        expect(input.value).toBe('sk-plain');
        expect(input.encryptedValue).toBeUndefined();
    });

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

    it('treats whitespace-only plaintext values as empty and falls back to encrypted data', () => {
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
        ).toBe('sk-test');
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

    it('returns the original structure unchanged when sealing with a null key', () => {
        const input = { secret: { _isSecretValue: true, value: 'sk-test' } };
        const sealed = sealSecretsDeep(input, null);

        expect(sealed).toBe(input);
    });
});
