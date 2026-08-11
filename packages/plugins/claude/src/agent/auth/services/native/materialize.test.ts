import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/runtime';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './scopes.js';
import {
    materializeClaudeCodeNativeAuth,
    resetPendingLazyKeychainSweepKeysForTests,
} from './materialize.js';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const PROVENANCE_FILE_NAME = '.happier-claude-connected-service-home.json';

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

function createExecFixture(params: Readonly<{ exitCode?: number | null; stderr?: string }> = {}): PluginExecService {
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

function createKeychainSweepExecFixture(params: Readonly<{ dumpStdout: string }>): PluginExecService {
    return {
        systemTools: {
            resolve: vi.fn(async () => ({
                executable: { kind: 'systemTool', id: 'macos-security' },
                executablePath: '/usr/bin/security',
            })),
        },
        run: vi.fn(async (launch: { args?: readonly string[] }) => {
            if (launch.args?.includes('dump-keychain')) {
                return createProcessResult({ stdout: params.dumpStdout });
            }
            return createProcessResult();
        }),
    } as unknown as PluginExecService;
}

describe('materializeClaudeCodeNativeAuth', () => {
    beforeEach(() => {
        // AT-4: clear the module-level lazy-sweep dedupe so a sweep scheduled by an earlier test can
        // never suppress (dedupe out) a later test's sweep for the same (home, username) — order-safe.
        resetPendingLazyKeychainSweepKeysForTests();
        if (ORIGINAL_PLATFORM_DESCRIPTOR) {
            Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        if (ORIGINAL_PLATFORM_DESCRIPTOR) {
            Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
        }
    });

    it('materializes setup tokens through the same native credential owner', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-setup-token-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'setup',
            kind: 'token',
            token: {
                token: 'sk-ant-oat01-setup-placeholder',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        await expect(materializeClaudeCodeNativeAuth({ record, claudeConfigDir })).resolves.toMatchObject({
            status: 'materialized',
            env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        });
        expect(JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'))).toEqual({
            claudeAiOauth: {
                accessToken: 'sk-ant-oat01-setup-placeholder',
                scopes: ['user:inference'],
            },
        });
    });

    it('writes native credentials and returns only CLAUDE_CONFIG_DIR for healthy OAuth records', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-placeholder',
                refreshToken: 'refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

        expect(result).toEqual({
            status: 'materialized',
            env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
            diagnostics: [],
            credentialPath: join(claudeConfigDir, '.credentials.json'),
        });
        const credentialFile = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
        expect(credentialFile.claudeAiOauth).not.toHaveProperty('refreshToken');
        expect(credentialFile.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
        await expect(readFile(join(claudeConfigDir, PROVENANCE_FILE_NAME), 'utf8')).resolves.toBeTruthy();
        const provenance = JSON.parse(await readFile(join(claudeConfigDir, PROVENANCE_FILE_NAME), 'utf8'));
        expect(provenance).toMatchObject({
            v: 1,
            serviceId: 'claude-subscription',
            credentialProfileId: 'oauth',
            credentialCreatedAt: 1000,
            credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(JSON.stringify(provenance)).not.toContain('access-placeholder');
        expect(JSON.stringify(provenance)).not.toContain('refresh-placeholder');
        expect(result.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
        expect(result.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
        expect(JSON.parse(await readFile(join(claudeConfigDir, '.claude.json'), 'utf8'))).toEqual({
            hasCompletedOnboarding: true,
        });
    });

    it('returns a safe reconnect diagnostic and does not write partial credentials when scopes are insufficient', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-secret-placeholder',
                refreshToken: 'refresh-secret-placeholder',
                idToken: null,
                scope: 'user:profile user:inference',
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

        expect(result.status).toBe('diagnostic');
        expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'claude_subscription_missing_claude_code_scope',
                providerId: 'claude',
                serviceId: 'claude-subscription',
                reason: 'missing_required_scope',
                credentialRefreshFailure: {
                    category: 'provider_403',
                    providerStatus: 403,
                    providerErrorCode: 'claude_subscription_missing_claude_code_scope',
                },
            }),
        ]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
        await expect(lstat(join(claudeConfigDir, '.credentials.json'))).rejects.toThrow();
        await expect(lstat(join(claudeConfigDir, '.claude.json'))).rejects.toThrow();
    });

    it('returns a safe blocking diagnostic when credential file materialization fails', async () => {
        const parentDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const blockingPath = join(parentDir, 'not-a-directory');
        await writeFile(blockingPath, 'file blocks nested config dir');
        const claudeConfigDir = join(blockingPath, 'claude-config');
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-secret-placeholder',
                refreshToken: 'refresh-secret-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

        expect(result.status).toBe('diagnostic');
        expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'claude_subscription_native_auth_materialization_failed',
                providerId: 'claude',
                serviceId: 'claude-subscription',
                reason: 'credential_file_write_failed',
                severity: 'blocking',
            }),
        ]);
        expect(result.diagnostics[0]).not.toHaveProperty('credentialRefreshFailure');
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
    });

    it('removes stale macOS keychain credentials for access-token-only homes on darwin', async () => {
        const exec = createExecFixture();
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-placeholder',
                refreshToken: 'refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ exec, record, claudeConfigDir });

        expect(result.status).toBe('materialized');
        expect(exec.systemTools.resolve).toHaveBeenCalledWith(expect.objectContaining({
            toolId: 'macos-security',
        }));
        expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({
            executable: { kind: 'systemTool', id: 'macos-security' },
            args: expect.arrayContaining(['delete-generic-password', '-a', 'leeroy']),
            timeoutMs: 10_000,
        }));
        expect(exec.run).not.toHaveBeenCalledWith(expect.objectContaining({
            args: expect.arrayContaining(['add-generic-password']),
        }));
    });

    it('sweeps every stale suffixed Happier-managed macOS keychain service on materialization', async () => {
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
        const staleService = 'Claude Code-credentials-deadbeef';
        const exec = createKeychainSweepExecFixture({
            dumpStdout: [
                'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                '    "acct"<blob>="tester"',
                `    "svce"<blob>="${staleService}"`,
                'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
                '    "acct"<blob>="tester"',
                '    "svce"<blob>="Claude Code-credentials"',
            ].join('\n'),
        });

        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-placeholder',
                refreshToken: 'refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({
            exec,
            record,
            claudeConfigDir,
            homeDir: '/Users/tester',
            username: 'tester',
        });

        expect(result.status).toBe('materialized');
        expect(exec.run).not.toHaveBeenCalledWith(expect.objectContaining({
            args: ['dump-keychain'],
            timeoutMs: 10_000,
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({
            args: ['dump-keychain'],
            timeoutMs: 10_000,
        }));
        expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({
            args: ['delete-generic-password', '-a', 'tester', '-s', staleService],
            timeoutMs: 10_000,
        }));
    });

    it('skips stable credential materialization and keychain work when provenance fingerprint matches', async () => {
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
        const exec = createKeychainSweepExecFixture({ dumpStdout: '' });
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-placeholder',
                refreshToken: 'refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
        await expect(materializeClaudeCodeNativeAuth({ record, claudeConfigDir })).resolves.toMatchObject({
            status: 'materialized',
        });
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

        await expect(materializeClaudeCodeNativeAuth({
            exec,
            record,
            claudeConfigDir,
            homeDir: '/Users/tester',
            username: 'tester',
        })).resolves.toMatchObject({
            status: 'materialized',
            credentialPath: join(claudeConfigDir, '.credentials.json'),
        });

        expect(exec.systemTools.resolve).not.toHaveBeenCalled();
        expect(exec.run).not.toHaveBeenCalled();
    });

    it('fails closed on darwin when stale macOS keychain cleanup fails before materialization is committed', async () => {
        const exec = createExecFixture({
            exitCode: 1,
            stderr: 'keychain cleanup failed with access-secret-placeholder',
        });
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-secret-placeholder',
                refreshToken: 'refresh-secret-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ exec, record, claudeConfigDir });

        expect(result.status).toBe('diagnostic');
        expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'claude_subscription_native_auth_keychain_write_failed',
                providerId: 'claude',
                serviceId: 'claude-subscription',
                reason: 'keychain_write_failed',
                severity: 'blocking',
            }),
        ]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
        await expect(lstat(join(claudeConfigDir, '.credentials.json'))).rejects.toThrow();
        await expect(lstat(join(claudeConfigDir, PROVENANCE_FILE_NAME))).rejects.toThrow();
    });

    it('restores previous native auth files when stale macOS keychain cleanup fails', async () => {
        const exec = createExecFixture({ exitCode: 1 });
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const previousCredentialPath = join(claudeConfigDir, '.credentials.json');
        const previousProvenancePath = join(claudeConfigDir, PROVENANCE_FILE_NAME);
        const previousRootConfigPath = join(claudeConfigDir, '.claude.json');
        const previousCredential = '{"claudeAiOauth":{"accessToken":"previous-access","refreshToken":"previous-refresh","scopes":["user:inference","user:profile","user:sessions:claude_code"]}}\n';
        const previousProvenance = '{"v":1,"serviceId":"claude-subscription","credentialProfileId":"previous","credentialCreatedAt":1,"credentialFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n';
        const previousRootConfig = '{"oauthAccount":{"emailAddress":"previous@example.test"},"additionalModelOptionsCache":[{"description":"previous entitlement"}]}\n';
        await writeFile(previousCredentialPath, previousCredential, { mode: 0o600 });
        await writeFile(previousProvenancePath, previousProvenance, { mode: 0o600 });
        await writeFile(previousRootConfigPath, previousRootConfig, { mode: 0o600 });
        const record = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'claude-subscription',
            profileId: 'oauth',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'access-secret-placeholder',
                refreshToken: 'refresh-secret-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: null,
                providerEmail: null,
            },
        });

        const result = await materializeClaudeCodeNativeAuth({ exec, record, claudeConfigDir });

        expect(result.status).toBe('diagnostic');
        await expect(readFile(previousCredentialPath, 'utf8')).resolves.toBe(previousCredential);
        await expect(readFile(previousProvenancePath, 'utf8')).resolves.toBe(previousProvenance);
        await expect(readFile(previousRootConfigPath, 'utf8')).resolves.toBe(previousRootConfig);
    });
});
