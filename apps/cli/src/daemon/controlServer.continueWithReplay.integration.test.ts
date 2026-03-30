import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { reloadConfiguration } from '@/configuration';
import { writeCredentialsLegacy } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('daemon control server: /continue-with-replay (integration)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates a replay-seeded session and spawns it via existingSessionId', async () => {
        const api = fastify({ logger: false });
        const token = 'test-token';
        const previousSessionId = 'sess-prev-1';
        const createdSessionId = 'sess-replay-child-1';

        const now = Date.now();
        const baseSession = (id: string) => ({
            id,
            seq: 1,
            createdAt: now,
            updatedAt: now,
            active: false,
            activeAt: 0,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ tag: id, path: '/tmp/project-a', flavor: 'claude' }),
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            dataEncryptionKey: null,
        });

        api.get('/v1/features', async () => {
            return {
                features: {},
                capabilities: {
                    encryption: {
                        storagePolicy: 'plaintext_only',
                        allowAccountOptOut: false,
                        defaultAccountMode: 'plain',
                        plainAccountSettingsAtRest: 'server_sealed',
                        plainAccountCredentialsAtRest: 'server_sealed',
                    },
                },
            };
        });

        api.get('/v2/sessions/:id', async (req, reply) => {
            const id = String((req.params as any).id);
            if (id !== previousSessionId && id !== createdSessionId) {
                reply.code(404);
                return { error: 'Session not found' };
            }
            return { session: baseSession(id) };
        });

        api.get('/v1/sessions/:id/messages', async (req) => {
            const id = String((req.params as any).id);
            if (id !== previousSessionId) {
                return { messages: [] };
            }
            return {
                messages: [
                    {
                        seq: 1,
                        createdAt: now,
                        content: {
                            t: 'plain',
                            v: {
                                role: 'user',
                                content: { type: 'text', text: 'Hello from the previous session.' },
                                meta: {},
                            },
                        },
                    },
                ],
            };
        });

        api.post('/v1/sessions', async (req) => {
            const body = (req.body ?? {}) as any;
            return {
                session: {
                    ...baseSession(createdSessionId),
                    metadata: typeof body.metadata === 'string' ? body.metadata : baseSession(createdSessionId).metadata,
                },
            };
        });

        const address = await api.listen({ host: '127.0.0.1', port: 0 });
        const serverUrl = address.replace(/\/+$/, '');

        const envScope = createEnvKeyScope([
            'HAPPIER_HOME_DIR',
            'HAPPIER_SERVER_URL',
            'HAPPIER_LOCAL_SERVER_URL',
            'HAPPIER_PUBLIC_SERVER_URL',
        ]);
        const homeDir = await createTempDir('happier-cli-daemon-control-replay-integration-');
        envScope.patch({
            HAPPIER_HOME_DIR: homeDir,
            HAPPIER_SERVER_URL: serverUrl,
            HAPPIER_LOCAL_SERVER_URL: serverUrl,
            HAPPIER_PUBLIC_SERVER_URL: '',
        });
        reloadConfiguration();

        await writeCredentialsLegacy({
            token,
            secret: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
        });

        const { createDaemonControlApp } = await import('./controlServer');

        let observedSpawn: SpawnSessionOptions | null = null;
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine_local',
            stopSession: async () => false,
            spawnSession: async (options) => {
                observedSpawn = options;
                return { type: 'success', sessionId: createdSessionId };
            },
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            controlToken: 'test-token',
        });

        try {
            await app.ready();
            const res = await app.inject({
                method: 'POST',
                url: '/continue-with-replay',
                headers: {
                    'Content-Type': 'application/json',
                    'x-happier-daemon-token': 'test-token',
                },
                payload: JSON.stringify({
                    directory: '/tmp/project-a',
                    agent: 'claude',
                    replay: {
                        previousSessionId,
                        strategy: 'recent_messages',
                        recentMessagesCount: 1,
                        maxSeedChars: 2000,
                    },
                }),
            });

            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({
                success: true,
                sessionId: createdSessionId,
                approvedNewDirectoryCreation: true,
            });

            expect(observedSpawn).toMatchObject({
                directory: '/tmp/project-a',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                existingSessionId: createdSessionId,
            });
        } finally {
            await app.close();
            await api.close();
            envScope.restore();
            await removeTempDir(homeDir);
        }
    });
});
