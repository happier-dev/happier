import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { reloadConfiguration } from '../../configuration';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '../../testkit/logger/captureOutput';

let mockedPreparedPayloadRoot = '';
let mockedPreparedVersionId = 'preview-release-0.2.1';
let resolvedLocalInstallVersion: string | null = null;
let receivedSelfHostRelayBinaryOverride: string | null = null;

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        prepareFirstPartyComponentPayloadFromGitHubRelease: async () => ({
            componentId: 'happier-server',
            channel: 'preview',
            versionId: mockedPreparedVersionId,
            payloadRoot: mockedPreparedPayloadRoot,
            source: null,
            cleanup: async () => undefined,
        }),
    };
});

vi.mock('@happier-dev/cli-common/relayHost', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        createRelayHostEngine: (deps: any) => ({
            readStatus: async () => ({
                installed: true,
                version: resolvedLocalInstallVersion,
                service: { active: true, enabled: true },
                baseUrl: 'http://127.0.0.1:3005',
                healthy: true,
            }),
            installOrUpdate: async (params: any) => {
                receivedSelfHostRelayBinaryOverride = params.selfHostRelayBinaryOverride ?? null;
                resolvedLocalInstallVersion = deps.resolveLocalInstallVersion
                    ? await deps.resolveLocalInstallVersion({
                        channel: 'preview',
                        mode: 'user',
                        serverBinaryPath: String(params.selfHostRelayBinaryOverride ?? ''),
                    })
                    : null;
                return {
                    relayUrl: 'http://127.0.0.1:3005',
                    mode: 'user',
                };
            },
            control: async () => undefined,
        }),
    };
});

describe('happier relay host install local server-binary version tracking', () => {
    let home = '';
    let preparedPayloadRoot = '';
    let serverPayloadRoot = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeEach(async () => {
        vi.resetModules();
        resolvedLocalInstallVersion = null;
        receivedSelfHostRelayBinaryOverride = null;
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-local-version-home-');
        preparedPayloadRoot = await createTempDir('happier-relay-local-version-prepared-');
        serverPayloadRoot = await createTempDir('candidate-server-0.2.4');

        writeFileSync(join(preparedPayloadRoot, 'happier-server'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
        chmodSync(join(preparedPayloadRoot, 'happier-server'), 0o755);

        mkdirSync(join(serverPayloadRoot, 'bin'), { recursive: true });
        writeFileSync(join(serverPayloadRoot, 'bin', 'happier-server'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
        chmodSync(join(serverPayloadRoot, 'bin', 'happier-server'), 0o755);

        mockedPreparedPayloadRoot = preparedPayloadRoot;
        mockedPreparedVersionId = 'preview-release-0.2.1';

        envScope.patch({
            HAPPIER_HOME_DIR: home,
        });
        reloadConfiguration();
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        await removeTempDir(home);
        await removeTempDir(preparedPayloadRoot);
        await removeTempDir(serverPayloadRoot);
    });

    it('tracks the local payload root version instead of the prepared preview bundle version', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;

        try {
            const { commandRegistry } = await import('../commandRegistry');

            await commandRegistry.relay({
                args: ['relay', 'host', 'install', '--server-binary', join(serverPayloadRoot, 'bin', 'happier-server'), '--json'],
                rawArgv: ['node', 'hprev', 'relay', 'host', 'install', '--server-binary', join(serverPayloadRoot, 'bin', 'happier-server'), '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(resolvedLocalInstallVersion).toBe(basename(serverPayloadRoot));
            expect(resolvedLocalInstallVersion).not.toBe(mockedPreparedVersionId);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('forwards a local server binary to remote relay installation', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        const serverBinaryPath = join(serverPayloadRoot, 'bin', 'happier-server');

        try {
            const { commandRegistry } = await import('../commandRegistry');

            await commandRegistry.relay({
                args: [
                    'relay',
                    'host',
                    'install',
                    '--ssh',
                    'dev@example.test',
                    '--server-binary',
                    serverBinaryPath,
                    '--json',
                ],
                rawArgv: [
                    'node',
                    'hprev',
                    'relay',
                    'host',
                    'install',
                    '--ssh',
                    'dev@example.test',
                    '--server-binary',
                    serverBinaryPath,
                    '--json',
                ],
                terminalRuntime: null,
            });

            expect(receivedSelfHostRelayBinaryOverride).toBe(serverBinaryPath);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });

    it('accepts --yes for relay host install as a no-op installer acknowledgement', async () => {
        const output = captureConsoleLogAndMuteStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;

        try {
            const { commandRegistry } = await import('../commandRegistry');

            await commandRegistry.relay({
                args: ['relay', 'host', 'install', '--yes', '--json'],
                rawArgv: ['node', 'hprev', 'relay', 'host', 'install', '--yes', '--json'],
                terminalRuntime: null,
            });

            const parsed = JSON.parse(output.logs.join('\n').trim());
            expect(parsed.ok).toBe(true);
            expect(parsed.kind).toBe('relay_host_install');
            expect(resolvedLocalInstallVersion).toBe(mockedPreparedVersionId);
            expect(process.exitCode).toBe(0);
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });
});
