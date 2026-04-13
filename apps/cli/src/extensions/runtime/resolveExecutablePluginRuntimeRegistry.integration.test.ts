import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/extensions/plugins/testkit/samplePluginFixture';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('resolveExecutablePluginRuntimeRegistry (integration)', () => {
    it('loads provider/backend contributions and executable hook handlers from one local-path plugin state entry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await materializeSamplePluginFixture(pluginRoot);
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.sample': {
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

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.contributions.providerDefinitionsById.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_PROVIDER_ID,
            source: 'plugin',
            definition: {
                id: SAMPLE_PLUGIN_PROVIDER_ID,
            },
        });
        expect(runtimeRegistry.contributions.backendDefinitionsById.get(SAMPLE_PLUGIN_BACKEND_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_BACKEND_ID,
            providerId: SAMPLE_PLUGIN_PROVIDER_ID,
            source: 'plugin',
            definition: {
                id: SAMPLE_PLUGIN_BACKEND_ID,
            },
        });
        expect(runtimeRegistry.contributions.runtimeAdaptersByBackendId.get(SAMPLE_PLUGIN_BACKEND_ID)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    backendId: SAMPLE_PLUGIN_BACKEND_ID,
                    definition: expect.objectContaining({
                        id: 'backend.terminalRuntime.launch',
                        kind: 'terminalRuntime',
                    }),
                }),
                expect.objectContaining({
                    backendId: SAMPLE_PLUGIN_BACKEND_ID,
                    definition: expect.objectContaining({
                        id: 'backend.terminalRuntime.bindTranscript',
                        kind: 'terminalRuntime',
                    }),
                }),
            ]),
        );
        expect(runtimeRegistry.contributions.catalogEntriesById[SAMPLE_PLUGIN_PROVIDER_ID]).toBeUndefined();

        expect(typeof runtimeRegistry.readHookEventEnvelopeV1).toBe('function');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 1,
            hookEventId: 'session.started',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })?.eventId).toBe('session.started');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 2,
            eventId: 'session.started',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })).toBe(null);

        const handlers = runtimeRegistry.hookHandlersByHookId.get('backend.terminalRuntime.bindTranscript');
        expect(handlers).toHaveLength(1);
        await expect(handlers?.[0]?.handler()).resolves.toBe('integration-bound');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual([]);
    });
});
