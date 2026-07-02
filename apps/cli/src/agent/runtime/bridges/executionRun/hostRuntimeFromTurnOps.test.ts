import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from './hostRuntimeFromTurnOps';

describe('createExecutionRunHostRuntimeFromRuntimeTurnOperations', () => {
    it('provisions resumed sessions without importing provider history', async () => {
        const startOrLoadSession = vi.fn(async () => undefined);
        const operations: RuntimeTurnOperations = {
            beginTurnLifecycle: vi.fn(),
            startOrLoadSession,
            sendTurnPrompt: vi.fn(async () => undefined),
            steerInFlightTurn: vi.fn(async () => undefined),
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            respondToPermission: vi.fn(async () => undefined),
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: 'resume-123' }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };

        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        await expect(runtime.provisionSession({ resumeSessionId: ' resume-123 ' })).resolves.toEqual({
            sessionId: 'resume-123',
        });

        expect(startOrLoadSession).toHaveBeenCalledWith({
            resumeId: 'resume-123',
            importHistory: false,
        });
    });
});
