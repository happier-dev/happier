import { describe, expect, it } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /list', () => {
    it('returns only the stable tracked session fields', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-1',
                    pid: 111,
                    spawnOptions: { directory: '/tmp/project-a' },
                },
                {
                    startedBy: 'daemon',
                    happySessionId: 'sess-2',
                    pid: 222,
                },
            ],
            machineId: 'machine_local',
            stopSession: async () => false,
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/list',
                headers: { 'x-happier-daemon-token': 'test-token' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({
                children: [
                    { startedBy: 'daemon', happySessionId: 'sess-1', pid: 111 },
                    { startedBy: 'daemon', happySessionId: 'sess-2', pid: 222 },
                ],
            });
        } finally {
            await app.close();
        }
    });
});
