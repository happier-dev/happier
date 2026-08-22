import { describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import {
    activateConnectedAccountRequestAuthForSpawn,
} from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';
import { createBeforeShutdownDrain } from './createBeforeShutdownDrain';

describe('createBeforeShutdownDrain', () => {
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

    it('disposes plugin runtime registry after background and RPC drains', async () => {
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

        expect(calls).toEqual(['backgroundDrain', 'rpcDrain', 'pluginRuntimeDispose']);
    });
});
