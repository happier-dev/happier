import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createDaemonControlApp } from './controlServer';

describe('createDaemonControlApp /session-started body limit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('accepts large session-started metadata payloads', async () => {
        const onHappySessionWebhook = vi.fn();
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => true),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            controlToken: 'control-token',
        });

        try {
            const metadata: Metadata = {
                path: '/test/large-path',
                host: 'test-host',
                homeDir: '/test/home',
                happyHomeDir: '/test/happy-home',
                happyLibDir: '/test/happy-lib',
                happyToolsDir: '/test/happy-tools',
                hostPid: 99998,
                startedBy: 'terminal',
                machineId: 'test-machine-large',
                summary: {
                    text: 'x'.repeat(2 * 1024 * 1024),
                    updatedAt: Date.now(),
                },
            };

            const response = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: {
                    'x-happier-daemon-token': 'control-token',
                },
                payload: {
                    sessionId: 'test-session-large',
                    metadata,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: 'ok' });
            expect(onHappySessionWebhook).toHaveBeenCalledWith('test-session-large', metadata);
        } finally {
            await app.close();
        }
    });
});
