import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';
import {
    resolveBackendEngineAdapterResolution,
    resolveBackendExecutionSurfaces,
} from './engineRegistry';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewriteBackendSurfaceHandlersToPluginTargets(manifest: unknown): unknown {
    if (!isRecord(manifest) || !isRecord(manifest.contributes) || !Array.isArray(manifest.contributes.agentRuntimes)) {
        return manifest;
    }

    return {
        ...manifest,
        contributes: {
            ...manifest.contributes,
            hooks: [],
            agentRuntimes: manifest.contributes.agentRuntimes.map((contribution) => {
                if (
                    !isRecord(contribution)
                    || !Array.isArray(contribution.surfaceHandlers)
                ) {
                    return contribution;
                }

                return {
                    ...contribution,
                    surfaceHandlers: contribution.surfaceHandlers.map((surfaceHandler) => {
                        if (
                            !isRecord(surfaceHandler)
                            || !isRecord(surfaceHandler.handler)
                        ) {
                            return surfaceHandler;
                        }

                        return {
                            ...surfaceHandler,
                            handler: {
                                ...surfaceHandler.handler,
                                target: 'plugin',
                            },
                        };
                    }),
                };
            }),
        },
    };
}

describe('resolveBackendExecutionSurfaces', () => {
    it('maps plugin backend surface handler descriptors into executable backend catalog surfaces', async () => {
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
                resolveTranscriptBinding: expect.any(Function),
            },
            externalSession: {
                validateSource: expect.any(Function),
                listCandidates: expect.any(Function),
                getActivity: expect.any(Function),
                pageTranscript: expect.any(Function),
                readAfterTranscript: expect.any(Function),
                resolveTakeoverSpawnOptions: expect.any(Function),
            },
            attach: {
                evaluateAvailability: expect.any(Function),
                attach: expect.any(Function),
            },
            handoff: {
                exportBundle: expect.any(Function),
                importBundle: expect.any(Function),
            },
        });

        await expect(surfaces?.terminalRuntime?.launch?.({} as never)).resolves.toMatchObject({
            sessionId: 'integration-session',
            runtimeDescriptor: {
                backendId: SAMPLE_PLUGIN_BACKEND_ID,
                runtimeKind: 'native',
                source: 'plugin',
            },
            runtimeCapabilities: {
                executionRun: { supported: true },
                sessions: { supported: true },
            },
            runtime: expect.objectContaining({
                beginTurnLifecycle: expect.any(Function),
                startOrLoadSession: expect.any(Function),
                sendTurnPrompt: expect.any(Function),
                steerInFlightTurn: expect.any(Function),
                waitForTurnCompletion: expect.any(Function),
                subscribeRuntimeEvents: expect.any(Function),
                respondToPermission: expect.any(Function),
                cancelTurn: expect.any(Function),
                readSessionIdentity: expect.any(Function),
                updateSessionRuntimeConfig: expect.any(Function),
                resetOrDisposeRuntime: expect.any(Function),
            }),
        });
        await expect(surfaces?.terminalRuntime?.discoverIdentity?.({} as never)).resolves.toEqual({
            backendId: SAMPLE_PLUGIN_BACKEND_ID,
            identity: 'integration-identity',
        });
        await expect(
            surfaces?.externalSession?.validateSource?.({ source: 'codex', env: {} as NodeJS.ProcessEnv } as never),
        ).resolves.toEqual({ ok: true, source: 'codex' });
        await expect(
            surfaces?.externalSession?.listCandidates?.({ source: 'codex', limit: 1 } as never),
        ).resolves.toEqual({ candidates: [], nextCursor: null });
        await expect(
            surfaces?.externalSession?.getActivity?.({ source: 'codex', remoteSessionId: 'remote-1' } as never),
        ).resolves.toEqual({ lastActivityAtMs: null, isRunning: false });
        await expect(
            surfaces?.externalSession?.pageTranscript?.({
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
            surfaces?.externalSession?.readAfterTranscript?.({
                source: 'codex',
                remoteSessionId: 'remote-1',
                cursor: 'cursor-1',
                maxBytes: 1024,
                maxItems: 10,
            } as never),
        ).resolves.toEqual({ items: [], nextCursor: null, truncated: false });
        await expect(
            surfaces?.externalSession?.resolveTakeoverSpawnOptions?.({
                linked: { agentId: 'codex' } as never,
                sessionId: 'session-1',
            } as never),
        ).resolves.toBeNull();
        await expect(
            surfaces?.attach?.evaluateAvailability?.({
                metadata: {},
                currentMachineId: 'machine-a',
                sessionMachineId: 'machine-a',
                hasLocalAttachmentInfo: true,
            } as never),
        ).resolves.toEqual({
            eligible: true,
            scope: 'local',
            metadata: {},
        });
        await expect(
            surfaces?.attach?.attach?.({
                sessionId: 'session-1',
                metadata: {},
            } as never),
        ).resolves.toBe(0);
        await expect(
            surfaces?.handoff?.exportBundle?.({
                metadata: {},
                remoteSessionId: 'remote-1',
                activeServerDir: '/tmp/integration',
            } as never),
        ).resolves.toEqual({
            agentId: 'codex',
            remoteSessionId: 'remote-1',
            files: [],
        });
        await expect(
            surfaces?.handoff?.importBundle?.({
                bundle: {
                    agentId: 'codex',
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

    it('fails closed when backend surface handlers target plugin activation', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-backend-runtime-adapters-plugin-'));
        const store = createPluginStateStore({ happyHomeDir });

        await materializeSamplePluginFixture(pluginRoot);
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        const manifest = rewriteBackendSurfaceHandlersToPluginTargets(
            JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
        );
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
            externalSession: null,
            attach: null,
            handoff: null,
            fork: null,
            checkpoint: null,
        });
    });

    it('resolves one canonical engine-adapter record with plugin provenance, selected source facts, and executable surfaces', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-resolution-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-resolution-plugin-'));
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

        const resolution = await resolveBackendEngineAdapterResolution(SAMPLE_PLUGIN_BACKEND_ID, { happyHomeDir });
        expect(resolution).toMatchObject({
            backendId: SAMPLE_PLUGIN_BACKEND_ID,
            agentId: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            selectedSource: 'plugin',
            backend: {
                id: SAMPLE_PLUGIN_BACKEND_ID,
                pluginId: SAMPLE_PLUGIN_ID,
            },
            provider: {
                id: SAMPLE_PLUGIN_PROVIDER_ID,
                pluginId: SAMPLE_PLUGIN_ID,
            },
            diagnostics: [],
            executionSurfaces: {
                terminalRuntime: {
                    launch: expect.any(Function),
                    discoverIdentity: expect.any(Function),
                    resolveTranscriptBinding: expect.any(Function),
                },
                externalSession: {
                    validateSource: expect.any(Function),
                },
                attach: {
                    evaluateAvailability: expect.any(Function),
                    attach: expect.any(Function),
                },
                handoff: {
                    exportBundle: expect.any(Function),
                    importBundle: expect.any(Function),
                },
            },
        });
        expect(resolution).not.toHaveProperty('source');
    });

    it('resolves built-in backends through the canonical engine-adapter record', async () => {
        const resolution = await resolveBackendEngineAdapterResolution('codex');

        expect(resolution).toMatchObject({
            backendId: 'codex',
            agentId: 'codex',
            provenance: 'first_party',
            backend: {
                id: 'codex',
            },
            provider: {
                id: 'codex',
            },
            executionSurfaces: {
                terminalRuntime: expect.anything(),
            },
            diagnostics: [],
        });
        expect(['system', 'managed', 'plugin']).toContain(resolution?.selectedSource);
    });
});
