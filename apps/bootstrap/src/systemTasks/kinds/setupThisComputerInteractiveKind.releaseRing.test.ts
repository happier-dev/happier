import { describe, expect, it, vi, beforeEach } from 'vitest';

const cliCommonMocks = vi.hoisted(() => ({
    createLocalHappierJsonExecutor: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/systemTasks', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/systemTasks')>(
        '@happier-dev/cli-common/systemTasks'
    );
    return {
        ...actual,
        createLocalHappierJsonExecutor: cliCommonMocks.createLocalHappierJsonExecutor,
    };
});

import { createSystemTasksRunner, type SetupMachineRecipeExecutor } from '@happier-dev/cli-common/systemTasks';

import { createSetupThisComputerInteractiveTaskKind } from './setupThisComputerInteractiveKind.js';

async function waitForPendingPrompt(
    runner: ReturnType<typeof createSystemTasksRunner>,
    params: Readonly<{ taskId: string; cursor: number }>
) {
    let latest = await runner.poll(params);
    for (let attempt = 0; attempt < 50; attempt += 1) {
        latest = await runner.poll(params);
        if (latest.pendingPrompt) {
            return latest;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Expected pending prompt for ${params.taskId}: ${JSON.stringify(latest)}`);
}

async function waitForResult(
    runner: ReturnType<typeof createSystemTasksRunner>,
    params: Readonly<{ taskId: string; cursor: number }>
) {
    let latest = await runner.poll(params);
    for (let attempt = 0; attempt < 50; attempt += 1) {
        latest = await runner.poll(params);
        if (latest.result) {
            return latest;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

function createRecipeExecutor(invocations: string[]): SetupMachineRecipeExecutor {
    return {
        configureRelay: async () => {
            invocations.push('configureRelay');
        },
        readAuthStatus: async () => ({
            authenticated: true,
            machineId: 'machine-1',
        }),
        requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
        waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
        installDaemonService: async () => {
            invocations.push('installDaemonService');
        },
        startDaemonService: async () => {
            invocations.push('startDaemonService');
        },
        waitForReadyDaemon: async () => ({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
        }),
    };
}

describe('createSetupThisComputerInteractiveTaskKind release-ring manual relay takeover', () => {
    beforeEach(() => {
        cliCommonMocks.createLocalHappierJsonExecutor.mockReset();
    });

    it('scopes relay-owner inspection and manual relay stop to the selected release ring', async () => {
        const invocations: string[] = [];
        const executorCalls: Array<{
            releaseRing: unknown;
            args: readonly string[];
            allowJsonFailure: boolean | undefined;
        }> = [];

        cliCommonMocks.createLocalHappierJsonExecutor.mockImplementation(({ releaseRing }: { releaseRing?: string }) => ({
            runHappierText: vi.fn(),
            runHappierJson: vi.fn(async (args: readonly string[], opts?: Readonly<{ allowJsonFailure?: boolean }>) => {
                executorCalls.push({
                    releaseRing,
                    args,
                    allowJsonFailure: opts?.allowJsonFailure,
                });

                if (args[0] === 'service' && args[1] === 'status') {
                    return { owner: null };
                }

                return { ok: true };
            }),
        }));

        const kind = createSetupThisComputerInteractiveTaskKind({
            ensureLocalHappierTools: async () => undefined,
            readActiveRelayProfile: async () => ({
                serverUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
                localServerUrl: null,
            }),
            createRecipeExecutor: () => createRecipeExecutor(invocations),
            readBackgroundServiceSetupGuidance: async () => ({
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                currentDefaultReleaseChannel: 'preview',
                managedReleaseChannels: [],
                manualRelayOwner: {
                    currentReleaseChannel: 'preview',
                    currentCliVersion: '0.2.0',
                },
                conflictingServices: [],
                exactDefaultServiceExists: false,
                shouldOfferDefaultReleaseChannelSwitch: false,
                shouldPromptForManualRelayTakeover: true,
                shouldPromptForServiceReplacement: false,
            }),
        });

        const runner = createSystemTasksRunner({
            kinds: {
                'setup.thisComputer.v1': kind,
            },
        });

        await runner.start({
            taskId: 'setup-task-preview-manual-owner',
            kind: 'setup.thisComputer.v1',
            params: {
                surface: 'desktop.ui',
                target: 'thisComputer',
                channel: 'preview',
            },
        });

        const manualOwnerPrompt = await waitForPendingPrompt(runner, {
            taskId: 'setup-task-preview-manual-owner',
            cursor: 0,
        });
        expect(manualOwnerPrompt.pendingPrompt?.kind).toBe('daemon.takeOverManualRelayRuntimeForSetup');

        await runner.respond({
            taskId: 'setup-task-preview-manual-owner',
            answer: { takeOverManualRelayRuntime: true },
        });

        const finalPoll = await waitForResult(runner, {
            taskId: 'setup-task-preview-manual-owner',
            cursor: manualOwnerPrompt.nextCursor,
        });

        expect(finalPoll.result?.ok).toBe(true);
        expect(executorCalls).toEqual([
            {
                releaseRing: 'preview',
                args: ['service', 'status', '--json'],
                allowJsonFailure: true,
            },
            {
                releaseRing: 'preview',
                args: ['daemon', 'stop', '--json'],
                allowJsonFailure: undefined,
            },
        ]);
        expect(invocations).toEqual([
            'configureRelay',
            'installDaemonService',
            'startDaemonService',
        ]);
    });
});
