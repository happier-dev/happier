import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '../../configuration';
import type { DaemonServiceListEntry } from '../../daemon/service/cli';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '../../testkit/logger/captureOutput';

let mockedPreparedPayloadRoot = '';
let mockedRelayUrl = 'http://127.0.0.1:3005';
let mockedInteractive = false;
let promptAnswers: string[] = [];
let promptedQuestions: string[] = [];
let installedServices: readonly DaemonServiceListEntry[] = [];
let spawnedCliActions: string[][] = [];

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
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
    const actual = await importOriginal<Record<string, unknown>>();
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

vi.mock('@/server/reachability/currentMachineReachableServerUrlCandidates', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        collectCurrentMachineReachableServerUrlCandidates: async () => [],
    };
});

// Without these, a real `relay host install` reaches the Tailscale Serve offer
// and shells out to a real `tailscale` — neither of which this file is testing.
vi.mock('@/integrations/tailscale/tailscaleStatus', () => ({
    readTailscaleStatusSnapshot: async () => null,
}));

vi.mock('@/integrations/tailscale/tailscaleServe', () => ({
    tailscaleServeHttpsUrlForInternalServerUrl: async () => null,
}));

vi.mock('@/terminal/prompts/promptInput', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        isInteractiveTerminal: () => mockedInteractive,
        promptInput: async (question: string) => {
            promptedQuestions.push(question);
            return promptAnswers.shift() ?? '';
        },
    };
});

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        resolveInstalledDaemonServiceInventoryForCurrentRelay: async () => installedServices,
    };
});

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: (args: string[]) => {
        spawnedCliActions.push([...args]);
        return {
            on: (event: string, cb: (value?: number) => void) => {
                if (event === 'close') cb(0);
                return undefined;
            },
        };
    },
}));

function installedDefaultFollowingService(happierHomeDir: string): DaemonServiceListEntry {
    return {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        happierHomeDir,
        platform: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
            ? process.platform
            : 'linux',
        releaseChannel: configuration.publicReleaseRing,
        label: 'happier-daemon.default',
        targetMode: 'default-following',
    };
}

async function runRelay(args: readonly string[]): Promise<string[]> {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        const { commandRegistry } = await import('../commandRegistry');
        const argv = ['relay', ...args];
        await commandRegistry.relay({
            args: argv,
            rawArgv: ['node', 'hprev', ...argv],
            terminalRuntime: null,
        });
        return [...output.logs];
    } finally {
        output.restore();
        process.exitCode = prevExitCode;
    }
}

async function runInstall(extraArgs: readonly string[] = []): Promise<string[]> {
    return await runRelay(['host', 'install', ...extraArgs]);
}

describe('happier relay background service reconciliation', () => {
    let home = '';
    let preparedPayloadRoot = '';
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

    beforeAll(async () => {
        await import('../commandRegistry');
    }, 900_000);

    beforeEach(async () => {
        vi.resetModules();
        mockedRelayUrl = 'http://127.0.0.1:3005';
        mockedInteractive = false;
        promptAnswers = [];
        promptedQuestions = [];
        installedServices = [];
        spawnedCliActions = [];
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-service-followup-home-');
        preparedPayloadRoot = await createTempDir('happier-relay-service-followup-prepared-');
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

    it('tells a non-interactive installer to restart the background service now following the new relay', { timeout: 120_000 }, async () => {
        installedServices = [installedDefaultFollowingService(join(home, '.happier'))];

        const logs = await runInstall();

        expect(logs.join('\n')).toContain('happier service restart');
        expect(logs.join('\n')).toContain('http://127.0.0.1:3005');
    });

    it('hands authentication to the owner that restarts the background service after credentials are written', { timeout: 120_000 }, async () => {
        mockedInteractive = true;
        installedServices = [installedDefaultFollowingService(join(home, '.happier'))];
        // No credentials exist yet, so the follow-up authenticates first and then restarts.
        promptAnswers = ['y', 'y'];

        await runInstall();

        expect(spawnedCliActions).toContainEqual(['auth', 'login']);
        expect(spawnedCliActions).not.toContainEqual(['service', 'restart']);
    });

    it('leaves the background service alone when none follows the default relay', { timeout: 120_000 }, async () => {
        installedServices = [];

        const logs = await runInstall();

        expect(logs.join('\n')).not.toContain('happier service restart');
        expect(spawnedCliActions).toEqual([]);
    });

    it('does not reconcile the background service when the active relay is preserved', { timeout: 120_000 }, async () => {
        installedServices = [installedDefaultFollowingService(join(home, '.happier'))];

        const logs = await runInstall(['--preserve-active-server']);

        expect(logs.join('\n')).not.toContain('happier service restart');
        expect(spawnedCliActions).toEqual([]);
    });

    it('reconciles the background service when `relay use` switches the active relay', { timeout: 120_000 }, async () => {
        installedServices = [installedDefaultFollowingService(join(home, '.happier'))];

        const logs = await runRelay(['use', 'https://switched.example.test']);

        expect(logs.join('\n')).toContain('happier service restart');
        expect(logs.join('\n')).toContain('https://switched.example.test');
    });

    it('leaves the background service alone when `relay add` only saves a profile', { timeout: 120_000 }, async () => {
        installedServices = [installedDefaultFollowingService(join(home, '.happier'))];

        const logs = await runRelay(['add', 'https://saved-only.example.test']);

        expect(logs.join('\n')).not.toContain('happier service restart');
        expect(spawnedCliActions).toEqual([]);
    });
});
