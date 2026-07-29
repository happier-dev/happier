import { describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /continue-with-replay', () => {
    it('rejects requests without the control token', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/continue-with-replay',
                headers: { 'Content-Type': 'application/json' },
                payload: JSON.stringify({
                    directory: '/tmp',
                    agent: 'claude',
                    replay: { previousSessionId: 'sess-prev' },
                }),
            });

            expect(res.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('returns a structured error when the daemon is not provisioned with credentials', async () => {
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        const homeDir = await createTempDir('happier-cli-daemon-control-replay-missing-creds-');
        envScope.patch({ HAPPIER_HOME_DIR: homeDir });
        reloadConfiguration();

        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/continue-with-replay',
                headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
                payload: JSON.stringify({
                    directory: '/tmp',
                    backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                    replay: { previousSessionId: 'sess-prev' },
                }),
            });

            expect(res.statusCode).toBe(500);
            expect(res.json()).toMatchObject({
                success: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
            });
        } finally {
            await app.close();
            envScope.restore();
            await removeTempDir(homeDir);
        }
    });

    it('returns INVALID_REQUEST as a client error for unknown agents', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/continue-with-replay',
                headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
                payload: JSON.stringify({
                    directory: '/tmp',
                    agent: 'not-a-real-agent',
                    replay: { previousSessionId: 'sess-prev' },
                }),
            });

            expect(res.statusCode).toBe(400);
            expect(res.json()).toEqual({
                success: false,
                error: 'Unknown agent id',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            });
        } finally {
            await app.close();
        }
    });

    it('fails closed for builtIn customAcp backendTarget payloads', async () => {
        const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'happy-test-123' } as const));
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession,
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/continue-with-replay',
                headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
                payload: JSON.stringify({
                    directory: '/tmp',
                    backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
                    replay: { previousSessionId: 'sess-prev' },
                }),
            });

            expect(res.statusCode).toBe(400);
            expect(spawnSession).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});
