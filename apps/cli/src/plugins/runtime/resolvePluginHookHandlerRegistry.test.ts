import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedContributionRegistry, ResolvedHookRegistration } from '@/plugins/projection/registry/types';

import { describe, expect, it } from 'vitest';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolvePluginHookHandlerRegistry } from './resolvePluginHookHandlerRegistry';

async function writeDaemonModule(params: Readonly<{ basename: string; contents: string }>): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-runtime-'));
    const daemonEntryPath = join(rootDir, params.basename);
    await writeFile(daemonEntryPath, params.contents, 'utf8');
    return daemonEntryPath;
}

function createHookRegistration(
    params: Readonly<{
        pluginId: string;
        daemonEntryPath: string;
        exportName: string;
        priority?: number;
    }>,
): ResolvedHookRegistration {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: params.pluginId,
        manifestPath: `/plugins/${params.pluginId}/.happier-plugin/plugin.json`,
        manifestDigest: `sha256:${params.pluginId}`,
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${params.pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            hookApiVersion: 1,
            id: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            handler: {
                target: 'plugin' as const,
                exportName: params.exportName,
            },
        },
    };
}

function createRegistry(hookRegistrations: readonly ResolvedHookRegistration[]): ResolvedContributionRegistry {
    return {
        agents: Object.freeze([]),
        agentRuntimes: Object.freeze([]),
        actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiDescriptors: Object.freeze([]),
        activationTargets: Object.freeze([]),
        hookRegistrations: Object.freeze([...hookRegistrations]),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('resolvePluginHookHandlerRegistry', () => {
    it('loads plugin hook exports and orders handlers deterministically by ascending priority', async () => {
        const highPriorityPath = await writeDaemonModule({
            basename: 'daemon-high.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "high"; }\n',
        });
        const lowPriorityPath = await writeDaemonModule({
            basename: 'daemon-low.cjs',
            contents: 'module.exports = { resolveTranscriptBinding: async () => "low" };\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.low',
                    daemonEntryPath: lowPriorityPath,
                    exportName: 'resolveTranscriptBinding',
                    priority: 10,
                }),
                createHookRegistration({
                    pluginId: 'acme.high',
                    daemonEntryPath: highPriorityPath,
                    exportName: 'resolveTranscriptBinding',
                    priority: 50,
                }),
            ]),
        });

        const handlers = result.handlersByHookId.get('agent.resolvePrerequisites');
        expect(handlers?.map((handler) => handler.pluginId)).toEqual(['acme.low', 'acme.high']);
        await expect(handlers?.[0]?.handler()).resolves.toBe('low');
        await expect(handlers?.[1]?.handler()).resolves.toBe('high');
        expect(result.diagnosticsByPluginId['acme.high']).toEqual([]);
        expect(result.diagnosticsByPluginId['acme.low']).toEqual([]);
    });

    it('preserves same-plugin registration order for equal-priority hook handlers', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-same-plugin.mjs',
            contents: [
                'export async function zetaHandler() { return "first"; }',
                'export async function alphaHandler() { return "second"; }',
            ].join('\n'),
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.same',
                    daemonEntryPath,
                    exportName: 'zetaHandler',
                    priority: 10,
                }),
                createHookRegistration({
                    pluginId: 'acme.same',
                    daemonEntryPath,
                    exportName: 'alphaHandler',
                    priority: 10,
                }),
            ]),
        });

        const handlers = result.handlersByHookId.get('agent.resolvePrerequisites');

        expect(handlers?.map((handler) => handler.exportName)).toEqual(['zetaHandler', 'alphaHandler']);
        await expect(handlers?.[0]?.handler()).resolves.toBe('first');
        await expect(handlers?.[1]?.handler()).resolves.toBe('second');
    });

    it('supports bundled activation sources without requiring a file-backed daemon entry path', async () => {
        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.bundled',
                    // Intentionally not a real file path.
                    daemonEntryPath: '/missing/daemon.mjs',
                    exportName: 'resolveTranscriptBinding',
                    priority: 10,
                }),
            ]),
            resolveActivationSource(registration) {
                if (registration.pluginId !== 'acme.bundled') {
                    return null;
                }
                return {
                    kind: 'bundled',
                    moduleId: '@happier-dev/plugins-acme-bundled/daemon',
                    load: async () => ({
                        resolveTranscriptBinding: async () => 'bundled',
                    }),
                };
            },
        });

        const handlers = result.handlersByHookId.get('agent.resolvePrerequisites');
        expect(handlers?.map((handler) => handler.pluginId)).toEqual(['acme.bundled']);
        await expect(handlers?.[0]?.handler()).resolves.toBe('bundled');
        expect(result.diagnosticsByPluginId['acme.bundled']).toEqual([]);
    });

    it('filters hook registrations by targeted plugin id before loading daemon modules', async () => {
        const targetEntryPath = await writeDaemonModule({
            basename: 'daemon-target.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "target"; }\n',
        });
        const unrelatedEntryPath = await writeDaemonModule({
            basename: 'daemon-unrelated.mjs',
            contents: 'throw new Error("unrelated hook module must not be imported");\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.target',
                    daemonEntryPath: targetEntryPath,
                    exportName: 'resolveTranscriptBinding',
                }),
                createHookRegistration({
                    pluginId: 'acme.unrelated',
                    daemonEntryPath: unrelatedEntryPath,
                    exportName: 'resolveTranscriptBinding',
                }),
            ]),
            pluginIds: ['acme.target'],
        });

        const handlers = result.handlersByHookId.get('agent.resolvePrerequisites');
        expect(handlers?.map((handler) => handler.pluginId)).toEqual(['acme.target']);
        await expect(handlers?.[0]?.handler()).resolves.toBe('target');
        expect(result.diagnosticsByPluginId['acme.target']).toEqual([]);
        expect(result.diagnosticsByPluginId['acme.unrelated']).toBeUndefined();
    });

    it('records a diagnostic and excludes plugin hooks whose export is missing', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-missing.mjs',
            contents: 'export async function otherHook() { return "nope"; }\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.missing',
                    daemonEntryPath,
                    exportName: 'resolveTranscriptBinding',
                }),
            ]),
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.missing']).toEqual([
            expect.objectContaining({
                code: 'plugin_hook_handler_missing',
            }),
        ]);
    });

    it('records a diagnostic and excludes hook registrations outside the final catalog', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-stale-hook.mjs',
            contents: 'export async function staleHook() { return "nope"; }\n',
        });
        const staleRegistration = createHookRegistration({
            pluginId: 'acme.stale-hook',
            daemonEntryPath,
            exportName: 'staleHook',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                {
                    ...staleRegistration,
                    definition: {
                        ...staleRegistration.definition,
                        id: 'provider.request.before',
                    },
                },
            ]),
        });

        expect(result.handlersByHookId.get('provider.request.before')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.stale-hook']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });

    it('records a diagnostic and excludes plugin hooks whose export is not a function', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-invalid.mjs',
            contents: 'export const resolveTranscriptBinding = 42;\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.invalid',
                    daemonEntryPath,
                    exportName: 'resolveTranscriptBinding',
                }),
            ]),
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.invalid']).toEqual([
            expect.objectContaining({
                code: 'plugin_hook_handler_invalid',
            }),
        ]);
    });

    it('returns only hook-resolution diagnostics instead of echoing contribution diagnostics', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-valid.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "ok"; }\n',
        });
        const preexistingDiagnostics = Object.freeze([
            {
                code: 'plugin_manifest_semantic_invalid',
                message: 'Pre-existing contribution diagnostic',
            },
        ]) satisfies readonly PluginCompatibilityDiagnostic[];

        const result = await resolvePluginHookHandlerRegistry({
            registry: {
                ...createRegistry([
                    createHookRegistration({
                        pluginId: 'acme.preexisting',
                        daemonEntryPath,
                        exportName: 'resolveTranscriptBinding',
                    }),
                ]),
                pluginDiagnosticsByPluginId: Object.freeze({
                    'acme.preexisting': preexistingDiagnostics,
                }),
            },
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toHaveLength(1);
        expect(result.diagnosticsByPluginId['acme.preexisting']).toEqual([]);
    });

    it('fails closed when a hook registration declares an unsupported handler target', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-target.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "noop"; }\n',
        });
        const unsupportedRegistration = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.daemon-target',
            manifestPath: '/plugins/acme.daemon-target/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:acme.daemon-target',
            daemonEntryPath,
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/acme.daemon-target',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
            definition: {
                hookApiVersion: 1,
                id: 'agent.resolvePrerequisites',
                category: 'integration',
                scope: 'agent',
                executionKind: 'integrate',
                handler: {
                    target: 'daemon' as const,
                    exportName: 'resolveTranscriptBinding',
                },
            },
        } as unknown as ResolvedHookRegistration;

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([unsupportedRegistration]),
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.daemon-target']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });

    it('requires explicit approval before loading prompt-trust plugin hook handlers', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-prompt.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "noop"; }\n',
        });
        const registration = createHookRegistration({
            pluginId: 'acme.prompt',
            daemonEntryPath,
            exportName: 'resolveTranscriptBinding',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                {
                    ...registration,
                    sourceSpec: {
                        ...registration.sourceSpec,
                        kind: 'archive',
                        locator: 'https://example.com/acme.prompt.tar.gz',
                        trustPolicy: 'prompt',
                        installPolicy: 'managed_install',
                    },
                },
            ]),
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.prompt']).toEqual([
            expect.objectContaining({
                code: 'plugin_trust_approval_required',
                message: expect.stringMatching(/approval/i),
            }),
        ]);
    });

    it('fails closed for untrusted plugin hook handlers before daemon import', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-untrusted.mjs',
            contents: 'export async function resolveTranscriptBinding() { return "noop"; }\n',
        });
        const registration = createHookRegistration({
            pluginId: 'acme.untrusted',
            daemonEntryPath,
            exportName: 'resolveTranscriptBinding',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                {
                    ...registration,
                    sourceSpec: {
                        ...registration.sourceSpec,
                        kind: 'archive',
                        locator: 'https://example.com/acme.untrusted.tar.gz',
                        trustPolicy: 'untrusted',
                        installPolicy: 'managed_install',
                    },
                },
            ]),
        });

        expect(result.handlersByHookId.get('agent.resolvePrerequisites')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.untrusted']).toEqual([
            expect.objectContaining({
                code: 'plugin_untrusted',
                message: expect.stringMatching(/untrusted/i),
            }),
        ]);
    });
});
