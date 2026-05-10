import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import {
    resolveBackendEngineAdapterResolution,
} from './catalog';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rewriteBackendAttachRuntimeAdaptersToPluginTargets(manifest: unknown): unknown {
    if (!isRecord(manifest) || !Array.isArray(manifest.contributions)) {
        return manifest;
    }

    return {
        ...manifest,
        contributions: manifest.contributions.map((contribution) => {
            if (
                !isRecord(contribution)
                || contribution.kind !== 'backend'
                || !Array.isArray(contribution.runtimeAdapters)
            ) {
                return contribution;
            }

            return {
                ...contribution,
                runtimeAdapters: contribution.runtimeAdapters.map((runtimeAdapter) => {
                    if (
                        !isRecord(runtimeAdapter)
                        || typeof runtimeAdapter.id !== 'string'
                        || !runtimeAdapter.id.startsWith('backend.attach.')
                    ) {
                        return runtimeAdapter;
                    }

                    const handler = isRecord(runtimeAdapter.handler) ? runtimeAdapter.handler : {};
                    return {
                        ...runtimeAdapter,
                        handler: {
                            ...handler,
                            target: 'plugin',
                        },
                    };
                }),
            };
        }),
    };
}

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
            externalSessions: {
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
                subscribeRuntimeMessages: expect.any(Function),
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
            surfaces?.externalSessions?.validateSource?.({ source: 'codex', env: {} as NodeJS.ProcessEnv } as never),
        ).resolves.toEqual({ ok: true, source: 'codex' });
        await expect(
            surfaces?.externalSessions?.listCandidates?.({ source: 'codex', limit: 1 } as never),
        ).resolves.toEqual({ candidates: [], nextCursor: null });
        await expect(
            surfaces?.externalSessions?.getActivity?.({ source: 'codex', remoteSessionId: 'remote-1' } as never),
        ).resolves.toEqual({ lastActivityAtMs: null, isRunning: false });
        await expect(
            surfaces?.externalSessions?.pageTranscript?.({
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
            surfaces?.externalSessions?.readAfterTranscript?.({
                source: 'codex',
                remoteSessionId: 'remote-1',
                cursor: 'cursor-1',
                maxBytes: 1024,
                maxItems: 10,
            } as never),
        ).resolves.toEqual({ items: [], nextCursor: null, truncated: false });
        await expect(
            surfaces?.externalSessions?.resolveTakeoverSpawnOptions?.({
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
        const manifest = rewriteBackendAttachRuntimeAdaptersToPluginTargets(
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
            externalSessions: null,
            attach: null,
            sessionHandoff: null,
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
            providerId: SAMPLE_PLUGIN_PROVIDER_ID,
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
            diagnostics: expect.arrayContaining([
                expect.objectContaining({
                    code: 'engine_plugin_runtime_adapter_handler_missing',
                }),
            ]),
            executionSurfaces: {
                terminalRuntime: {
                    launch: expect.any(Function),
                    discoverIdentity: expect.any(Function),
                },
                externalSessions: {
                    validateSource: expect.any(Function),
                },
                attach: {
                    evaluateEligibility: expect.any(Function),
                    runAttach: expect.any(Function),
                },
                sessionHandoff: {
                    exportBundle: expect.any(Function),
                    importBundle: expect.any(Function),
                },
            },
        });
        expect(resolution).not.toHaveProperty('source');
    });
});
