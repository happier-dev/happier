import { describe, expect, it, vi } from 'vitest';

import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol';

import { createDaemonControlApp } from './controlServer';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';

describe('daemon control server: simulator preview endpoints', () => {
    it('routes simulator preview snapshot and actions to the daemon-owned simulator runtime', async () => {
        const snapshot: SimulatorPreviewSnapshotV1 = {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 3_000,
            refreshState: 'idle',
            resources: [],
            diagnostics: [],
        };
        const result: SimulatorPreviewActionResultV1 = {
            v: 1,
            eventType: 'simulator.devices.list',
            status: 'accepted',
            diagnostics: [],
        };
        const simulatorPreview: SimulatorPreviewRoutes = {
            getSnapshot: vi.fn(async () => snapshot),
            dispatchAction: vi.fn(async () => result),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            simulatorPreview,
        });

        try {
            await app.ready();
            const headers = { 'x-happier-daemon-token': 'test-token' };

            const snapshotResponse = await app.inject({
                method: 'POST',
                url: '/devices/simulator/preview/snapshot',
                headers,
            });
            expect(snapshotResponse.statusCode).toBe(200);
            expect(snapshotResponse.json()).toEqual({ ok: true, snapshot });

            const actionResponse = await app.inject({
                method: 'POST',
                url: '/devices/simulator/preview/action',
                headers,
                payload: {
                    protocolVersion: 1,
                    machineId: 'machine_local',
                    event: { type: 'simulator.devices.list' },
                },
            });
            expect(actionResponse.statusCode).toBe(200);
            expect(actionResponse.json()).toEqual({ ok: true, result });
        } finally {
            await app.close();
        }

        expect(simulatorPreview.dispatchAction).toHaveBeenCalledWith({
            type: 'simulator.devices.list',
        });
    });

    it('keeps simulator preview endpoints authenticated and explicit when runtime is unavailable', async () => {
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
            expect((await app.inject({
                method: 'POST',
                url: '/devices/simulator/preview/snapshot',
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/devices/simulator/preview/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            })).statusCode).toBe(501);
            expect((await app.inject({
                method: 'POST',
                url: '/devices/simulator/preview/action',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: {
                    protocolVersion: 1,
                    machineId: 'machine_local',
                    event: { type: 'simulator.devices.list' },
                },
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });
});
