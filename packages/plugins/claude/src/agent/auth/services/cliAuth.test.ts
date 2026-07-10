import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectClaudeCliAuthStatus } from './cliAuth.js';

describe('detectClaudeCliAuthStatus', () => {
    it('reads Claude credentials from the configured Claude config directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-cli-auth-'));
        try {
            const claudeConfigDir = join(root, '.claude');
            await mkdir(claudeConfigDir, { recursive: true });
            await writeFile(
                join(claudeConfigDir, '.credentials.json'),
                JSON.stringify({
                    accessToken: 'claude-token',
                    email: 'claude@example.test',
                }),
                'utf8',
            );

            expect(detectClaudeCliAuthStatus({
                env: {
                    CLAUDE_CONFIG_DIR: claudeConfigDir,
                    ANTHROPIC_API_KEY: undefined,
                    ANTHROPIC_AUTH_TOKEN: undefined,
                },
            })).toMatchObject({
                state: 'logged_in',
                method: 'credentials_file',
                source: 'file',
                accountLabel: 'claude@example.test',
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reads current Claude Code OAuth credentials and account labels', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-cli-auth-current-'));
        try {
            const claudeConfigDir = join(root, '.claude');
            await mkdir(claudeConfigDir, { recursive: true });
            await writeFile(
                join(claudeConfigDir, '.credentials.json'),
                JSON.stringify({
                    claudeAiOauth: {
                        accessToken: 'claude-token',
                        refreshToken: 'claude-refresh-token',
                        expiresAt: Date.now() + 60_000,
                        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
                    },
                }),
                'utf8',
            );
            await writeFile(
                join(claudeConfigDir, '.claude.json'),
                JSON.stringify({
                    oauthAccount: {
                        emailAddress: 'claude-current@example.test',
                    },
                }),
                'utf8',
            );

            expect(detectClaudeCliAuthStatus({
                env: {
                    CLAUDE_CONFIG_DIR: claudeConfigDir,
                    ANTHROPIC_API_KEY: undefined,
                    ANTHROPIC_AUTH_TOKEN: undefined,
                },
            })).toMatchObject({
                state: 'logged_in',
                method: 'credentials_file',
                source: 'file',
                accountLabel: 'claude-current@example.test',
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('prefers explicit Anthropic environment credentials over files', async () => {
        expect(detectClaudeCliAuthStatus({
            env: {
                ANTHROPIC_API_KEY: 'sk-ant-test',
                ANTHROPIC_AUTH_TOKEN: 'oauth-token',
            },
        })).toMatchObject({
            state: 'logged_in',
            method: 'api_key_env',
            source: 'env',
        });
    });
});
