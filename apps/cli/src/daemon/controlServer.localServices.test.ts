import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';

describe('daemon control server: local service inventory endpoints', () => {
    it('routes snapshot, refresh, and label patches to the daemon-owned inventory routes', async () => {
        const snapshot = {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            entries: [],
            diagnostics: [],
        } as const;
        const refreshed = { ...snapshot, generatedAt: 2_000 };
        const localServicesInventory: LocalServiceInventoryRoutes = {
            getSnapshot: vi.fn(async () => snapshot),
            refreshSnapshot: vi.fn(async () => refreshed),
            patchLabel: vi.fn(async () => ({ ok: true as const })),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => false,
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesInventory,
        });

        try {
            await app.ready();
            const headers = { 'x-happier-daemon-token': 'test-token' };

            const snapshotResponse = await app.inject({
                method: 'POST',
                url: '/local-services/inventory/snapshot',
                headers,
            });
            expect(snapshotResponse.statusCode).toBe(200);
            expect(snapshotResponse.json()).toEqual({ ok: true, snapshot });

            const refreshResponse = await app.inject({
                method: 'POST',
                url: '/local-services/inventory/refresh',
                headers,
            });
            expect(refreshResponse.statusCode).toBe(200);
            expect(refreshResponse.json()).toEqual({ ok: true, snapshot: refreshed });

            const labelResponse = await app.inject({
                method: 'POST',
                url: '/local-services/inventory/labels/patch',
                headers,
                payload: {
                    inventoryId: 'entry-1',
                    label: { text: 'Web app' },
                    source: 'user',
                },
            });
            expect(labelResponse.statusCode).toBe(200);
            expect(labelResponse.json()).toEqual({ ok: true });
        } finally {
            await app.close();
        }

        expect(localServicesInventory.patchLabel).toHaveBeenCalledWith({
            inventoryId: 'entry-1',
            label: { text: 'Web app' },
            source: 'user',
            now: expect.any(Number),
        });
    });

    it('keeps local service inventory endpoints authenticated and explicit when runtime is unavailable', async () => {
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => false,
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/inventory/snapshot',
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/inventory/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });
});
