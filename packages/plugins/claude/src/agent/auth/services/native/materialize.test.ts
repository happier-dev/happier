import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './scopes.js';
import { materializeClaudeCodeNativeAuth } from './materialize.js';

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const PROVENANCE_FILE_NAME = '.happier-claude-connected-service-home.json';

function createExecFixture(params: Readonly<{ exitCode?: number | null; stderr?: string }> = {}): ExecRuntimeServiceV1 {
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
            stdout: '',
            stderr: params.stderr ?? '',
        })),
    } as unknown as ExecRuntimeServiceV1;
}

describe('materializeClaudeCodeNativeAuth', () => {
    beforeEach(() => {
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
            }),
        ]);
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
        await expect(lstat(join(claudeConfigDir, '.credentials.json'))).rejects.toThrow();
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
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
    });

    it('writes the matching macOS keychain entry for healthy OAuth records on darwin', async () => {
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
            toolId: 'claude.macos.security',
            preferredCommand: 'security',
        }));
        expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'binary',
            executablePath: '/usr/bin/security',
            args: expect.arrayContaining(['add-generic-password']),
        }));
    });

    it('fails closed on darwin when the matching macOS keychain write fails', async () => {
        const exec = createExecFixture({
            exitCode: 1,
            stderr: 'keychain write failed with access-secret-placeholder',
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

    it('restores previous native auth files when the macOS keychain write fails', async () => {
        const exec = createExecFixture({ exitCode: 1 });
        Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
        const previousCredentialPath = join(claudeConfigDir, '.credentials.json');
        const previousProvenancePath = join(claudeConfigDir, PROVENANCE_FILE_NAME);
        const previousCredential = '{"claudeAiOauth":{"accessToken":"previous-access","refreshToken":"previous-refresh","scopes":["user:inference","user:profile","user:sessions:claude_code"]}}\n';
        const previousProvenance = '{"v":1,"serviceId":"claude-subscription","credentialProfileId":"previous","credentialCreatedAt":1,"credentialFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n';
        await writeFile(previousCredentialPath, previousCredential, { mode: 0o600 });
        await writeFile(previousProvenancePath, previousProvenance, { mode: 0o600 });
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
    });
});
