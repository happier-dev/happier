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

import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks';

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

describe('createSetupThisComputerInteractiveTaskKind release-ring manual relay takeover', () => {
    beforeEach(() => {
        cliCommonMocks.createLocalHappierJsonExecutor.mockReset();
    });

    it('scopes relay-owner inspection and service takeover to the selected release ring', async () => {
        const executorCalls: Array<{
            releaseRing: unknown;
            args: readonly string[];
            allowJsonFailure: boolean | undefined;
        }> = [];

        cliCommonMocks.createLocalHappierJsonExecutor.mockImplementation(({ releaseRing }: { releaseRing?: string }) => ({
            runHappierText: vi.fn(async (args: readonly string[]) => {
                executorCalls.push({
                    releaseRing,
                    args,
                    allowJsonFailure: undefined,
                });
                return {
                    status: 0,
                    stdout: '',
                    stderr: '',
                };
            }),
            runHappierJson: vi.fn(async (args: readonly string[], opts?: Readonly<{ allowJsonFailure?: boolean }>) => {
                executorCalls.push({
                    releaseRing,
                    args,
                    allowJsonFailure: opts?.allowJsonFailure,
                });

                if (args[0] === 'service' && args[1] === 'status') {
                    return { owner: null };
                }

                if (args[0] === 'auth' && args[1] === 'status') {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            machineId: 'machine-1',
                        },
                    };
                }

                if (args[0] === 'daemon' && args[1] === 'status') {
                    return {
                        daemon: { running: true },
                        service: { installed: true },
                        auth: { needsAuth: false, machineId: 'machine-1' },
                    };
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
            readBackgroundServiceSetupGuidance: async () => ({
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                currentHappierHomeDir: null,
                currentDefaultReleaseChannel: 'preview',
                managedReleaseChannels: [],
                manualRelayOwner: {
                    currentReleaseChannel: 'preview',
                    currentCliVersion: '0.2.0',
                },
                conflictingServices: [],
                foreignHomeConflictingServices: [],
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
                args: ['auth', 'status', '--json'],
                allowJsonFailure: true,
            },
            {
                releaseRing: 'preview',
                args: ['service', 'status', '--json'],
                allowJsonFailure: true,
            },
            {
                releaseRing: 'preview',
                args: ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
                allowJsonFailure: undefined,
            },
            {
                releaseRing: 'preview',
                args: ['service', 'install', '--takeover', '--json'],
                allowJsonFailure: undefined,
            },
            {
                releaseRing: 'preview',
                args: ['service', 'start', '--takeover', '--json'],
                allowJsonFailure: undefined,
            },
            {
                releaseRing: 'preview',
                args: ['daemon', 'status', '--json'],
                allowJsonFailure: undefined,
            },
        ]);
    });

    it('passes the selected release ring into local service replacement cleanup', async () => {
        const invocations: string[] = [];
        const uninstallCalls: Array<{ releaseRing: unknown }> = [];

        const kind = createSetupThisComputerInteractiveTaskKind({
            ensureLocalHappierTools: async () => {
                invocations.push('ensureLocalHappierTools');
            },
            readActiveRelayProfile: async () => ({
                serverUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
                localServerUrl: null,
            }),
            createRecipeExecutor: () => ({
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
            }),
            readBackgroundServiceSetupGuidance: async () => ({
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                currentHappierHomeDir: null,
                currentDefaultReleaseChannel: 'preview',
                managedReleaseChannels: [],
                manualRelayOwner: null,
                conflictingServices: [
                    {
                        label: 'com.happier.cli.daemon.stable.default',
                        releaseChannel: 'stable',
                        targetMode: 'pinned',
                        running: true,
                        serverUrl: 'https://relay.example.test',
                        happierHomeDir: null,
                    },
                ],
                foreignHomeConflictingServices: [],
                exactDefaultServiceExists: true,
                shouldOfferDefaultReleaseChannelSwitch: false,
                shouldPromptForManualRelayTakeover: false,
                shouldPromptForServiceReplacement: true,
            }),
            readCurrentRelayOwner: async () => null,
            uninstallExistingDaemonServices: async ({ releaseRing }) => {
                uninstallCalls.push({ releaseRing });
                invocations.push('uninstallExistingDaemonServices');
            },
        });

        const runner = createSystemTasksRunner({
            kinds: {
                'setup.thisComputer.v1': kind,
            },
        });

        await runner.start({
            taskId: 'setup-task-preview-service-replacement',
            kind: 'setup.thisComputer.v1',
            params: {
                surface: 'desktop.ui',
                target: 'thisComputer',
                channel: 'preview',
            },
        });

        const replacementPrompt = await waitForPendingPrompt(runner, {
            taskId: 'setup-task-preview-service-replacement',
            cursor: 0,
        });
        expect(replacementPrompt.pendingPrompt?.kind).toBe('daemon.replaceLocalBackgroundServices');

        await runner.respond({
            taskId: 'setup-task-preview-service-replacement',
            answer: { replaceExistingServices: true },
        });

        const finalPoll = await waitForResult(runner, {
            taskId: 'setup-task-preview-service-replacement',
            cursor: replacementPrompt.nextCursor,
        });

        expect(finalPoll.result?.ok).toBe(true);
        expect(uninstallCalls).toEqual([
            {
                releaseRing: 'preview',
            },
        ]);
        expect(invocations).toEqual([
            'ensureLocalHappierTools',
            'uninstallExistingDaemonServices',
            'configureRelay',
            'installDaemonService',
            'startDaemonService',
        ]);
    });

    it('reports the selected release-ring invoker in progress diagnostics', async () => {
        const kind = createSetupThisComputerInteractiveTaskKind({
            ensureLocalHappierTools: async () => undefined,
            readActiveRelayProfile: async () => ({
                serverUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
                localServerUrl: null,
            }),
            createRecipeExecutor: () => ({
                configureRelay: async () => undefined,
                readAuthStatus: async () => ({
                    authenticated: true,
                    machineId: 'machine-1',
                }),
                requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
                waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
                installDaemonService: async () => undefined,
                startDaemonService: async () => undefined,
                waitForReadyDaemon: async () => ({
                    serviceInstalled: true,
                    daemonRunning: true,
                    needsAuth: false,
                    machineId: 'machine-1',
                }),
            }),
            readBackgroundServiceSetupGuidance: async () => ({
                targetReleaseChannel: 'preview',
                targetServerUrl: 'https://relay.example.test',
                currentHappierHomeDir: null,
                currentDefaultReleaseChannel: 'preview',
                managedReleaseChannels: [],
                manualRelayOwner: null,
                conflictingServices: [],
                foreignHomeConflictingServices: [],
                exactDefaultServiceExists: true,
                shouldOfferDefaultReleaseChannelSwitch: false,
                shouldPromptForManualRelayTakeover: false,
                shouldPromptForServiceReplacement: false,
            }),
            readCurrentRelayOwner: async () => null,
        });

        const runner = createSystemTasksRunner({
            kinds: {
                'setup.thisComputer.v1': kind,
            },
        });

        await runner.start({
            taskId: 'setup-task-preview-diagnostics',
            kind: 'setup.thisComputer.v1',
            params: {
                surface: 'desktop.ui',
                target: 'thisComputer',
                channel: 'preview',
            },
        });

        const finalPoll = await waitForResult(runner, {
            taskId: 'setup-task-preview-diagnostics',
            cursor: 0,
        });

        expect(finalPoll.result?.ok).toBe(true);
        expect(finalPoll.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stepId: 'setup.thisComputer.configureRelay',
                type: 'progress',
                message: 'Running hprev server set --json',
                data: expect.objectContaining({
                    command: 'hprev',
                    args: ['server', 'set', '--server-url', 'https://relay.example.test', '--webapp-url', 'https://app.example.test', '--json'],
                }),
            }),
            expect.objectContaining({
                stepId: 'setup.thisComputer.installService',
                type: 'progress',
                message: 'Running hprev service install --json',
                data: expect.objectContaining({
                    command: 'hprev',
                    args: ['service', 'install', '--json'],
                }),
            }),
            expect.objectContaining({
                stepId: 'setup.thisComputer.verifyService',
                type: 'progress',
                message: 'Polling hprev daemon status --json',
                data: expect.objectContaining({
                    command: 'hprev',
                    args: ['daemon', 'status', '--json'],
                }),
            }),
        ]));
    });
});
