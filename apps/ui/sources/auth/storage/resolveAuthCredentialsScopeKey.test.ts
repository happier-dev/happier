import { describe, expect, it } from 'vitest';

import { resolveAuthCredentialsScopeKey } from './resolveAuthCredentialsScopeKey';

describe('resolveAuthCredentialsScopeKey', () => {
    it('does not embed raw legacy credential material', () => {
        const credentials = {
            token: 'RAW_TOKEN_VALUE_THAT_MUST_NOT_APPEAR_IN_SCOPE_KEY',
            secret: 'RAW_SECRET_VALUE_THAT_MUST_NOT_APPEAR_IN_SCOPE_KEY',
        } as const;

        const scopeKey = resolveAuthCredentialsScopeKey(credentials);

        expect(scopeKey).toContain('legacy');
        expect(scopeKey).not.toContain(credentials.token);
        expect(scopeKey).not.toContain(credentials.secret);
        expect(resolveAuthCredentialsScopeKey({ ...credentials })).toBe(scopeKey);
        expect(resolveAuthCredentialsScopeKey({ ...credentials, secret: `${credentials.secret}_changed` })).not.toBe(scopeKey);
    });

    it('does not embed raw data-key credential material', () => {
        const credentials = {
            token: 'RAW_DATA_KEY_TOKEN_VALUE_THAT_MUST_NOT_APPEAR',
            encryption: {
                publicKey: 'RAW_PUBLIC_KEY_VALUE_THAT_MUST_NOT_APPEAR',
                machineKey: 'RAW_MACHINE_KEY_VALUE_THAT_MUST_NOT_APPEAR',
            },
        } as const;

        const scopeKey = resolveAuthCredentialsScopeKey(credentials);

        expect(scopeKey).toContain('data-key');
        expect(scopeKey).not.toContain(credentials.token);
        expect(scopeKey).not.toContain(credentials.encryption.publicKey);
        expect(scopeKey).not.toContain(credentials.encryption.machineKey);
        expect(resolveAuthCredentialsScopeKey({ ...credentials })).toBe(scopeKey);
        expect(resolveAuthCredentialsScopeKey({
            ...credentials,
            encryption: {
                ...credentials.encryption,
                machineKey: `${credentials.encryption.machineKey}_changed`,
            },
        })).not.toBe(scopeKey);
    });
});
