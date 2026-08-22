import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
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
        await createPluginStateStore({ happyHomeDir }).write({
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
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        installedPath: null,
                    },
                    state: { enabled: true },
                },
            },
        });

        const resolution = await resolveBackendEngineAdapterResolution(SAMPLE_PLUGIN_BACKEND_ID, { happyHomeDir });

        expect(resolution).toMatchObject({
            backendId: SAMPLE_PLUGIN_BACKEND_ID,
            agentId: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            selectedSource: 'plugin',
            backend: { id: SAMPLE_PLUGIN_BACKEND_ID, pluginId: SAMPLE_PLUGIN_ID },
            agent: { id: SAMPLE_PLUGIN_PROVIDER_ID, pluginId: SAMPLE_PLUGIN_ID },
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
    });

    it('does not misdiagnose a built-in registered Agent as missing a runtime surface owner', async () => {
        const resolution = await resolveBackendEngineAdapterResolution('codex');

        expect(resolution).toMatchObject({
            backendId: 'codex',
            agentId: 'codex',
            provenance: 'first_party',
            backend: { id: 'codex' },
            agent: { id: 'codex' },
            executionSurfaces: { terminalRuntime: expect.anything() },
        });
        expect(resolution?.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'engine_plugin_backend_surface_missing' }),
        ]));
        expect(['system', 'managed', 'plugin']).toContain(resolution?.selectedSource);
    });
});
