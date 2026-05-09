import { describe, expect, it, vi } from 'vitest';

import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';

vi.mock('@/configuration', () => ({
    configuration: {
        daemonSpawnExistingSessionWaitForExitMs: 0,
        daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
        daemonStopSessionWaitForExitMs: 0,
        daemonStopSessionWaitForExitPollIntervalMs: 50,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@/api/session/pendingQueueV2Transport', () => ({
    materializeNextPendingQueueV2MessageViaHttp: vi.fn(async () => ({
        didMaterialize: false,
        localId: null,
        didWrite: false,
    })),
}));

vi.mock('../controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({
        port: 43210,
        stop: vi.fn(async () => {}),
    })),
}));

vi.mock('./executeSpawnSessionRequest', () => ({
    executeSpawnSessionRequest: vi.fn(async () => ({
        type: 'success',
        sessionId: 'spawned-session',
    })),
}));

describe('startDaemonSessionControlRuntime', () => {
    it('materializes pending queue with daemon credentials when an existing session is already active', async () => {
        const pidToTrackedSession = new Map<number, TrackedSession>([
            [
                process.pid,
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-live',
                    pid: process.pid,
                    spawnOptions: {
                        directory: '/tmp/project',
                        existingSessionId: 'sess-live',
                    },
                },
            ],
        ]);

        const runtime = await startDaemonSessionControlRuntime({
            machineId: 'machine-1',
            credentials: {
                token: 'token-daemon',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            // Test fixture boundary: existing-session short-circuit means API methods are not invoked.
            api: {} as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            pidToTrackedSession,
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: new Set(),
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const optionsWithUnexpectedToken: SpawnSessionOptions & { token: string } = {
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            existingSessionId: 'sess-live',
            token: 'token-from-spawn-options',
        };

        await expect(runtime.spawnSession(optionsWithUnexpectedToken)).resolves.toEqual({
            type: 'success',
            sessionId: 'sess-live',
        });

        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token-daemon',
            sessionId: 'sess-live',
        });
        expect(executeSpawnSessionRequest).not.toHaveBeenCalled();

        await runtime.stopControlServer();
    });
});
