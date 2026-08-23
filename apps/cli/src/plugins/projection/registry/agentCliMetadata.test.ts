import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { PluginAgentCliMetadata } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { createNativeAgentCliAuthSpec } from './agentCliMetadata';

const AUTH_PROBE_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS',
    'PATH',
] as const;

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(AUTH_PROBE_ENV_KEYS);

afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(AUTH_PROBE_ENV_KEYS);
    for (const dir of tempDirs) {
        await removeTempDir(dir);
    }
    tempDirs.clear();
});

function metadata(
    parser: PluginAgentCliMetadata['auth']['probe']['parser'],
    probe: Partial<PluginAgentCliMetadata['auth']['probe']> = {},
): PluginAgentCliMetadata {
    return {
        executable: {
            binaryName: 'acme',
            sourcePreference: 'system-first',
        },
        install: {
            manual: { kind: 'none' },
        },
        auth: {
            support: 'status_only',
            probe: {
                parser,
                backgroundChecks: 'safe',
                ...probe,
            },
            loginLaunches: [],
        },
    };
}

describe('native Agent CLI auth metadata projection', () => {
    it('executes and parses a declared whoami JSON status probe', async () => {
        const root = await createTempDir('happier-native-agent-auth-', tmpdir());
        tempDirs.add(root);
        const binDir = join(root, 'bin');
        await mkdir(binDir, { recursive: true });
        const executable = await writeExecutableShim({
            dir: binDir,
            fileName: 'acme',
            contents: "#!/bin/sh\nprintf '{\"email\":\"agent@example.com\"}\\n'\n",
        });
        const spec = createNativeAgentCliAuthSpec(metadata('kiroWhoamiJson', {
            statusArgs: ['whoami', '--format', 'json'],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
            state: 'logged_in',
            method: 'oauth_cli',
            source: 'command',
            accountLabel: 'agent@example.com',
        });
    });

    it('reads declared credential paths for credential-file probes', async () => {
        const root = await createTempDir('happier-native-agent-credentials-', tmpdir());
        tempDirs.add(root);
        const credentialsPath = join(root, 'credentials.json');
        await writeTextFile(credentialsPath, '{"claudeAiOauth":{"accessToken":"token","expiresAt":4102444800000}}\n');
        const spec = createNativeAgentCliAuthSpec(metadata('claudeCredentialsFile', {
            credentialPaths: [credentialsPath],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
            state: 'logged_in',
            method: 'credentials_file',
            source: 'file',
        });
    });

    it('preserves auth-token environment semantics for Claude-compatible probes', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-token';
        const spec = createNativeAgentCliAuthSpec(metadata('claudeCredentialsFile', {
            envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
            state: 'logged_in',
            method: 'auth_token_env',
            source: 'env',
        });
    });

    it('does not treat an unrelated non-empty JSON file as Codex credentials', async () => {
        const root = await createTempDir('happier-native-agent-invalid-credentials-', tmpdir());
        tempDirs.add(root);
        const credentialsPath = join(root, 'auth.json');
        await writeTextFile(credentialsPath, '{"theme":"dark"}\n');
        const spec = createNativeAgentCliAuthSpec(metadata('codexLoginStatus', {
            statusArgs: ['login', 'status'],
            credentialPaths: [credentialsPath],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: join(root, 'missing-codex') })).resolves.toEqual({
            state: 'unknown',
            reason: 'probe_failed',
            source: 'command',
        });
    });

    it('does not treat an unrelated non-empty JSON file as Gemini credentials', async () => {
        const root = await createTempDir('happier-native-agent-invalid-gemini-credentials-', tmpdir());
        tempDirs.add(root);
        const credentialsPath = join(root, 'oauth.json');
        await writeTextFile(credentialsPath, '{"theme":"dark"}\n');
        const spec = createNativeAgentCliAuthSpec(metadata('geminiCredentialFiles', {
            credentialPaths: [credentialsPath],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
            state: 'logged_out',
            reason: 'missing_credentials',
        });
    });

    it('does not override an explicit Codex logged-out result with a stale credential file', async () => {
        const root = await createTempDir('happier-native-agent-stale-codex-credentials-', tmpdir());
        tempDirs.add(root);
        const credentialsPath = join(root, 'auth.json');
        await writeTextFile(credentialsPath, '{"tokens":{"access_token":"stale-token"}}\n');
        const executable = await writeExecutableShim({
            dir: root,
            fileName: 'codex',
            contents: '#!/bin/sh\nexit 1\n',
        });
        const spec = createNativeAgentCliAuthSpec(metadata('codexLoginStatus', {
            statusArgs: ['login', 'status'],
            credentialPaths: [credentialsPath],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
            state: 'logged_out',
            reason: 'missing_credentials',
            source: 'command',
        });
    });

    it('reports malformed Cursor status output as a failed probe rather than logged out', async () => {
        const root = await createTempDir('happier-native-agent-cursor-auth-', tmpdir());
        tempDirs.add(root);
        const executable = await writeExecutableShim({
            dir: root,
            fileName: 'cursor-agent',
            contents: '#!/bin/sh\necho not-json\n',
        });
        const spec = createNativeAgentCliAuthSpec(metadata('cursorAboutJson', {
            statusArgs: ['about', '--format', 'json'],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: executable })).resolves.toEqual({
            state: 'unknown',
            reason: 'probe_failed',
            source: 'command',
        });
    });

    it.each(['envOnly', 'piEnvOnly'] as const)(
        'resolves %s probes from the declared env vars alone',
        async (parser) => {
            const spec = createNativeAgentCliAuthSpec(metadata(parser, {
                envVars: ['ANTHROPIC_API_KEY'],
            }));

            envScope.patch({ ANTHROPIC_API_KEY: undefined });
            await expect(spec.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/acme' })).resolves.toEqual({
                state: 'logged_out',
                reason: 'missing_credentials',
            });

            envScope.patch({ ANTHROPIC_API_KEY: 'sk-declared' });
            await expect(spec.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/acme' })).resolves.toEqual({
                state: 'logged_in',
                method: 'api_key_env',
                source: 'env',
            });
        },
    );

    it('detects declared GitHub token env vars before probing gh', async () => {
        envScope.patch({
            COPILOT_GITHUB_TOKEN: undefined,
            GH_TOKEN: 'gh-token',
            GITHUB_TOKEN: undefined,
        });
        const spec = createNativeAgentCliAuthSpec(metadata('copilotGhAuth', {
            envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
        }));

        await expect(spec.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toEqual({
            state: 'logged_in',
            method: 'api_key_env',
            source: 'env',
        });
    });

    // The `gh` probe is slower than the 1.5s default on cold GitHub CLI installs, so the
    // declared timeout must stay operator-tunable through the documented env key.
    it.skipIf(process.platform === 'win32')(
        'honors the operator gh auth probe timeout override',
        async () => {
            const root = await createTempDir('happier-native-agent-copilot-auth-', tmpdir());
            tempDirs.add(root);
            await writeExecutableShim({
                dir: root,
                fileName: 'gh',
                contents: '#!/bin/sh\nsleep 2\nprintf gh-oauth-token\n',
            });
            envScope.patch({
                COPILOT_GITHUB_TOKEN: undefined,
                GH_TOKEN: undefined,
                GITHUB_TOKEN: undefined,
                HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS: '20_000',
                PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
            });
            const spec = createNativeAgentCliAuthSpec(metadata('copilotGhAuth', {
                envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
            }));

            await expect(spec.detectAuthStatus?.({ resolvedPath: '/usr/local/bin/copilot' })).resolves.toEqual({
                state: 'logged_in',
                method: 'oauth_cli',
                source: 'command',
            });
        },
        30_000,
    );
});
