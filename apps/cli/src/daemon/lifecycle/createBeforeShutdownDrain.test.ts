import { describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createBeforeShutdownDrain } from './createBeforeShutdownDrain';

describe('createBeforeShutdownDrain', () => {
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
});
