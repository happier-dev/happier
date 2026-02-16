import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceIdSchema,
    ConnectedServiceCredentialRecordV1Schema,
    SealedConnectedServiceCredentialV1Schema,
} from './connectedServiceSchemas.js';

describe('connectedServiceSchemas', () => {
    it('parses connected service ids', () => {
        expect(ConnectedServiceIdSchema.parse('openai-codex')).toBe('openai-codex');
        expect(ConnectedServiceIdSchema.parse('anthropic')).toBe('anthropic');
        expect(ConnectedServiceIdSchema.parse('gemini')).toBe('gemini');
    });

    it('parses an oauth credential record', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            kind: 'oauth',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 3600_000,
            oauth: {
                accessToken: 'at',
                refreshToken: 'rt',
                idToken: 'id',
                scope: 'openid',
                tokenType: 'Bearer',
                providerAccountId: 'acct_1',
                providerEmail: 'user@example.com',
                raw: null,
            },
            token: null,
        });
        expect(rec.kind).toBe('oauth');
        expect(rec.serviceId).toBe('openai-codex');
    });

    it('parses a token credential record', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'default',
            kind: 'token',
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: null,
            token: {
                token: 'setup-token',
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
        });
        expect(rec.kind).toBe('token');
        expect(rec.serviceId).toBe('anthropic');
    });

    it('parses sealed credential payloads', () => {
        const sealed = SealedConnectedServiceCredentialV1Schema.parse({
            format: 'account_scoped_v1',
            ciphertext: 'base64ciphertext',
        });
        expect(sealed.format).toBe('account_scoped_v1');
    });
});

