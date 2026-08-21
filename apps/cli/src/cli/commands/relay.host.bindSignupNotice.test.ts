import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { reloadConfiguration } from '../../configuration';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '../../testkit/logger/captureOutput';

let mockedPreparedPayloadRoot = '';
let mockedRelayUrl = 'http://127.0.0.1:3005';

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
    return {
        ...actual,
        prepareFirstPartyComponentPayloadFromGitHubRelease: async () => ({
            componentId: 'happier-server',
            channel: 'preview',
            versionId: 'preview-release-0.2.1',
            payloadRoot: mockedPreparedPayloadRoot,
            source: null,
            cleanup: async () => undefined,
        }),
    };
});

vi.mock('@happier-dev/cli-common/relayHost', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/relayHost')>();
    return {
        ...actual,
        createRelayHostEngine: () => ({
            readStatus: async () => ({
                installed: true,
                version: 'preview-release-0.2.1',
                service: { active: true, enabled: true },
                baseUrl: mockedRelayUrl,
                healthy: true,
            }),
            installOrUpdate: async () => ({ relayUrl: mockedRelayUrl, mode: 'user' }),
            control: async () => undefined,
        }),
    };
});

// This machine's real interfaces would make the note's presence depend on the
// host running the suite.
vi.mock('@/server/reachability/currentMachineReachableServerUrlCandidates', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/reachability/currentMachineReachableServerUrlCandidates')>();
    return {
        ...actual,
        collectCurrentMachineReachableServerUrlCandidates: async () => [],
    };
});

// Real `tailscale` invocations are a system boundary, and a non-interactive
// install skips the offer anyway.
vi.mock('@/integrations/tailscale/tailscaleStatus', () => ({
    readTailscaleStatusSnapshot: async () => null,
}));
vi.mock('@/integrations/tailscale/tailscaleServe', () => ({
    tailscaleServeHttpsUrlForInternalServerUrl: async () => null,
}));

vi.mock('@/terminal/prompts/promptInput', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/terminal/prompts/promptInput')>();
    return {
        ...actual,
        isInteractiveTerminal: () => false,
        promptInput: async () => '',
    };
});

async function runInstall(extraArgs: readonly string[] = []): Promise<string[]> {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        const { commandRegistry } = await import('../commandRegistry');
        const args = ['relay', 'host', 'install', ...extraArgs];
        await commandRegistry.relay({
            args,
            rawArgv: ['node', 'happier', ...args],
            terminalRuntime: null,
        });
        return [...output.logs];
    } finally {
        output.restore();
        process.exitCode = prevExitCode;
    }
}

describe('happier relay host install open-signup notice', () => {
    let home = '';
    let preparedPayloadRoot = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    // Loading the command registry transforms a large module graph. Pay that
    // once here rather than inside the first test's timeout budget.
    beforeAll(async () => {
        await import('../commandRegistry');
    }, 900_000);

    beforeEach(async () => {
        vi.resetModules();
        mockedRelayUrl = 'http://127.0.0.1:3005';
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-signup-home-');
        preparedPayloadRoot = await createTempDir('happier-relay-signup-prepared-');
        writeFileSync(join(preparedPayloadRoot, 'happier-server'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
        chmodSync(join(preparedPayloadRoot, 'happier-server'), 0o755);
        mockedPreparedPayloadRoot = preparedPayloadRoot;
        envScope.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
    });

    afterEach(async () => {
        envScope.restore();
        reloadConfiguration();
        await removeTempDir(home);
        await removeTempDir(preparedPayloadRoot);
    });

    it('tells the operator who can sign up when the relay binds past loopback', { timeout: 120_000 }, async () => {
        mockedRelayUrl = 'http://192.168.1.20:3005';

        const logs = (await runInstall(['--host', '192.168.1.20'])).join('\n');

        expect(logs).toContain('This relay listens on 192.168.1.20');
        expect(logs).toContain('create an account on it');
        expect(logs).toContain('https://docs.happier.dev/self-hosting/auth');
    });

    it('stays quiet for the loopback default', { timeout: 120_000 }, async () => {
        const logs = (await runInstall()).join('\n');

        expect(logs).toContain('Relay host installed');
        expect(logs).not.toContain('create an account on it');
    });
});
