import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    materializeSamplePluginFixture,
} from '@/extensions/plugins/testkit/samplePluginFixture';

import { resolveBackendExecutionSurfaces } from './catalog';

describe('resolveBackendExecutionSurfaces', () => {
    it('maps plugin backend runtime-adapter descriptors into executable backend catalog surfaces', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-plugin-'));
        const store = createPluginStateStore({ happyHomeDir });

        await materializeSamplePluginFixture(pluginRoot);
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                [SAMPLE_PLUGIN_ID]: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const surfaces = await resolveBackendExecutionSurfaces(SAMPLE_PLUGIN_BACKEND_ID, { happyHomeDir });

        expect(surfaces).toMatchObject({
            terminalRuntime: {
                launch: expect.any(Function),
                discoverIdentity: expect.any(Function),
            },
            directSessions: {
                validateSource: expect.any(Function),
                listCandidates: expect.any(Function),
                getActivity: expect.any(Function),
                pageTranscript: expect.any(Function),
                readAfterTranscript: expect.any(Function),
                resolveTakeoverSpawnOptions: expect.any(Function),
            },
            attach: {
                evaluateEligibility: expect.any(Function),
                probeReachability: expect.any(Function),
                runAttach: expect.any(Function),
            },
            sessionHandoff: {
                exportBundle: expect.any(Function),
                importBundle: expect.any(Function),
            },
        });

        await expect(surfaces?.terminalRuntime?.launch?.({} as never)).resolves.toBe('integration-launch');
        await expect(surfaces?.terminalRuntime?.discoverIdentity?.({} as never)).resolves.toEqual({
            backendId: SAMPLE_PLUGIN_BACKEND_ID,
            identity: 'integration-identity',
        });
        await expect(
            surfaces?.directSessions?.validateSource?.({ source: 'codex', env: {} as NodeJS.ProcessEnv } as never),
        ).resolves.toEqual({ ok: true, source: 'codex' });
        await expect(
            surfaces?.directSessions?.listCandidates?.({ source: 'codex', limit: 1 } as never),
        ).resolves.toEqual({ candidates: [], nextCursor: null });
        await expect(
            surfaces?.directSessions?.getActivity?.({ source: 'codex', remoteSessionId: 'remote-1' } as never),
        ).resolves.toEqual({ lastActivityAtMs: null, isRunning: false });
        await expect(
            surfaces?.directSessions?.pageTranscript?.({
                source: 'codex',
                remoteSessionId: 'remote-1',
                direction: 'older',
                maxBytes: 1024,
                maxItems: 10,
            } as never),
        ).resolves.toEqual({
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
        });
        await expect(
            surfaces?.directSessions?.readAfterTranscript?.({
                source: 'codex',
                remoteSessionId: 'remote-1',
                cursor: 'cursor-1',
                maxBytes: 1024,
                maxItems: 10,
            } as never),
        ).resolves.toEqual({ items: [], nextCursor: null, truncated: false });
        await expect(
            surfaces?.directSessions?.resolveTakeoverSpawnOptions?.({
                linked: { providerId: 'codex' } as never,
                sessionId: 'session-1',
            } as never),
        ).resolves.toBeNull();
        await expect(
            surfaces?.attach?.evaluateEligibility?.({
                metadata: {},
                currentMachineId: 'machine-a',
                sessionMachineId: 'machine-a',
                hasLocalAttachmentInfo: true,
            } as never),
        ).resolves.toEqual({
            eligible: true,
            scope: 'local',
            metadata: { source: 'integration' },
        });
        await expect(
            surfaces?.attach?.probeReachability?.({ metadata: {} } as never),
        ).resolves.toEqual({ reachable: true });
        await expect(
            surfaces?.attach?.runAttach?.({
                sessionId: 'session-1',
                metadata: {},
            } as never),
        ).resolves.toBe(0);
        await expect(
            surfaces?.sessionHandoff?.exportBundle?.({
                metadata: {},
                remoteSessionId: 'remote-1',
                activeServerDir: '/tmp/integration',
            } as never),
        ).resolves.toEqual({
            providerId: 'codex',
            remoteSessionId: 'remote-1',
            files: [],
        });
        await expect(
            surfaces?.sessionHandoff?.importBundle?.({
                bundle: {
                    providerId: 'codex',
                    remoteSessionId: 'remote-1',
                    files: [],
                },
                targetPath: '/tmp/integration-target',
                sessionStorageMode: 'direct',
            } as never),
        ).resolves.toEqual({
            remoteSessionId: 'remote-1',
            directSource: 'codex',
            resume: {
                directory: '/tmp/integration',
                agent: 'codex',
                resume: 'resume-1',
                transcriptStorage: 'direct',
                approvedNewDirectoryCreation: true,
            },
        });
    });

    it('fails closed when plugin-target runtime adapters are present on a backend', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-plugin-'));
        const store = createPluginStateStore({ happyHomeDir });

        await materializeSamplePluginFixture(pluginRoot);
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            contributions?: {
                backends?: Array<{
                    runtimeAdapters?: Array<{
                        id?: string;
                        handler?: { target?: string };
                    }>;
                }>;
            };
        };
        for (const backend of manifest.contributions?.backends ?? []) {
            for (const runtimeAdapter of backend.runtimeAdapters ?? []) {
                if (runtimeAdapter.id?.startsWith('backend.attach.')) {
                    runtimeAdapter.handler = {
                        ...runtimeAdapter.handler,
                        target: 'plugin',
                    };
                }
            }
        }
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                [SAMPLE_PLUGIN_ID]: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath,
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const surfaces = await resolveBackendExecutionSurfaces(SAMPLE_PLUGIN_BACKEND_ID, { happyHomeDir });
        expect(surfaces).toEqual({
            terminalRuntime: null,
            directSessions: null,
            attach: null,
            sessionHandoff: null,
        });
    });
});
