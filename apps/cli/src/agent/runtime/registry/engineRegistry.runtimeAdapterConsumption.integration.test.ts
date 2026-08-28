import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import { resolveBackendEngineAdapterResolution } from './engineRegistry';

describe('current Agent engine resolution (integration)', () => {
    it('resolves a registered native Agent without requiring retired static surface handlers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-resolution-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-resolution-plugin-'));
        await materializeSamplePluginFixture(pluginRoot);
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: SAMPLE_PLUGIN_ID,
            sourceRootPath: pluginRoot,
            plugin: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        installedPath: null,
                    },
                    state: { enabled: true },
            },
        });
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            generation: 1,
        });
        const qualifiedBackendId = buildQualifiedPluginContributionKey({
            pluginId: SAMPLE_PLUGIN_ID,
            localId: SAMPLE_PLUGIN_BACKEND_ID,
        });
        const qualifiedAgentId = buildQualifiedPluginContributionKey({
            pluginId: SAMPLE_PLUGIN_ID,
            localId: SAMPLE_PLUGIN_PROVIDER_ID,
        });

        const resolution = await resolveBackendEngineAdapterResolution(qualifiedBackendId, {
            runtimeRegistry,
        });

        expect(resolution).toMatchObject({
            backendId: qualifiedBackendId,
            agentId: qualifiedAgentId,
            provenance: 'external',
            selectedSource: 'plugin',
            backend: { id: qualifiedBackendId, pluginId: SAMPLE_PLUGIN_ID },
            agent: { id: qualifiedAgentId, pluginId: SAMPLE_PLUGIN_ID },
            diagnostics: [],
            executionSurfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
            },
            engineAdapter: {
                runtimeCore: {
                    createSessionRuntime: expect.any(Function),
                },
            },
        });
        expect(resolution).not.toHaveProperty('source');
        await runtimeRegistry.dispose();
    });

    it('does not misdiagnose a built-in registered Agent as missing a runtime surface owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-resolution-built-in-home-'));
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            generation: 1,
        });
        const resolution = await resolveBackendEngineAdapterResolution('codex', { runtimeRegistry });

        expect(resolution).toMatchObject({
            backendId: 'codex',
            agentId: 'codex',
            provenance: 'first_party',
            backend: { id: 'codex' },
            agent: { id: 'codex' },
            executionSurfaces: { terminalRuntime: expect.anything() },
            engineAdapter: {
                runtimeCore: {
                    createSessionRuntime: expect.any(Function),
                },
            },
        });
        expect(resolution?.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'engine_plugin_backend_surface_missing' }),
        ]));
        expect(['system', 'managed', 'plugin']).toContain(resolution?.selectedSource);
        await runtimeRegistry.dispose();
    });
});
