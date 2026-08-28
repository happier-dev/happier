import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildClaudeCodeCredentialPayload,
    parseClaudeCodeCredentialFile,
} from './credentials.js';

describe('claudeCodeCredentialFile', () => {
    it('builds inference-only native credentials from Claude setup-token records', () => {
        const record = buildConnectedServiceCredentialRecord({
            now: 10,
            serviceId: 'claude-subscription',
            profileId: 'setup',
            kind: 'token',
            token: {
                token: 'sk-ant-oat01-setup-placeholder',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        expect(buildClaudeCodeCredentialPayload(record)).toEqual({
            status: 'ok',
            payload: {
                claudeAiOauth: {
                    accessToken: 'sk-ant-oat01-setup-placeholder',
                    scopes: ['user:inference'],
                },
            },
        });
    });

    it('builds access-token-only Claude Code native credentials from scoped OAuth records', () => {
        const record = buildConnectedServiceCredentialRecord({
            now: 10,
            serviceId: 'claude-subscription',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: 12345,
            oauth: {
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                idToken: null,
                scope: 'user:inference user:profile user:sessions:claude_code',
                tokenType: 'Bearer',
                providerAccountId: 'acct',
                providerEmail: 'user@example.com',
            },
        });

        expect(buildClaudeCodeCredentialPayload(record)).toEqual({
            status: 'ok',
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-token',
                    expiresAt: 12345,
                    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                },
            },
        });
    });

    it('omits expiresAt rather than coercing a null expiry to an immediately-expired 0', () => {
        const record = buildConnectedServiceCredentialRecord({
            now: 10,
            serviceId: 'claude-subscription',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: null,
            oauth: {
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                idToken: null,
                scope: 'user:inference user:profile user:sessions:claude_code',
                tokenType: 'Bearer',
                providerAccountId: 'acct',
                providerEmail: 'user@example.com',
            },
        });

        const result = buildClaudeCodeCredentialPayload(record);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
            expect(result.payload.claudeAiOauth).not.toHaveProperty('expiresAt');
            expect(result.payload.claudeAiOauth).not.toHaveProperty('refreshToken');
        }
    });

    it('classifies missing required scopes without returning secret values', () => {
        const record = buildConnectedServiceCredentialRecord({
            now: 10,
            serviceId: 'claude-subscription',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: 12345,
            oauth: {
                accessToken: 'secret-access',
                refreshToken: 'secret-refresh',
                idToken: null,
                scope: 'user:inference user:profile',
                tokenType: 'Bearer',
                providerAccountId: 'acct',
                providerEmail: 'user@example.com',
            },
        });

        const result = buildClaudeCodeCredentialPayload(record);
        expect(result).toEqual({
            status: 'diagnostic',
            health: {
                status: 'missing_required_scope',
                missingScopes: ['user:sessions:claude_code'],
            },
        });
        expect(JSON.stringify(result)).not.toContain('secret-access');
        expect(JSON.stringify(result)).not.toContain('secret-refresh');
    });

    it('parses the native credential shape without taking filesystem custody', () => {
        expect(parseClaudeCodeCredentialFile({
            claudeAiOauth: {
                accessToken: 'access-token',
                expiresAt: 12345,
                scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
            },
        })).toEqual({
            status: 'ok',
            hasAccessToken: true,
            hasRefreshToken: false,
            expiresAt: 12345,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        });
    });
});
