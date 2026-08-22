import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
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

    it('writes the native credential file under CLAUDE_CONFIG_DIR', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-'));
        const credentialPath = await writeClaudeCodeCredentialsFile({
            claudeConfigDir,
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-token',
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
            hasRefreshToken: false,
            expiresAt: 12345,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        });
        expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
        if (process.platform !== 'win32') {
            expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
        }
    });

    it('does not rewrite the credentials file when the incoming payload is byte-identical', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-skip-'));
        const payload = {
            claudeAiOauth: {
                accessToken: 'access-token',
                expiresAt: 12345,
                scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
            },
        } as const;
        const credentialPath = await writeClaudeCodeCredentialsFile({ claudeConfigDir, payload });
        const before = await stat(credentialPath);

        // A running Claude may be mid-read of this file; an identical rewrite (truncate+rename to a
        // new inode) risks tearing that read for no benefit. The choke point must skip it.
        await writeClaudeCodeCredentialsFile({ claudeConfigDir, payload });
        const after = await stat(credentialPath);

        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it('repairs an externally-relaxed mode to 0600 on the unchanged (skip) path', async () => {
        if (process.platform === 'win32') return;
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-chmod-'));
        const payload = {
            claudeAiOauth: {
                accessToken: 'access-token',
                expiresAt: 12345,
                scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
            },
        } as const;
        const credentialPath = await writeClaudeCodeCredentialsFile({ claudeConfigDir, payload });
        await chmod(credentialPath, 0o644);
        const relaxed = await stat(credentialPath);

        await writeClaudeCodeCredentialsFile({ claudeConfigDir, payload });
        const repaired = await stat(credentialPath);

        // Perms repaired without a rewrite: mode back to 0600, same inode (no truncate+rename).
        expect(repaired.mode & 0o777).toBe(0o600);
        expect(repaired.ino).toBe(relaxed.ino);
    });

    it('atomically rewrites when the incoming payload genuinely differs', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-change-'));
        const credentialPath = await writeClaudeCodeCredentialsFile({
            claudeConfigDir,
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-token',
                    expiresAt: 12345,
                    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                },
            },
        });
        const before = await stat(credentialPath);

        await writeClaudeCodeCredentialsFile({
            claudeConfigDir,
            payload: {
                claudeAiOauth: {
                    accessToken: 'rotated-access-token',
                    expiresAt: 67890,
                    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                },
            },
        });
        const after = await stat(credentialPath);

        expect(after.ino).not.toBe(before.ino);
        const parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
        expect(parseClaudeCodeCredentialFile(parsed).expiresAt).toBe(67890);
        if (process.platform !== 'win32') {
            expect(after.mode & 0o777).toBe(0o600);
        }
    });
});
