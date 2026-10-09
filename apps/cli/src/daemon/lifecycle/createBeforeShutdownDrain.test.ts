import { describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import {
    activateConnectedAccountRequestAuthForSpawn,
} from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';
import { createBeforeShutdownDrain } from './createBeforeShutdownDrain';
import { createDaemonAdmissionDrain } from './admissionDrain';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';

describe('createBeforeShutdownDrain', () => {
    it.each(['no-machine', 'rpc-drained', 'rpc-grace-expired', 'machine-detached'] as const)(
        'retains finite process custody through unconfirmed Stop before plugin disposal (%s)',
        async (shutdownPath) => {
            const admissionDrain = createDaemonAdmissionDrain();
            const runtime = createHostActionOperationRuntime({
                machineId: 'worker',
                resolveAccountId: async () => 'account',
                generateOperationId: () => 'retained-finite',
            });
            const events: string[] = [];
            let settleProcess!: () => void;
            const processSettled = new Promise<void>((resolve) => { settleProcess = resolve; });
            // The process adapter reports Stop uncertainty independently of its
            // actual exit; the host runtime/retirement/store remain real.
            await runtime.observeExecution({
                actionId: 'projects.compute.exec', input: {}, actionRequestId: 'accepted-exec',
                execute: async ({ signal, operationOwnerUpdate, operationCancellation }) => {
                    operationCancellation?.onRequest(() => {
                        events.push('stop');
                        operationOwnerUpdate.update({
                            observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' },
                        });
                    });
                    operationOwnerUpdate.update({
                        state: 'running',
                        domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
                            machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project' },
                    });
                    await processSettled;
                    events.push('process-settled');
                    return signal.aborted
                        ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
                        : { ok: true, result: {} };
                },
            });
            let machineReads = 0;
            const apiMachine = { awaitPendingRpcRequests: async () => undefined };
            const params = {
                admissionDrain,
                pidToAwaiter: new Map<number, unknown>(),
                pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
                shutdownSpawnDrainGraceMs: shutdownPath === 'rpc-grace-expired' ? 0 : 100,
                shutdownSpawnDrainPollMs: 10,
                getApiMachineForSessions: () => {
                    machineReads++;
                    return shutdownPath === 'no-machine'
                        || (shutdownPath === 'machine-detached' && machineReads > 1) ? null : apiMachine;
                },
                buildUnexpectedSpawnResult: (errorMessage: string) => ({
                    type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage,
                }),
                retireFiniteExecution: runtime.retireProjectFiniteOperations,
                disposePluginRuntimeRegistry: async () => { events.push('plugin-disposed'); },
            };
            const beforeShutdown = createBeforeShutdownDrain(params);
            let shutdownSettled = false;
            const shutdown = beforeShutdown().then(() => { shutdownSettled = true; });
            const repeatedShutdown = beforeShutdown();
            try {
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(admissionDrain.isFinalShutdown()).toBe(true);
                expect(events).toEqual(['stop']);
                expect(shutdownSettled).toBe(false);
                expect(await runtime.handlers.getV2({ operationId: 'retained-finite' })).toMatchObject({
                    kind: 'found', operation: { state: 'running', observation: { kind: 'stop_unconfirmed' } },
                });
                expect(await runtime.handlers.cancel({ operationId: 'retained-finite' })).toEqual({ kind: 'requested' });
                expect(await runtime.handlers.cancel({ operationId: 'retained-finite' })).toEqual({ kind: 'requested' });
                expect(events).toEqual(['stop', 'stop', 'stop']);
                expect(shutdownSettled).toBe(false);
                settleProcess();
                await Promise.all([shutdown, repeatedShutdown]);
                expect(await runtime.handlers.getV2({ operationId: 'retained-finite', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
                expect(events).toEqual(['stop', 'stop', 'stop', 'process-settled', 'plugin-disposed']);
                await beforeShutdown();
                expect(events).toEqual(['stop', 'stop', 'stop', 'process-settled', 'plugin-disposed']);
            } finally {
                settleProcess();
                await runtime.handlers.getV2({ operationId: 'retained-finite', waitForTerminal: true });
                await Promise.all([shutdown, repeatedShutdown]);
            }
        },
    );
    it('keeps temporary drain reversible until final shutdown owns disposal', async () => {
        const admissionDrain = createDaemonAdmissionDrain();
        const disposal: string[] = [];
        const beforeShutdown = createBeforeShutdownDrain({
            admissionDrain,
            pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
            shutdownSpawnDrainGraceMs: 0, shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: (errorMessage) => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage }),
            disposePluginRuntimeRegistry: async () => { disposal.push('disposed'); },
        });
        admissionDrain.beginTemporaryDrain();
        admissionDrain.resume();
        expect(admissionDrain.isQuiescing()).toBe(false);
        expect(disposal).toEqual([]);
        await beforeShutdown();
        admissionDrain.resume();
        expect(admissionDrain.isFinalShutdown()).toBe(true);
        expect(disposal).toEqual(['disposed']);
        await beforeShutdown();
        expect(disposal).toEqual(['disposed']);
    });
    it('retires each exact tracked startup before resolving a grace-expired spawn', async () => {
        const pid = 44_001;
        const events: string[] = [];
        const cancelStartupLaunchBeforeAck = vi.fn(async () => {
            events.push('retire');
            return { status: 'stopped' as const };
        });
        const resolveSpawn = vi.fn(() => {
            events.push('resolve');
        });
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map([[pid, {}]]),
            pidToSpawnResultResolver:
                new Map([[pid, resolveSpawn]]),
            pidToSpawnWebhookTimeout: new Map(),
            pidToTrackedSession: new Map([[
                pid,
                {
                    pid,
                    startedBy: 'daemon',
                    happySessionId: `PID-${pid}`,
                    cancelStartupLaunchBeforeAck,
                },
            ]]),
            shutdownSpawnDrainGraceMs: 0,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: (errorMessage) => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage,
            }),
            buildIncompleteRetirementResult: () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage:
                    'startup_retirement_incomplete:exit_cleanup_incomplete',
            }),
        });

        await beforeShutdown();

        expect(events).toEqual(['retire', 'resolve']);
        expect(resolveSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            }),
        );
    });

    it('surfaces incomplete retirement when grace-expired startup cancellation cannot prove disposition', async () => {
        const pid = 44_002;
        const resolveSpawn = vi.fn();
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map([[pid, {}]]),
            pidToSpawnResultResolver:
                new Map([[pid, resolveSpawn]]),
            pidToSpawnWebhookTimeout: new Map(),
            pidToTrackedSession: new Map([[
                pid,
                {
                    pid,
                    startedBy: 'daemon',
                    happySessionId: `PID-${pid}`,
                    cancelStartupLaunchBeforeAck: async () => ({
                        status: 'incomplete',
                        reason: 'process_still_running',
                    }),
                },
            ]]),
            shutdownSpawnDrainGraceMs: 0,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: (errorMessage) => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage,
            }),
            buildIncompleteRetirementResult: () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage:
                    'startup_retirement_incomplete:exit_cleanup_incomplete',
            }),
        });

        await beforeShutdown();

        expect(resolveSpawn).toHaveBeenCalledWith({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage:
                'startup_retirement_incomplete:exit_cleanup_incomplete',
        });
    });

    it('does not leak a request-auth descriptor when activation completes after grace-expiry retirement', async () => {
        const pid = 44_003;
        const descriptor = {
            path: '/materialized/.happier/request-auth-capability.json',
            materializationId: 'session-late',
            subjectScopeDigest: 'a'.repeat(64),
            capabilityDigest: 'b'.repeat(64),
        };
        let completeActivation!: (
            value: typeof descriptor,
        ) => void;
        const activationPaused = new Promise<typeof descriptor>(
            (resolve) => {
                completeActivation = resolve;
            },
        );
        const requestAuthRegistry = {
            activate: vi.fn(async () => await activationPaused),
            retire: vi.fn(async () => undefined),
        };
        const launchResourceScope =
            createProviderLaunchResourceScope();
        const activation = activateConnectedAccountRequestAuthForSpawn({
            materializationId: 'session-late',
            materializedRootDir: '/materialized',
            subject: {
                subjectId: 'agent-session:session-late',
                isCurrent: () => true,
                registerRedaction: () => undefined,
                resolvePurposeUse: () => null,
                listPurposeUses: () => [],
            },
            registry: requestAuthRegistry,
            httpPort: 43_123,
            launchResourceScope,
        });
        await vi.waitFor(
            () => expect(requestAuthRegistry.activate)
                .toHaveBeenCalledOnce(),
        );

        const resolveSpawn = vi.fn();
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map([[pid, {}]]),
            pidToSpawnResultResolver:
                new Map([[pid, resolveSpawn]]),
            pidToSpawnWebhookTimeout: new Map(),
            pidToTrackedSession: new Map([[
                pid,
                {
                    pid,
                    startedBy: 'daemon',
                    happySessionId: `PID-${pid}`,
                    cancelStartupLaunchBeforeAck: async () => {
                        await launchResourceScope.retire();
                        return { status: 'stopped' };
                    },
                },
            ]]),
            shutdownSpawnDrainGraceMs: 0,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: (errorMessage) => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage,
            }),
        });

        await beforeShutdown();
        expect(resolveSpawn).toHaveBeenCalledOnce();
        completeActivation(descriptor);
        await expect(activation).rejects.toThrow(
            'Provider launch resource scope is no longer open',
        );
        expect(requestAuthRegistry.retire).toHaveBeenCalledOnce();
        expect(requestAuthRegistry.retire)
            .toHaveBeenCalledWith(descriptor);
    });

    it('defers shutdown completion until pending machine RPC requests settle', async () => {
        let resolvePendingRpc!: () => void;
        const apiMachineForSessions = {
            awaitPendingRpcRequests: vi.fn(async () => await new Promise<void>((resolve) => {
                resolvePendingRpc = resolve;
            })),
        };
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            shutdownSpawnDrainGraceMs: 1_000,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => apiMachineForSessions,
            buildUnexpectedSpawnResult: () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unexpected',
            }),
        });

        let settled = false;
        const pendingDrain = beforeShutdown().then(() => {
            settled = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(apiMachineForSessions.awaitPendingRpcRequests).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        resolvePendingRpc();
        await pendingDrain;

        expect(settled).toBe(true);
    });

    it('runs background server-work drains even when no spawn or RPC work is pending', async () => {
        const drainBackgroundServerWork = vi.fn(async () => {});
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            shutdownSpawnDrainGraceMs: 100,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => null,
            buildUnexpectedSpawnResult: () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unexpected',
            }),
            drainBackgroundServerWork,
        });

        await beforeShutdown();

        expect(drainBackgroundServerWork).toHaveBeenCalledTimes(1);
    });

    it('keeps background transports live until pending RPC requests drain, then disposes plugin runtime', async () => {
        const calls: string[] = [];
        const apiMachineForSessions = {
            awaitPendingRpcRequests: vi.fn(async () => {
                calls.push('rpcDrain');
            }),
        };
        const beforeShutdown = createBeforeShutdownDrain({
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            shutdownSpawnDrainGraceMs: 100,
            shutdownSpawnDrainPollMs: 10,
            getApiMachineForSessions: () => apiMachineForSessions,
            buildUnexpectedSpawnResult: () => ({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unexpected',
            }),
            drainBackgroundServerWork: async () => {
                calls.push('backgroundDrain');
            },
            disposePluginRuntimeRegistry: async () => {
                calls.push('pluginRuntimeDispose');
            },
        });

        await beforeShutdown();

        expect(calls).toEqual(['rpcDrain', 'backgroundDrain', 'pluginRuntimeDispose']);
    });
});
