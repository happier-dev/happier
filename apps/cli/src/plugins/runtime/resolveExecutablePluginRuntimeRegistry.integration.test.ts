import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('resolveExecutablePluginRuntimeRegistry (integration)', () => {
    it('loads provider/backend contributes and executable hook handlers from one local-path plugin state entry', async () => {
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

        expect(runtimeRegistry.contributes.providerDefinitionsById.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                id: SAMPLE_PLUGIN_PROVIDER_ID,
            },
        });
        expect(runtimeRegistry.contributes.backendDefinitionsById.get(SAMPLE_PLUGIN_BACKEND_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_BACKEND_ID,
            providerId: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            source: { kind: 'path' },
            runtimeKind: 'custom',
            capabilities: {},
        });
        expect(runtimeRegistry.contributes.surfaceHandlersByBackendId.get(SAMPLE_PLUGIN_BACKEND_ID)).toEqual(
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
                        id: 'backend.resolveRuntimePrerequisites',
                        kind: 'terminalRuntime',
                    }),
                }),
            ]),
        );
        expect(runtimeRegistry.contributes.catalogEntriesById[SAMPLE_PLUGIN_PROVIDER_ID]).toBeUndefined();

        expect(typeof runtimeRegistry.readHookEventEnvelopeV1).toBe('function');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 1,
            hookEventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })?.eventId).toBe('session.message.send');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 2,
            eventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })).toBe(null);

        const handlers = runtimeRegistry.hookHandlersByHookId.get('backend.resolveRuntimePrerequisites');
        expect(handlers).toHaveLength(1);
        await expect(handlers?.[0]?.handler()).resolves.toBe('integration-bound');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual([]);
    });

    it('requires explicit approval before loading executable hook handlers for prompt-trust plugins', async () => {
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
                        kind: 'archive',
                        locator: 'https://example.com/acme-sample.tar.gz',
                        trustPolicy: 'prompt',
                        installPolicy: 'managed_install',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'managed_install',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: pluginRoot,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.hookHandlersByHookId.get('backend.resolveRuntimePrerequisites')).toBeUndefined();
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'plugin_trust_approval_required',
                    message: expect.stringMatching(/approval/i),
                }),
            ]),
        );
    });
});
