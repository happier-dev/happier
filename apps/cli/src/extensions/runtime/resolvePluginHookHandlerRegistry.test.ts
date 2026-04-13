import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedContributionRegistry, ResolvedHookRegistration } from '@/extensions/registry/types';

import { describe, expect, it } from 'vitest';

import type { PluginCompatibilityDiagnostic } from '@/extensions/plugins/shared/pluginDiagnostics';
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
        source: 'plugin',
        pluginId: params.pluginId,
        manifestPath: `/plugins/${params.pluginId}/.happier-plugin/plugin.json`,
        manifestDigest: `sha256:${params.pluginId}`,
        daemonEntryPath: params.daemonEntryPath,
        definition: {
            hookApiVersion: 1,
            id: 'backend.terminalRuntime.bindTranscript',
            category: 'integration',
            scope: 'backend',
            executionKind: 'integrate',
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
        providers: Object.freeze([]),
        backends: Object.freeze([]),
        hookRegistrations: Object.freeze([...hookRegistrations]),
        runtimeAdaptersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        providerDefinitionsById: new Map(),
        backendDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('resolvePluginHookHandlerRegistry', () => {
    it('loads plugin hook exports and orders handlers deterministically by priority', async () => {
        const highPriorityPath = await writeDaemonModule({
            basename: 'daemon-high.mjs',
            contents: 'export async function bindTranscript() { return "high"; }\n',
        });
        const lowPriorityPath = await writeDaemonModule({
            basename: 'daemon-low.cjs',
            contents: 'module.exports = { bindTranscript: async () => "low" };\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.low',
                    daemonEntryPath: lowPriorityPath,
                    exportName: 'bindTranscript',
                    priority: 10,
                }),
                createHookRegistration({
                    pluginId: 'acme.high',
                    daemonEntryPath: highPriorityPath,
                    exportName: 'bindTranscript',
                    priority: 50,
                }),
            ]),
        });

        const handlers = result.handlersByHookId.get('backend.terminalRuntime.bindTranscript');
        expect(handlers?.map((handler) => handler.pluginId)).toEqual(['acme.high', 'acme.low']);
        await expect(handlers?.[0]?.handler()).resolves.toBe('high');
        await expect(handlers?.[1]?.handler()).resolves.toBe('low');
        expect(result.diagnosticsByPluginId['acme.high']).toEqual([]);
        expect(result.diagnosticsByPluginId['acme.low']).toEqual([]);
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
                    exportName: 'bindTranscript',
                }),
            ]),
        });

        expect(result.handlersByHookId.get('backend.terminalRuntime.bindTranscript')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.missing']).toEqual([
            expect.objectContaining({
                code: 'plugin_hook_handler_missing',
            }),
        ]);
    });

    it('records a diagnostic and excludes plugin hooks whose export is not a function', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-invalid.mjs',
            contents: 'export const bindTranscript = 42;\n',
        });

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([
                createHookRegistration({
                    pluginId: 'acme.invalid',
                    daemonEntryPath,
                    exportName: 'bindTranscript',
                }),
            ]),
        });

        expect(result.handlersByHookId.get('backend.terminalRuntime.bindTranscript')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.invalid']).toEqual([
            expect.objectContaining({
                code: 'plugin_hook_handler_invalid',
            }),
        ]);
    });

    it('returns only hook-resolution diagnostics instead of echoing contribution diagnostics', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-valid.mjs',
            contents: 'export async function bindTranscript() { return "ok"; }\n',
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
                        exportName: 'bindTranscript',
                    }),
                ]),
                pluginDiagnosticsByPluginId: Object.freeze({
                    'acme.preexisting': preexistingDiagnostics,
                }),
            },
        });

        expect(result.handlersByHookId.get('backend.terminalRuntime.bindTranscript')).toHaveLength(1);
        expect(result.diagnosticsByPluginId['acme.preexisting']).toEqual([]);
    });

    it('fails closed when a hook registration declares an unsupported handler target', async () => {
        const daemonEntryPath = await writeDaemonModule({
            basename: 'daemon-target.mjs',
            contents: 'export async function bindTranscript() { return "noop"; }\n',
        });
        const unsupportedRegistration = {
            source: 'plugin',
            pluginId: 'acme.daemon-target',
            manifestPath: '/plugins/acme.daemon-target/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:acme.daemon-target',
            daemonEntryPath,
            definition: {
                hookApiVersion: 1,
                id: 'backend.terminalRuntime.bindTranscript',
                category: 'integration',
                scope: 'backend',
                executionKind: 'integrate',
                handler: {
                    target: 'daemon' as const,
                    exportName: 'bindTranscript',
                },
            },
        } as unknown as ResolvedHookRegistration;

        const result = await resolvePluginHookHandlerRegistry({
            registry: createRegistry([unsupportedRegistration]),
        });

        expect(result.handlersByHookId.get('backend.terminalRuntime.bindTranscript')).toBeUndefined();
        expect(result.diagnosticsByPluginId['acme.daemon-target']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });
});
