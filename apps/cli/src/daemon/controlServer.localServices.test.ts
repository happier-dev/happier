import { describe, expect, it, vi } from 'vitest';

import type {
    LocalServiceLauncherSnapshotV1,
    LocalServicePreviewSnapshotV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';

import { createDaemonControlApp } from './controlServer';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import type { LocalServiceLauncherRoutes } from './local/services/launch/routes';
import type { PluginLocalServicesBridgeControlRoutes } from './local/services/pluginBridgeRoutes';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { LocalServicePublicPreviewRoutes } from './local/services/public/routes';
import { hashPluginLocalServicesBridgeToken } from './local/services/pluginBridgeAuthorization';

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
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 1234,
                happySessionId: 'session-1',
                localServicesBridgeTokenHash: hashPluginLocalServicesBridgeToken('bridge-token-session-1'),
                localServicesBridgePluginId: 'acme.plugin',
                localServicesBridgeContributionId: 'acme.plugin.backend',
            }],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
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

    it('keeps local service action execution authenticated and explicit when runtime is unavailable', async () => {
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
            const payload = {
                requestId: 'request-a',
                target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine_local' },
                action: 'stop_managed',
                confirmationNonce: 'confirm-a',
            };
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/actions/execute',
                payload,
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/actions/execute',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload,
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });

    it('routes plugin local-service bridge operations to the daemon-owned plugin bridge runtime', async () => {
        const snapshot = {
            id: 'web',
            phase: 'running' as const,
            port: 5173,
            url: 'https://preview.happier.test/plugin-web/',
            diagnostics: [],
        };
        const localServicesPluginBridge: PluginLocalServicesBridgeControlRoutes = {
            dispatch: vi.fn(async () => ({ ok: true as const, snapshot })),
        };
        const app = createDaemonControlApp({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 1234,
                happySessionId: 'session-1',
                localServicesBridgeTokenHash: hashPluginLocalServicesBridgeToken('bridge-token-session-1'),
                localServicesBridgePluginId: 'acme.plugin',
                localServicesBridgeContributionId: 'acme.plugin.backend',
            }],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPluginBridge,
        });

        try {
            await app.ready();
            const payload = {
                protocolVersion: 1,
                bridgeToken: 'bridge-token-session-1',
                context: {
                    pluginId: 'acme.plugin',
                    contributionId: 'acme.plugin.backend',
                    sessionId: 'session-1',
                    title: 'Preview Session',
                },
                operation: {
                    kind: 'start',
                    declaration: {
                        id: 'web',
                        launch: { kind: 'binary', executablePath: '/bin/sh', args: ['-lc', 'npm run dev'] },
                        launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
                        hostPolicy: { kind: 'loopback' },
                        name: { strategy: 'derived', base: 'web' },
                        healthCheck: { kind: 'none' },
                        restart: { kind: 'never' },
                        cleanup: { staleAfterMs: 30_000 },
                    },
                },
            };
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/plugin/bridge',
                payload,
            })).statusCode).toBe(401);
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/plugin/bridge',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload,
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, snapshot });
        } finally {
            await app.close();
        }

        expect(localServicesPluginBridge.dispatch).toHaveBeenCalledWith({
            protocolVersion: 1,
            context: {
                pluginId: 'acme.plugin',
                contributionId: 'acme.plugin.backend',
                sessionId: 'session-1',
                title: 'Preview Session',
            },
            operation: {
                kind: 'start',
                declaration: expect.objectContaining({ id: 'web' }),
            },
        });
    });

    it('rejects plugin bridge requests without spawned-session bridge authorization', async () => {
        const localServicesPluginBridge: PluginLocalServicesBridgeControlRoutes = {
            dispatch: vi.fn(async () => ({ ok: true as const })),
        };
        const app = createDaemonControlApp({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 1234,
                happySessionId: 'session-1',
                localServicesBridgeTokenHash: hashPluginLocalServicesBridgeToken('bridge-token-session-1'),
                localServicesBridgePluginId: 'acme.plugin',
                localServicesBridgeContributionId: 'acme.plugin.backend',
            }],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPluginBridge,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/plugin/bridge',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: {
                    protocolVersion: 1,
                    context: {
                        pluginId: 'acme.plugin',
                        contributionId: 'acme.plugin.backend',
                        sessionId: 'session-1',
                        title: 'Preview Session',
                    },
                    operation: { kind: 'get', serviceId: 'web' },
                },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'local_services_plugin_bridge_forbidden',
            });
        } finally {
            await app.close();
        }

        expect(localServicesPluginBridge.dispatch).not.toHaveBeenCalled();
    });

    it('rejects plugin bridge requests with mismatched spawned-session bridge context', async () => {
        const localServicesPluginBridge: PluginLocalServicesBridgeControlRoutes = {
            dispatch: vi.fn(async () => ({ ok: true as const })),
        };
        const app = createDaemonControlApp({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 1234,
                happySessionId: 'session-1',
                localServicesBridgeTokenHash: hashPluginLocalServicesBridgeToken('bridge-token-session-1'),
                localServicesBridgePluginId: 'acme.plugin',
                localServicesBridgeContributionId: 'acme.plugin.backend',
            }],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPluginBridge,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/plugin/bridge',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: {
                    protocolVersion: 1,
                    bridgeToken: 'bridge-token-session-1',
                    context: {
                        pluginId: 'acme.plugin',
                        contributionId: 'other.plugin.backend',
                        sessionId: 'session-1',
                        title: 'Preview Session',
                    },
                    operation: { kind: 'get', serviceId: 'web' },
                },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'local_services_plugin_bridge_forbidden',
            });
        } finally {
            await app.close();
        }

        expect(localServicesPluginBridge.dispatch).not.toHaveBeenCalled();
    });

    it('rejects plugin bridge requests with mismatched plugin owner even when token and contribution match', async () => {
        const localServicesPluginBridge: PluginLocalServicesBridgeControlRoutes = {
            dispatch: vi.fn(async () => ({ ok: true as const })),
        };
        const app = createDaemonControlApp({
            getChildren: () => [{
                startedBy: 'daemon',
                pid: 1234,
                happySessionId: 'session-1',
                localServicesBridgeTokenHash: hashPluginLocalServicesBridgeToken('bridge-token-session-1'),
                localServicesBridgePluginId: 'acme.plugin',
                localServicesBridgeContributionId: 'acme.plugin.backend',
            }],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPluginBridge,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/plugin/bridge',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: {
                    protocolVersion: 1,
                    bridgeToken: 'bridge-token-session-1',
                    context: {
                        pluginId: 'other.plugin',
                        contributionId: 'acme.plugin.backend',
                        sessionId: 'session-1',
                        title: 'Preview Session',
                    },
                    operation: { kind: 'get', serviceId: 'web' },
                },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({
                ok: false,
                errorCode: 'local_services_plugin_bridge_forbidden',
            });
        } finally {
            await app.close();
        }

        expect(localServicesPluginBridge.dispatch).not.toHaveBeenCalled();
    });

    it('routes preview snapshots to the daemon-owned preview runtime', async () => {
        const snapshot: LocalServicePreviewSnapshotV1 = {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 3_000,
            refreshState: 'idle',
            resources: [{
                previewId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine-a',
                owner: { kind: 'plugin', id: 'plugin_1' },
                target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                initialPath: { pathname: '/', search: '' },
                display: { title: 'Plugin Preview', addressLabel: 'localhost:5173' },
                originMode: 'path',
                browserTarget: {
                    kind: 'localServicePreview',
                    targetId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine-a',
                },
            }],
            diagnostics: [],
        };
        const localServicesPreview: Pick<LocalServicePreviewRoutes, 'getSnapshot'> = {
            getSnapshot: vi.fn(async () => snapshot),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPreview,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/preview/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, snapshot });
        } finally {
            await app.close();
        }
    });

    it('routes public preview status to the daemon-owned public preview routes', async () => {
        const snapshot: LocalServicePublicPreviewSnapshotV1 = {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            previewId: 'preview-a',
            generatedAt: 3_000,
            refreshState: 'idle',
            policy: {
                enabled: true,
                allowedModes: ['secret_link'],
                maxTtlMs: 60_000,
                dnsTlsRequired: false,
                auditRequired: true,
                rateLimitProfileIds: [],
            },
            exposures: [],
            diagnostics: [],
        };
        const localServicesPublicPreview: LocalServicePublicPreviewRoutes = {
            getStatus: vi.fn(async () => snapshot),
            createExposure: vi.fn(),
            revokeExposure: vi.fn(),
            copyUrl: vi.fn(),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesPublicPreview,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/public-preview/status',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: {
                    machineId: 'machine-a',
                    sessionId: 'session-a',
                    previewId: 'preview-a',
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, snapshot });
            expect(localServicesPublicPreview.getStatus).toHaveBeenCalledWith({
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-a',
            });
        } finally {
            await app.close();
        }
    });

    it('routes launcher snapshots to the daemon-owned launcher feed', async () => {
        const snapshot: LocalServiceLauncherSnapshotV1 = {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            targets: [],
        };
        const localServicesLauncher: LocalServiceLauncherRoutes = {
            getSnapshot: vi.fn(async () => snapshot),
        };
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
            localServicesLauncher,
        });

        try {
            await app.ready();
            const response = await app.inject({
                method: 'POST',
                url: '/local-services/launcher/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, snapshot });
        } finally {
            await app.close();
        }
    });

    it('keeps local service launcher snapshots authenticated and explicit when runtime is unavailable', async () => {
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
                url: '/local-services/launcher/snapshot',
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/launcher/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });

    it('keeps local service preview snapshots authenticated and explicit when runtime is unavailable', async () => {
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
                url: '/local-services/preview/snapshot',
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/preview/snapshot',
                headers: { 'x-happier-daemon-token': 'test-token' },
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });

    it('keeps local service public preview status authenticated and explicit when runtime is unavailable', async () => {
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
                url: '/local-services/public-preview/status',
                payload: { machineId: 'machine-a' },
            })).statusCode).toBe(401);
            expect((await app.inject({
                method: 'POST',
                url: '/local-services/public-preview/status',
                headers: { 'x-happier-daemon-token': 'test-token' },
                payload: { machineId: 'machine-a' },
            })).statusCode).toBe(501);
        } finally {
            await app.close();
        }
    });
});
