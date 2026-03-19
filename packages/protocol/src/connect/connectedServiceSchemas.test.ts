import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceIdSchema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    SealedConnectedServiceCredentialV1Schema,
} from './connectedServiceSchemas.js';

describe('connectedServiceSchemas', () => {
    it('parses connected service ids', () => {
        expect(ConnectedServiceIdSchema.parse('openai-codex')).toBe('openai-codex');
        expect(ConnectedServiceIdSchema.parse('openai')).toBe('openai');
        expect(ConnectedServiceIdSchema.parse('anthropic')).toBe('anthropic');
        expect(ConnectedServiceIdSchema.parse('claude-subscription')).toBe('claude-subscription');
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

    it('parses connected service quota snapshots', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: 'pro',
            accountLabel: 'work@example.com',
            meters: [
                {
                    meterId: 'requests',
                    label: 'Requests',
                    used: 10,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: 10,
                    resetsAt: now + 60_000,
                    status: 'ok',
                    details: {},
                },
            ],
        });
        expect(parsed.meters).toHaveLength(1);
        expect(parsed.meters[0]?.meterId).toBe('requests');
    });

    it('rejects invalid profile ids', () => {
        const now = Date.now();
        expect(() => {
            ConnectedServiceCredentialRecordV1Schema.parse({
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'work/bad',
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
        }).toThrow();
    });

    it('accepts profile ids that contain ":"', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work:us',
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
        expect(rec.profileId).toBe('work:us');
    });
});
