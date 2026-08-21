import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { reloadConfiguration } from '../../configuration';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout, captureStdout } from '../../testkit/logger/captureOutput';

type ReachableCandidate = Readonly<{
    url: string;
    source: string;
    label: string;
    detail: string | null;
    verified: boolean;
}>;

let mockedPreparedPayloadRoot = '';
let mockedRelayUrl = 'http://127.0.0.1:3005';
let mockedCandidates: readonly ReachableCandidate[] = [];
let mockedInteractive = false;
let collectCandidatesCalls = 0;
let promptAnswers: string[] = [];
let promptedQuestions: string[] = [];

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
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
    const actual = await importOriginal<any>();
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
    const actual = await importOriginal<any>();
    return {
        ...actual,
        collectCurrentMachineReachableServerUrlCandidates: async () => {
            collectCandidatesCalls += 1;
            return mockedCandidates;
        },
    };
});

// This file drives a real `relay host install`. Without these, the interactive
// case reaches the Tailscale Serve offer and blocks on a confirm prompt while
// shelling out to a real `tailscale` — neither of which this file is testing.
vi.mock('@/integrations/tailscale/tailscaleStatus', () => ({
    readTailscaleStatusSnapshot: async () => null,
}));

vi.mock('@/integrations/tailscale/tailscaleServe', () => ({
    tailscaleServeHttpsUrlForInternalServerUrl: async () => null,
}));

vi.mock('@/terminal/prompts/promptInput', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        isInteractiveTerminal: () => mockedInteractive,
        promptInput: async (question: string) => {
            promptedQuestions.push(question);
            return promptAnswers.shift() ?? '';
        },
    };
});

const LAN_CANDIDATE: ReachableCandidate = {
    url: 'http://192.168.1.20:3005',
    source: 'lan',
    label: 'LAN (en0)',
    detail: 'en0',
    verified: true,
};

const TAILSCALE_SERVE_CANDIDATE: ReachableCandidate = {
    url: 'https://box.tail1234.ts.net',
    source: 'tailscale-serve',
    label: 'Tailscale Serve (HTTPS)',
    detail: null,
    verified: true,
};

async function runInstall(extraArgs: readonly string[] = []): Promise<string[]> {
    const output = captureConsoleLogAndMuteStdout();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        const { commandRegistry } = await import('../commandRegistry');
        const args = ['relay', 'host', 'install', ...extraArgs];
        await commandRegistry.relay({
            args,
            rawArgv: ['node', 'hprev', ...args],
            terminalRuntime: null,
        });
        return [...output.logs];
    } finally {
        output.restore();
        process.exitCode = prevExitCode;
    }
}

describe('happier relay host install reachable relay URL selection', () => {
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
        mockedCandidates = [];
        mockedInteractive = false;
        collectCandidatesCalls = 0;
        promptAnswers = [];
        promptedQuestions = [];
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        home = await createTempDir('happier-relay-reachable-home-');
        preparedPayloadRoot = await createTempDir('happier-relay-reachable-prepared-');
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

    it('binds the relay profile to a reachable address instead of the loopback bind URL', { timeout: 120_000 }, async () => {
        mockedCandidates = [LAN_CANDIDATE];

        const logs = await runInstall();

        const { getActiveServerProfile } = await import('../../server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(active.serverUrl).toBe('http://192.168.1.20:3005');
        expect(active.localServerUrl).toBe('http://127.0.0.1:3005');
        expect(logs.join('\n')).toContain('http://192.168.1.20:3005');
        expect(promptedQuestions).toEqual([]);
    });

    it('says the relay is this-computer-only when nothing else can reach it', { timeout: 120_000 }, async () => {
        mockedCandidates = [];

        const logs = await runInstall();

        const { getActiveServerProfile } = await import('../../server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(active.serverUrl).toBe('http://127.0.0.1:3005');
        expect(logs.join('\n')).toContain('This will work only on this same machine.');
    });

    it('uses the address the user picked at the prompt', { timeout: 120_000 }, async () => {
        mockedInteractive = true;
        mockedCandidates = [TAILSCALE_SERVE_CANDIDATE, LAN_CANDIDATE];
        promptAnswers = ['2'];

        await runInstall();

        const { getActiveServerProfile } = await import('../../server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(promptedQuestions.length).toBeGreaterThan(0);
        expect(active.serverUrl).toBe('http://192.168.1.20:3005');
        expect(active.localServerUrl).toBe('http://127.0.0.1:3005');
    });

    it('keeps an already-reachable bind address when nobody can be asked', { timeout: 120_000 }, async () => {
        mockedRelayUrl = 'http://192.168.1.20:3005';
        mockedCandidates = [TAILSCALE_SERVE_CANDIDATE, LAN_CANDIDATE];

        await runInstall(['--host', '192.168.1.20']);

        const { getActiveServerProfile } = await import('../../server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(active.serverUrl).toBe('http://192.168.1.20:3005');
        expect(active.localServerUrl).toBeFalsy();
        expect(promptedQuestions).toEqual([]);
    });

    it('leaves --json installs alone, including the one the SSH installer drives', { timeout: 120_000 }, async () => {
        mockedCandidates = [LAN_CANDIDATE];

        const stdout = captureStdout();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        let text = '';
        try {
            const { commandRegistry } = await import('../commandRegistry');
            const args = ['relay', 'host', 'install', '--json'];
            await commandRegistry.relay({
                args,
                rawArgv: ['node', 'hprev', ...args],
                terminalRuntime: null,
            });
            text = stdout.text();
        } finally {
            stdout.restore();
            process.exitCode = prevExitCode;
        }

        expect(JSON.parse(text.trim())).toEqual({
            v: 1,
            ok: true,
            kind: 'relay_host_install',
            data: { relayUrl: 'http://127.0.0.1:3005', mode: 'user' },
        });
        expect(collectCandidatesCalls).toBe(0);

        const { getActiveServerProfile } = await import('../../server/serverProfiles');
        const active = await getActiveServerProfile();
        expect(active.serverUrl).toBe('http://127.0.0.1:3005');
    });
});
