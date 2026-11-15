import { describe, expect, it } from 'vitest';

import { createSessionStartupProjectSpawn } from './sessionStartupProjectOperation';

describe('resume native startup observation', () => {
    it('refuses resume when native startup observation is unavailable', async () => {
        const spawn = createSessionStartupProjectSpawn({ context: undefined,
            spawnSession: async () => { throw new Error('must not launch without observation'); } });
        await expect(spawn({ directory: '/repo', existingSessionId: 'resumed-session' }))
            .resolves.toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    });
    it('does not report a webhook-acknowledged resume as opened before native authentication settles', async () => {
        let finishNativeOpen!: () => void;
        const nativeOpen = new Promise<void>(resolve => { finishNativeOpen = resolve; });
        let settled = false;
        const spawn = createSessionStartupProjectSpawn({
            context: undefined,
            stopSession: async () => true,
            spawnSession: async () => ({ type: 'success', sessionId: 'resumed-session' }),
            awaitAgentSessionOpen: async () => {
                await nativeOpen;
                return { status: 'runner_exited', code: 'acp_session_start_failed',
                    failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error',
                        providerErrorCode: 'acp_authenticate_timeout' } };
            },
        });
        const result = spawn({ directory: '/repo', existingSessionId: 'resumed-session' });
        void result.then(() => { settled = true; });
        await new Promise<void>(resolve => { setImmediate(resolve); });
        try {
            expect(settled).toBe(false);
        } finally { finishNativeOpen(); }
        await expect(result).resolves.toMatchObject({ type: 'error', errorDetail: {
            kind: 'launch_error', code: 'acp_session_start_failed',
            failureCause: { phase: 'authentication', providerErrorCode: 'acp_authenticate_timeout' },
        } });
    });

    it('preserves a successfully opened resume without a project setup operation', async () => {
        const spawn = createSessionStartupProjectSpawn({
            context: undefined,
            stopSession: async () => true,
            spawnSession: async () => ({ type: 'success', sessionId: 'resumed-session' }),
            awaitAgentSessionOpen: async () => ({ status: 'opened',
                request: { kind: 'create', sessionId: 'resumed-session', cwd: '/repo' } }),
        });
        await expect(spawn({ directory: '/repo', existingSessionId: 'resumed-session' }))
            .resolves.toEqual({ type: 'success', sessionId: 'resumed-session' });
    });
});
