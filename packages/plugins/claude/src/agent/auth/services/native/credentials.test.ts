import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildClaudeCodeCredentialPayload,
    parseClaudeCodeCredentialFile,
    resolveClaudeCodeCredentialsFilePath,
    writeClaudeCodeCredentialsFile,
} from './credentials.js';

describe('claudeCodeCredentialFile', () => {
    it('builds Claude Code native credentials from scoped OAuth records', () => {
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
                    refreshToken: 'refresh-token',
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

    it('writes the native credential file under CLAUDE_CONFIG_DIR', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-'));
        const credentialPath = await writeClaudeCodeCredentialsFile({
            claudeConfigDir,
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-token',
                    refreshToken: 'refresh-token',
                    expiresAt: 12345,
                    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                },
            },
        });

        expect(credentialPath).toBe(resolveClaudeCodeCredentialsFilePath(claudeConfigDir));
        const parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
        expect(parseClaudeCodeCredentialFile(parsed)).toEqual({
            status: 'ok',
            hasAccessToken: true,
            hasRefreshToken: true,
            expiresAt: 12345,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        });
        if (process.platform !== 'win32') {
            expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
        }
    });
});
