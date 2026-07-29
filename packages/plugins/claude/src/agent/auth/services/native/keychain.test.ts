import type { PluginExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    readClaudeCodeMacOsKeychainCredential,
    resolveClaudeCodeMacOsKeychainServiceName,
    sweepStaleClaudeCodeMacOsKeychainCredentials,
} from './keychain.js';

function createProcessResult(params: Readonly<{
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
}> = {}): PluginProcessResult {
    const exitCode = params.exitCode ?? 0;
    return {
        termination: {
            observed: exitCode === null
                ? { kind: 'signal', signal: 'SIGTERM' }
                : { kind: 'exit', exitCode },
            requestedBy: { kind: 'none' },
        },
        stdout: new TextEncoder().encode(params.stdout ?? ''),
        stderr: new TextEncoder().encode(params.stderr ?? ''),
        stdoutTruncated: false,
        stderrTruncated: false,
    };
}

function createExecFixture(params: Readonly<{
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
}> = {}): PluginExecService {
    return {
        systemTools: {
            resolve: vi.fn(async () => ({
                executable: { kind: 'systemTool', id: 'macos-security' },
                executablePath: '/usr/bin/security',
            })),
        },
        run: vi.fn(async () => createProcessResult(params)),
    } as unknown as PluginExecService;
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

    it('bounds keychain reads and deletes with the mediated exec timeout', async () => {
        const exec = createExecFixture({
            stdout: JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            }),
        });

        await readClaudeCodeMacOsKeychainCredential({
            exec,
            claudeConfigDir: '/Users/tester/.claude',
            homeDir: '/Users/tester',
        });

        expect(exec.systemTools.resolve).toHaveBeenCalledWith({
            toolId: 'macos-security',
            purpose: 'read Claude Code OAuth credentials from the macOS keychain',
        });
        expect(exec.run).toHaveBeenLastCalledWith(expect.objectContaining({
            args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            timeoutMs: 10_000,
        }));
    });

    it('does not consult the keychain for a managed (suffixed) config dir — managed homes are file-only', async () => {
        // Design (B), proven by decompiling claude v2.1.205: with CLAUDE_CONFIG_DIR set (every managed
        // home) claude reads ONLY $dir/.credentials.json and NEVER the keychain. A derived suffixed item
        // is therefore never legitimate, and reading it back could only surface a stale artifact that
        // forces a spurious credential_fingerprint_mismatch on the authoritative file. The read is gated
        // to the GLOBAL service only.
        const exec = createExecFixture({
            stdout: JSON.stringify({
                claudeAiOauth: {
                    accessToken: 'access-placeholder',
                    expiresAt: 123,
                    scopes: ['user:profile', 'user:sessions:claude_code'],
                },
            }),
        });

        await expect(readClaudeCodeMacOsKeychainCredential({
            exec,
            claudeConfigDir: '/tmp/custom-claude-home',
            homeDir: '/Users/tester',
        })).resolves.toBeNull();
        expect(exec.systemTools.resolve).not.toHaveBeenCalled();
        expect(exec.run).not.toHaveBeenCalled();
    });

    it('sweeps every stale suffixed Happier-managed service for the same macOS account, including live homes', async () => {
        // CLOSE-9 reversal: under proven file-only, a live managed home never reads its keychain item, so
        // no suffixed managed item is ever legitimate — every one is obsolete write-once cruft and must be
        // purged. Only the GLOBAL login, OTHER accounts, and NON-managed services stay protected.
        const liveService = resolveClaudeCodeMacOsKeychainServiceName({
            claudeConfigDir: '/tmp/live-claude-home',
            homeDir: '/Users/tester',
        });
        const staleService = resolveClaudeCodeMacOsKeychainServiceName({
            claudeConfigDir: '/tmp/stale-claude-home',
            homeDir: '/Users/tester',
        });
        const run = vi.fn(async (launch: { args?: readonly string[] }) => {
            if (launch.args?.includes('dump-keychain')) {
                return createProcessResult({
                    stdout: [
                        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                        '    "acct"<blob>="tester"',
                        '    "svce"<blob>="Claude Code-credentials"',
                        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                        '    "acct"<blob>="tester"',
                        `    "svce"<blob>="${liveService}"`,
                        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                        '    "acct"<blob>="tester"',
                        `    "svce"<blob>="${staleService}"`,
                        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                        '    "acct"<blob>="other"',
                        '    "svce"<blob>="Claude Code-credentials-deadbeef"',
                        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                        '    "acct"<blob>="tester"',
                        '    "svce"<blob>="Claude Code Profile"',
                    ].join('\n'),
                });
            }
            return createProcessResult();
        });
        const exec = {
            ...createExecFixture(),
            run,
        } as unknown as PluginExecService;

        await expect(sweepStaleClaudeCodeMacOsKeychainCredentials({
            exec,
            username: 'tester',
            homeDir: '/Users/tester',
        })).resolves.toEqual({
            scanned: 5,
            deleted: [
                { account: 'tester', service: liveService },
                { account: 'tester', service: staleService },
            ],
            skipped: expect.arrayContaining([
                { account: 'tester', service: 'Claude Code-credentials', reason: 'global_service' },
                { account: 'other', service: 'Claude Code-credentials-deadbeef', reason: 'different_account' },
                { account: 'tester', service: 'Claude Code Profile', reason: 'not_happier_managed_service' },
            ]),
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            args: ['dump-keychain'],
            timeoutMs: 10_000,
        }));
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            args: ['delete-generic-password', '-a', 'tester', '-s', liveService],
            timeoutMs: 10_000,
        }));
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            args: ['delete-generic-password', '-a', 'tester', '-s', staleService],
            timeoutMs: 10_000,
        }));
        // The global login must never be deleted.
        expect(JSON.stringify(run.mock.calls)).not.toContain('"Claude Code-credentials","-s"');
        expect(JSON.stringify(run.mock.calls)).not.toContain('delete-generic-password","-a","other"');
    });

    it('reads and parses the global macOS keychain credential payload through the mediated security tool', async () => {
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
                claudeConfigDir: '/Users/tester/.claude',
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
            toolId: 'macos-security',
            purpose: 'read Claude Code OAuth credentials from the macOS keychain',
        });
        expect(exec.run).toHaveBeenCalledWith({
            executable: { kind: 'systemTool', id: 'macos-security' },
            args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            timeoutMs: 10_000,
        });
    });

    it('treats invalid macOS keychain credential payloads as missing', async () => {
        const exec = createExecFixture({
            stdout: JSON.stringify({
                claudeAiOauth: {
                    accessToken: '',
                    refreshToken: '',
                    expiresAt: 0,
                    scopes: [],
                },
            }),
        });

        await expect(
            readClaudeCodeMacOsKeychainCredential({
                exec,
                claudeConfigDir: '/Users/tester/.claude',
                homeDir: '/Users/tester',
            }),
        ).resolves.toBeNull();
    });
});
