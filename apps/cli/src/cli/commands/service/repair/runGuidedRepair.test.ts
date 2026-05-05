import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepairFinding } from '@/diagnostics/doctorRepair';

const { promptConfirmYesNoMock, spawnSyncMock } = vi.hoisted(() => ({
    promptConfirmYesNoMock: vi.fn(async (_prompt: string, _options?: { default?: 'yes' | 'no' }) => true),
    spawnSyncMock: vi.fn(),
}));

const { promptMultipleChoiceMock } = vi.hoisted(() => ({
    promptMultipleChoiceMock: vi.fn(async (
        _prompt: string,
        _choices: unknown,
        _options?: unknown,
    ) => 'replace'),
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
    promptConfirmYesNo: (prompt: string, options?: { default?: 'yes' | 'no' }) =>
        promptConfirmYesNoMock(prompt, options),
}));

vi.mock('@/terminal/prompts/promptMultipleChoice', () => ({
    promptMultipleChoice: (prompt: string, choices: unknown, options?: unknown) =>
        promptMultipleChoiceMock(prompt, choices, options),
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawnSync: spawnSyncMock,
    };
});

import { runGuidedRepair } from './runGuidedRepair';

describe('runGuidedRepair', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        promptConfirmYesNoMock.mockReset();
        promptConfirmYesNoMock.mockResolvedValue(true);
        promptMultipleChoiceMock.mockReset();
        promptMultipleChoiceMock.mockResolvedValue('replace');
        spawnSyncMock.mockReset();
    });

    it('starts daemon repair against the finding server profile', async () => {
        spawnSyncMock.mockReturnValue({
            pid: 1234,
            output: [],
            stdout: undefined,
            stderr: undefined,
            status: 0,
            signal: null,
        } satisfies Partial<ReturnType<typeof import('node:child_process').spawnSync>>);

        const finding: RepairFinding = {
            kind: 'machine_not_registered_for_profile',
            severity: 'warning',
            autoApplyWithoutPrompt: false,
            serverId: 'scoped-server',
            serverName: 'Scoped Server',
            serverUrl: 'https://scoped.example.test',
        };

        const result = await runGuidedRepair({
            findings: [finding],
            currentCli: {
                releaseChannel: 'stable',
                version: '0.0.0-test',
                invoker: 'happier',
            },
        });

        expect(result).toBe(false);
        expect(promptConfirmYesNoMock).toHaveBeenCalledOnce();

        const childArgs = spawnSyncMock.mock.calls[0]?.[1] as string[] | undefined;
        expect(childArgs).toBeDefined();
        const daemonArgIndex = childArgs?.lastIndexOf('daemon') ?? -1;
        expect(daemonArgIndex).toBeGreaterThanOrEqual(0);
        expect(childArgs?.slice(daemonArgIndex, daemonArgIndex + 4)).toEqual([
            'daemon',
            'start',
            '--server',
            'scoped-server',
        ]);
    });

    it('targets the old channel service when replacing a switched stack', async () => {
        spawnSyncMock.mockReturnValue({
            pid: 1234,
            output: [],
            stdout: undefined,
            stderr: undefined,
            status: 0,
            signal: null,
        } satisfies Partial<ReturnType<typeof import('node:child_process').spawnSync>>);

        const finding: RepairFinding = {
            kind: 'channel_switch_recommended',
            severity: 'info',
            autoApplyWithoutPrompt: false,
            toChannel: 'dev',
            willActiveServerChange: true,
            targetChannelHasLocalRelay: false,
            fromStack: {
                releaseChannel: 'stable',
                ringId: 'stable',
                hasCurrentCli: false,
                archetype: 'cli-daemon-hosted',
                activeServerUrl: 'https://stable.example.test',
                isHostedCloudActive: true,
                localRelay: null,
                runningDaemon: {
                    serverId: 'default',
                    pid: 4321,
                    httpPort: null,
                    startedBy: 'automatic-startup',
                    startedWithReleaseChannel: 'stable',
                    startedWithCliVersion: '1.0.0',
                    matchesCurrentCli: false,
                    staleStateFile: false,
                    relayUrl: null,
                },
                automaticStartup: {
                    serverId: 'default',
                    name: 'happier-daemon.default',
                    releaseChannel: 'stable',
                    ringId: 'stable',
                    mode: 'user',
                    targetMode: 'default-following',
                    relayUrl: null,
                    running: true,
                    configuredCliVersion: '1.0.0',
                    runningCliVersion: '1.0.0',
                    path: '/home/test/.config/systemd/user/happier-daemon.default.service',
                    happierHomeDir: '/home/test/.happier',
                    isForeignHome: false,
                    installedDefinitionMatchesExpected: true,
                    isLegacyChannelScoped: false,
                    managedServerIds: ['default'],
                },
            },
        };

        const result = await runGuidedRepair({
            findings: [finding],
            currentCli: {
                releaseChannel: 'dev',
                version: '0.0.0-test',
                invoker: 'hdev',
            },
        });

        expect(result).toBe(false);
        expect(promptMultipleChoiceMock).toHaveBeenCalledOnce();

        const childArgs = spawnSyncMock.mock.calls.map((call) => call[1] as string[]);
        expect(childArgs).toHaveLength(3);
        expect(childArgs[0]).toEqual(expect.arrayContaining([
            'daemon',
            'stop',
            '--server-id',
            'default',
            '--pid',
            '4321',
        ]));
        expect(childArgs[1]).toEqual(expect.arrayContaining([
            'service',
            'uninstall',
            '--ring',
            'stable',
            '--instance',
            'default',
            '--yes',
        ]));
        expect(childArgs[2]).toEqual(expect.arrayContaining([
            'daemon',
            'start',
        ]));
    });
});
