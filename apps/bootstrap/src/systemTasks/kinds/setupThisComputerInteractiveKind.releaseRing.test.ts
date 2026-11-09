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

import { createLocalSetupFlowExecutor } from './localSetupFlowExecutor.js';
import {
    createProductionSetupThisComputerInteractiveDeps,
    createSetupThisComputerInteractiveTaskKind,
} from './setupThisComputerInteractiveKind.js';

/** The CLI acquisition the executor reports: managed install path, with the command it resolved. */
const MANAGED_CLI = { provenance: 'managed', command: '/home/tester/.happier/bin/happier' } as const;

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

    it('gives the explicit Home its own pinned service without switching the terminal, scoped to the selected ring', async () => {
        const executorCalls: Array<{
            releaseRing: unknown;
            args: readonly string[];
            allowJsonFailure: boolean | undefined;
            serviceTargetMode?: string;
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
                    stdout: args[0] === 'server' && args[1] === 'help'
                        ? '  happier server set [--server-id <id>] --server-url <url> [--webapp-url <url>] [--no-use]\n'
                        : '',
                    stderr: '',
                };
            }),
            runHappierJson: vi.fn(async (args: readonly string[], opts?: Readonly<{ allowJsonFailure?: boolean; env?: NodeJS.ProcessEnv }>) => {
                executorCalls.push({
                    releaseRing,
                    args,
                    allowJsonFailure: opts?.allowJsonFailure,
                    ...(opts?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE
                        ? { serviceTargetMode: opts.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE }
                        : {}),
                });
                const command = args[0] === '--server' ? args.slice(2) : args;

                if (command[0] === 'server' && command[1] === 'list') {
                    return {
                        ok: true,
                        data: {
                            activeServerId: 'cloud',
                            profiles: [
                                { id: 'cloud', serverUrl: 'https://api.happier.dev' },
                                { id: 'relay', serverUrl: 'https://relay.example.test' },
                            ],
                        },
                    };
                }

                if (command[0] === 'server' && command[1] === 'set') {
                    return { ok: true, kind: 'server_set', data: { profile: { id: 'relay' }, active: { id: 'cloud' }, used: false } };
                }

                if (command[0] === 'service' && command[1] === 'status') {
                    return { owner: null };
                }

                if (command[0] === 'auth' && command[1] === 'status') {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            credentialState: 'valid',
                            machineRegistrationState: 'server-confirmed',
                            machineId: 'machine-1',
                        },
                    };
                }

                if (command[0] === 'daemon' && command[1] === 'status') {
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
            createFlowExecutor: createLocalSetupFlowExecutor,
            switchDefaultReleaseChannel: async () => undefined,
            readServerProfileScope: createProductionSetupThisComputerInteractiveDeps().readServerProfileScope,
            upgradeCliForTokenOnlyPairing: async () => false,
            exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
            ensureLocalHappierTools: async () => MANAGED_CLI,
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
                exactDefaultServiceRunning: false,
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
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://app.example.test',
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
        // R10 D3: read-only resolution first; the Home's resolved profile is used as saved (never
        // rewritten, never selected), and every later command addresses this Home's own pinned
        // service and daemon.
        expect(executorCalls).toEqual([
            {
                releaseRing: 'preview',
                args: ['server', 'list', '--json'],
                allowJsonFailure: undefined,
            },
            {
                releaseRing: 'preview',
                args: ['--server', 'relay', 'service', 'status', '--json'],
                allowJsonFailure: true,
                serviceTargetMode: 'pinned',
            },
            {
                releaseRing: 'preview',
                args: ['server', 'help'],
                allowJsonFailure: undefined,
            },
            {
                releaseRing: 'preview',
                args: ['--server', 'relay', 'auth', 'status', '--json'],
                allowJsonFailure: true,
                serviceTargetMode: 'pinned',
            },
            {
                releaseRing: 'preview',
                args: ['--server', 'relay', 'service', 'install', '--takeover', '--json'],
                allowJsonFailure: undefined,
                serviceTargetMode: 'pinned',
            },
            {
                releaseRing: 'preview',
                args: ['--server', 'relay', 'service', 'start', '--takeover', '--json'],
                allowJsonFailure: undefined,
                serviceTargetMode: 'pinned',
            },
            {
                releaseRing: 'preview',
                args: ['--server', 'relay', 'daemon', 'status', '--json'],
                allowJsonFailure: undefined,
                serviceTargetMode: 'pinned',
            },
        ]);
        expect(executorCalls.some((call) => call.args.includes('server') && call.args.includes('set') && !call.args.includes('--no-use'))).toBe(false);
    });

    it('applies an accepted replacement through the selected ring\'s scoped install, never a remove-all', async () => {
        const invocations: string[] = [];
        const executorCalls: Array<Record<string, unknown>> = [];

        const kind = createSetupThisComputerInteractiveTaskKind({
            switchDefaultReleaseChannel: async () => undefined,
            exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
            ensureLocalHappierTools: async () => {
                invocations.push('ensureLocalHappierTools');
                return MANAGED_CLI;
            },
            readActiveRelayProfile: async () => ({
                serverUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
                localServerUrl: null,
            }),
            createFlowExecutor: (params) => {
                executorCalls.push({ ...params });
                return {
                configureRelay: async () => {
                    invocations.push('configureRelay');
                },
                // Already paired: valid credentials and a server-confirmed machine, so the flow
                // attempts no pairing. Pairing is covered by the pairing-approval tests.
                readAuthStatus: async () => ({
                    authenticated: true,
                    credentialState: 'valid' as const,
                    machineRegistrationState: 'server-confirmed' as const,
                    machineId: 'machine-1',
                }),
                requestAuthPairing: async () => ({ publicKey: 'pub-key' }),
                waitForAuthPairing: async () => ({ machineId: 'machine-1' }),
                installDaemonService: async (opts) => {
                    invocations.push(opts?.replaceExisting ? 'installDaemonService:replaceExisting' : 'installDaemonService');
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
            },
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
                exactDefaultServiceRunning: false,
                shouldOfferDefaultReleaseChannelSwitch: false,
                shouldPromptForManualRelayTakeover: false,
                shouldPromptForServiceReplacement: true,
            }),
            readCurrentRelayOwner: async () => null,
            readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
            upgradeCliForTokenOnlyPairing: async () => false,
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
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://app.example.test',
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
        expect(executorCalls).toEqual([
            {
                releaseRing: 'preview',
                takeOverManualRelayRuntime: false,
                signal: expect.any(AbortSignal),
                scopeToConfiguredServer: true,
                knownServerScope: { serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' },
            },
        ]);
        expect(invocations).toEqual([
            'ensureLocalHappierTools',
            'configureRelay',
            'installDaemonService:replaceExisting',
            'startDaemonService',
        ]);
    });

    it('reports the selected release-ring invoker in progress diagnostics', async () => {
        const kind = createSetupThisComputerInteractiveTaskKind({
            switchDefaultReleaseChannel: async () => undefined,
            readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
            upgradeCliForTokenOnlyPairing: async () => false,
            exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
            ensureLocalHappierTools: async () => MANAGED_CLI,
            readActiveRelayProfile: async () => ({
                serverUrl: 'https://relay.example.test',
                webappUrl: 'https://app.example.test',
                localServerUrl: null,
            }),
            createFlowExecutor: () => ({
                configureRelay: async () => undefined,
                // Already paired: valid credentials and a server-confirmed machine, so the flow
                // attempts no pairing. Pairing is covered by the pairing-approval tests.
                readAuthStatus: async () => ({
                    authenticated: true,
                    credentialState: 'valid' as const,
                    machineRegistrationState: 'server-confirmed' as const,
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
                exactDefaultServiceExists: false,
                exactDefaultServiceRunning: false,
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
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://app.example.test',
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
