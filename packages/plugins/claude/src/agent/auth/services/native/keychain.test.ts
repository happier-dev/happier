import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readClaudeCodeMacOsKeychainCredential,
    resolveClaudeCodeMacOsKeychainServiceName,
    writeClaudeCodeMacOsKeychainCredential,
} from './keychain.js';

function createExecFixture(params: Readonly<{
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
}> = {}): ExecRuntimeServiceV1 {
    return {
        systemTools: {
            resolve: vi.fn(async () => ({
                grantId: 'grant-security',
                toolId: 'claude.macos.security',
                displayName: 'macOS Keychain security',
                source: 'system',
                executablePath: '/usr/bin/security',
                launch: {
                    kind: 'binary',
                    executablePath: '/usr/bin/security',
                    env: { PATH: '' },
                },
                expiresAt: null,
            })),
        },
        run: vi.fn(async () => ({
            exitCode: params.exitCode ?? 0,
            signal: null,
            stdout: params.stdout ?? '',
            stderr: params.stderr ?? '',
        })),
    } as unknown as ExecRuntimeServiceV1;
}

describe('keychain', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses the unsuffixed service for the default Claude config dir and a hashed suffix for custom dirs', () => {
        expect(
            resolveClaudeCodeMacOsKeychainServiceName({
                claudeConfigDir: '/Users/tester/.claude',
                homeDir: '/Users/tester',
            }),
        ).toBe('Claude Code-credentials');

        expect(
            resolveClaudeCodeMacOsKeychainServiceName({
                claudeConfigDir: '/tmp/custom-claude-home',
                homeDir: '/Users/tester',
            }),
        ).toBe('Claude Code-credentials-e161167c');
    });

    it('writes the credential JSON through the mediated macOS security system tool without putting secrets in argv', async () => {
        const exec = createExecFixture();

        await writeClaudeCodeMacOsKeychainCredential({
            exec,
            claudeConfigDir: '/tmp/custom-claude-home',
            homeDir: '/Users/tester',
            username: 'tester',
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    refreshToken: 'refresh-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            },
        });

        expect(exec.systemTools.resolve).toHaveBeenCalledWith({
            toolId: 'claude.macos.security',
            purpose: 'write Claude Code OAuth credentials to the macOS keychain',
            preferredCommand: 'security',
        });
        expect(exec.run).toHaveBeenCalledWith({
            kind: 'binary',
            executablePath: '/usr/bin/security',
            env: { PATH: '' },
            args: [
                'add-generic-password',
                '-U',
                '-a',
                'tester',
                '-s',
                'Claude Code-credentials-e161167c',
                '-w',
            ],
            stdin: `${JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    refreshToken: 'refresh-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            })}\n${JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    refreshToken: 'refresh-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            })}\n`,
        });
        const args = vi.mocked(exec.run).mock.calls[0]?.[0].args ?? [];
        expect(args).not.toContain('access-placeholder');
        expect(args).not.toContain('refresh-placeholder');
    });

    it('reads and parses the derived macOS keychain credential payload through the mediated security tool', async () => {
        const exec = createExecFixture({
            stdout: JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    refreshToken: 'refresh-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            }),
        });

        await expect(
            readClaudeCodeMacOsKeychainCredential({
                exec,
                claudeConfigDir: '/tmp/custom-claude-home',
                homeDir: '/Users/tester',
            }),
        ).resolves.toEqual({
            claudeAiOauth: {
                accessToken: 'access-placeholder',
                refreshToken: 'refresh-placeholder',
                expiresAt: 123,
                scopes: ['user:profile', 'user:sessions:claude_code'],
            },
        });

        expect(exec.systemTools.resolve).toHaveBeenCalledWith({
            toolId: 'claude.macos.security',
            purpose: 'read Claude Code OAuth credentials from the macOS keychain',
            preferredCommand: 'security',
        });
        expect(exec.run).toHaveBeenCalledWith({
            kind: 'binary',
            executablePath: '/usr/bin/security',
            env: { PATH: '' },
            args: ['find-generic-password', '-s', 'Claude Code-credentials-e161167c', '-w'],
        });
    });

    it('sanitizes failed keychain writes instead of surfacing raw security stderr', async () => {
        const exec = createExecFixture({
            exitCode: 1,
            stderr: 'raw token access-placeholder leaked by security',
        });

        await expect(writeClaudeCodeMacOsKeychainCredential({
            exec,
            claudeConfigDir: '/tmp/custom-claude-home',
            homeDir: '/Users/tester',
            username: 'tester',
            payload: {
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    refreshToken: 'refresh-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            },
        })).rejects.toThrow('claude_code_keychain_write_failed:exit_1');
    });
});
