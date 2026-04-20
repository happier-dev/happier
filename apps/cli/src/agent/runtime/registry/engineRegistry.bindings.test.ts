import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { createPluginExtensionApiHost } from '@/extensions/runtime/api/host';

const resolveMergedContributionRegistryMock = vi.fn<(...args: any[]) => any>();
const getExecutionRunBackendDescriptorMock = vi.fn((..._args: any[]) => {
    throw new Error('legacy executionRunBackendRegistry must not be used when bindings exist');
});
const resolveExecutablePluginRuntimeRegistryMock = vi.fn<(...args: any[]) => any>();
const resolvePluginRuntimeAdapterSurfacesMock = vi.fn<(...args: any[]) => any>();
const pluginReloadControllerStateMock = vi.fn<(...args: any[]) => any>();

vi.mock('../../../extensions/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../extensions/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('../../../extensions/reload/singleton', () => ({
    pluginReloadController: {
        getState: pluginReloadControllerStateMock,
    },
}));

vi.mock('./resolvePluginRuntimeAdapterSurfaces', () => ({
    resolvePluginRuntimeAdapterSurfaces: resolvePluginRuntimeAdapterSurfacesMock,
}));

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
    getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

describe('resolveCliEngineRegistry bindings', () => {
    beforeEach(() => {
        vi.resetModules();
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolvePluginRuntimeAdapterSurfacesMock.mockReset();
        pluginReloadControllerStateMock.mockReset();
        getExecutionRunBackendDescriptorMock.mockClear();
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 0,
            activeRegistry: null,
            lastResult: null,
        });
    });

    function isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object';
    }

    async function loadOpenCodeExtensionActivate(): Promise<(api: unknown) => unknown> {
        // Import extension source directly (not dist) so this test doesn't depend on build outputs.
        const moduleUrl = new URL(
            '../../../../../../packages/extensions/opencode/src/activate.ts',
            import.meta.url,
        );
        const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
        if (!isRecord(namespace) || typeof namespace.activate !== 'function') {
            throw new Error('Expected OpenCode extension module to export activate(api)');
        }
        return namespace.activate as (api: unknown) => unknown;
    }

    function seedCodexBuiltInRegistry(params: Readonly<{
        bindingsFactory: (params: unknown) => unknown;
    }>): void {
        const catalogEntry = {
            id: 'codex',
            cliSubcommand: 'codex',
        };

        resolveMergedContributionRegistryMock.mockResolvedValue({
            providers: [],
            backends: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {
                codex: catalogEntry,
            },
            providerDefinitionsById: new Map([
                ['codex', {
                    id: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'codex',
                        ownedBackendIds: ['codex'],
                    },
                    richDefinition: {
                        source: 'built_in',
                        definition: {
                            id: 'codex',
                        },
                    },
                    runtimeSpec: null,
                    catalogEntry,
                }],
            ]),
            backendDefinitionsById: new Map([
                ['codex', {
                    id: 'codex',
                    providerId: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'codex',
                        providerId: 'codex',
                    },
                    richDefinition: {
                        source: 'built_in',
                        definition: {
                            id: 'codex',
                            providerId: 'codex',
                        },
                    },
                    getBindings: async () => params.bindingsFactory,
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        });
    }

    function seedPluginRegistry(params: Readonly<{
        bindingsFactory: (params: unknown) => unknown;
    }>) {
	        const registry = {
	            providers: [{
	                id: 'acme.sample.provider',
	                provenance: 'external',
	                source: { kind: 'path' },
	                definition: {
	                    kindVersion: 1,
	                    id: 'acme.sample.provider',
	                    ownedBackendIds: ['acme.sample.backend'],
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    title: 'Acme Sample CLI',
                    binaryName: 'acme-sample',
                    sourcePreferenceDefault: 'system-first',
                    managedInstall: {
                        kind: 'managed_package',
                        packageName: '@acme/sample-cli',
                        binaryName: 'acme-sample',
                    },
                    manualInstallKind: 'command',
                    manualInstallRecipes: null,
                    acceptsJavaScriptFileOverride: false,
                },
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
	            backends: [{
	                id: 'acme.sample.backend',
	                providerId: 'acme.sample.provider',
	                provenance: 'external',
	                source: { kind: 'path' },
	                definition: {
	                    kindVersion: 1,
	                    id: 'acme.sample.backend',
	                    providerId: 'acme.sample.provider',
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        providerId: 'acme.sample.provider',
                        runtimeKind: 'native',
                        capabilities: {},
                        runtimeAdapters: [],
                    },
                },
                runtimeKind: 'native',
                runtimeAdapters: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
	            backendDefinitionsById: new Map([
	                ['acme.sample.backend', {
	                    id: 'acme.sample.backend',
	                    providerId: 'acme.sample.provider',
	                    provenance: 'external',
	                    source: { kind: 'path' },
	                    definition: {
	                        kindVersion: 1,
	                        id: 'acme.sample.backend',
	                        providerId: 'acme.sample.provider',
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            providerId: 'acme.sample.provider',
                            runtimeKind: 'native',
                            capabilities: {},
                            runtimeAdapters: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeAdapters: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getBindings: async () => params.bindingsFactory,
                }],
            ]),
	            providerDefinitionsById: new Map([
	                ['acme.sample.provider', {
	                    id: 'acme.sample.provider',
	                    provenance: 'external',
	                    source: { kind: 'path' },
	                    definition: {
	                        kindVersion: 1,
	                        id: 'acme.sample.provider',
	                        ownedBackendIds: ['acme.sample.backend'],
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        title: 'Acme Sample CLI',
                        binaryName: 'acme-sample',
                        sourcePreferenceDefault: 'system-first',
                        managedInstall: {
                            kind: 'managed_package',
                            packageName: '@acme/sample-cli',
                            binaryName: 'acme-sample',
                        },
                        manualInstallKind: 'command',
                        manualInstallRecipes: null,
                        acceptsJavaScriptFileOverride: false,
                    },
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
        return registry;
    }

    function seedPluginRegistryWithoutBindings(): void {
        const registry = {
            providers: [{
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    ownedBackendIds: ['acme.sample.backend'],
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            backends: [{
                id: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        providerId: 'acme.sample.provider',
                        runtimeKind: 'native',
                        capabilities: {},
                        runtimeAdapters: [],
                    },
                },
                runtimeKind: 'native',
                runtimeAdapters: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            backendDefinitionsById: new Map([
                ['acme.sample.backend', {
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        providerId: 'acme.sample.provider',
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            providerId: 'acme.sample.provider',
                            runtimeKind: 'native',
                            capabilities: {},
                            runtimeAdapters: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeAdapters: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            providerDefinitionsById: new Map([
                ['acme.sample.provider', {
                    id: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
    }

    function seedFirstPartyOpenCodeRegistryWithoutBindings(): void {
        const backendId = 'opencode';
        const providerId = 'opencode';

        const registry = {
            providers: [{
                id: providerId,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: providerId,
                    ownedBackendIds: [backendId],
                },
                richDefinition: undefined,
                runtimeSpec: null,
                catalogEntry: {
                    id: providerId,
                    cliSubcommand: providerId,
                    vendorResumeSupport: 'unsupported',
                },
            }],
            backends: [{
                id: backendId,
                providerId,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: backendId,
                    providerId,
                },
                richDefinition: undefined,
                runtimeKind: 'server',
                runtimeAdapters: [],
            }],
            actions: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {
                [providerId]: {
                    id: providerId,
                    cliSubcommand: providerId,
                    vendorResumeSupport: 'unsupported',
                },
            },
            backendDefinitionsById: new Map([
                [backendId, {
                    id: backendId,
                    providerId,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: backendId,
                        providerId,
                    },
                    richDefinition: undefined,
                    runtimeKind: 'server',
                    runtimeAdapters: [],
                }],
            ]),
            providerDefinitionsById: new Map([
                [providerId, {
                    id: providerId,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: providerId,
                        ownedBackendIds: [backendId],
                    },
                    richDefinition: undefined,
                    runtimeSpec: null,
                    catalogEntry: {
                        id: providerId,
                        cliSubcommand: providerId,
                        vendorResumeSupport: 'unsupported',
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
    }

    it('prefers a built-in catalog bindings factory over the legacy fallback bindings path', async () => {
        const customBindings = {
            createSessionRuntime: vi.fn(async (params: unknown) => ({
                source: 'custom-bindings',
                params,
            })),
            createExecutionRunBackend: vi.fn((params: unknown) => ({
                source: 'custom-bindings',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
                params,
            })),
        };
        const bindingsFactory = vi.fn(async (params: unknown) => {
            expect(params).toEqual(expect.objectContaining({
                backend: expect.objectContaining({
                    id: 'codex',
                    providerId: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                }),
                provider: expect.objectContaining({
                    id: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                }),
                executionSurfaces: {
                    terminalRuntime: null,
                    directSessions: null,
                    attach: null,
                    sessionHandoff: null,
                },
            }));
            return {
                bindings: customBindings,
            };
        });
        seedCodexBuiltInRegistry({ bindingsFactory });

        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('codex');

        expect(bindingsFactory).toHaveBeenCalledTimes(1);
        await expect(
            resolution?.engineAdapter.bindings.createSessionRuntime({ cwd: '/tmp/codex' }),
        ).resolves.toEqual({
            source: 'custom-bindings',
            params: { cwd: '/tmp/codex' },
        });
        expect(
            resolution?.engineAdapter.bindings.createExecutionRunBackend({
                cwd: '/tmp/codex',
                backendId: 'codex',
                permissionMode: 'read_only',
            }),
        ).toEqual(expect.objectContaining({
            source: 'custom-bindings',
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
            params: {
                cwd: '/tmp/codex',
                backendId: 'codex',
                permissionMode: 'read_only',
            },
        }));
        expect(customBindings.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/codex' });
        expect(customBindings.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
        });
    });

    it('resolves plugin backends through a registered backend engine when no getBindings is declared on the backend', async () => {
        seedPluginRegistryWithoutBindings();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        const createExecutionRunBackend = vi.fn(() => ({
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));
        let observedContext: unknown = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributions: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                bindings: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend,
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const runtime = resolution!.engineAdapter.bindings.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        expect(observedContext).toEqual(expect.any(Object));
        expect((observedContext as any)?.config?.values?.currentCliVersion).toBe(configuration.currentCliVersion);
        expect((observedContext as any)?.logger?.debug).toEqual(expect.any(Function));
        expect((observedContext as any)?.features?.isEnabled).toEqual(expect.any(Function));
        expect((observedContext as any)?.abort?.signal).toEqual(expect.any(AbortSignal));

        expect(runtime).toMatchObject({
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
        });
        expect(createExecutionRunBackend).toHaveBeenCalledTimes(1);
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

	    it('fails closed for execution-run permission requests that would require an interactive response', async () => {
        seedPluginRegistryWithoutBindings();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        let permissionDecisionPromise: Promise<unknown> | null = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributions: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: any) => ({
                            bindings: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: () => {
                                    permissionDecisionPromise = ctx.permissions.requestDecision({
                                        toolCallId: 'tool-1',
                                        toolName: 'write_file',
                                        input: { path: '/tmp/a', content: 'hello' },
                                    });
                                    return {
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    };
                                },
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

	            resolution!.engineAdapter.bindings.createExecutionRunBackend({
	                cwd: process.cwd(),
	                backendId: 'acme.sample.backend',
	                permissionMode: 'safe-yolo',
	            });

        expect(permissionDecisionPromise).not.toBeNull();
	        await expect(permissionDecisionPromise).resolves.toMatchObject({ decision: 'denied' });
	    });

    it('resolves OpenCode backend bindings through the extracted extension engine', async () => {
        seedFirstPartyOpenCodeRegistryWithoutBindings();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        const activate = await loadOpenCodeExtensionActivate();
        const host = createPluginExtensionApiHost({ runtimeCapabilities: ['backends'] });
        await activate(host.api);
        const registrations = host.registrations();
        expect(registrations.backendEngines.map((engine) => engine.backendId)).toEqual(['opencode']);

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributions: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['opencode', {
                    pluginId: '@happier-dev/extensions-opencode',
                    registration: registrations.backendEngines[0],
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');
        const resolution = await resolveBackendEngineAdapterResolution('opencode');
        expect(resolution?.backendId).toBe('opencode');

        const runtime = resolution!.engineAdapter.bindings.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'opencode',
            permissionMode: 'read_only',
        });

        expect(runtime).toMatchObject({
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
        });
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('binds ExtensionContextV1 session-scoped services when plugin engine createSessionRuntime plan is executed', async () => {
        seedPluginRegistryWithoutBindings();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const artifactsRoot = mkdtempSync(join(tmpdir(), 'happier-extension-artifacts-'));
        const prevDebugArtifactsDir = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
        const prevExtensionArtifactsEnabled = process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED;
        const prevExtensionTelemetryEnabled = process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED;
        process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = artifactsRoot;
        process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED = '1';
        process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED = '1';

        const fakeSession = {
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(async (handler: (metadata: any) => any) => {
                handler({ existing: true });
            }),
            updateAgentState: vi.fn(async (handler: (agentState: any) => any) => {
                handler({ existing: true });
            }),
        };

        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            sendAgentMessageEphemeral: vi.fn(async () => undefined),
            sendAgentMessage: vi.fn(() => undefined),
        };

        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({ decision: 'approved' })),
        };

        const createExecutionRunBackend = vi.fn(() => ({
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributions: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: any) => ({
                            bindings: {
                                createSessionRuntime: async (sessionParams: any) => ({
                                    kind: 'hostSessionRuntimePlan',
                                    providerId: 'acme.sample.backend',
                                    opts: sessionParams,
                                    config: {
                                        createSessionRuntime: async (params: any) => {
                                            await ctx.sessions.writeMetadata({
                                                kind: 'set',
                                                metadata: { hello: 'world' },
                                            });
                                            await ctx.sessions.writeAgentState({
                                                kind: 'set',
                                                agentState: { hello: 'world' },
                                            });
                                            ctx.telemetry.emit({ kind: 'test_usage', n: 1 });
                                            await ctx.artifacts.write({ kind: 'test_artifact', text: 'hello' });
                                            await ctx.permissions.requestDecision({
                                                toolCallId: 'tool-1',
                                                toolName: 'read_file',
                                                input: { path: '/tmp/a' },
                                            });
                                            await ctx.transcripts.append({
                                                kind: 'agentMessageCommitted',
                                                provider: 'acme',
                                                body: { type: 'assistant', text: 'hi' },
                                                localId: 'local-1',
                                            });
                                            return { operations: { readSessionIdentity: () => ({ sessionId: 's1' }) } };
                                        },
                                    },
                                }),
                                createExecutionRunBackend,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const plan = await resolution!.engineAdapter.bindings.createSessionRuntime({ cwd: '/tmp/plugin' });
        try {
            await expect((plan as any).config.createSessionRuntime({
                directory: '/tmp/plugin',
                metadata: {},
                machineId: 'm1',
                session: fakeSession,
                transcriptSession: fakeTranscriptSession,
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: fakePermissionHandler,
                getPermissionMode: () => 'read_only',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            })).resolves.toEqual(expect.any(Object));

            expect(fakeSession.updateMetadata).toHaveBeenCalledTimes(1);
            expect(fakeSession.updateAgentState).toHaveBeenCalledTimes(1);
            expect(fakePermissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
            expect(fakeTranscriptSession.sendAgentMessageCommitted).toHaveBeenCalledTimes(1);

            const artifactsPath = join(artifactsRoot, 'extensions', 'acme.sample.backend', 'extension-artifacts.jsonl');
            const telemetryPath = join(artifactsRoot, 'extensions', 'acme.sample.backend', 'extension-telemetry.jsonl');
            expect(readFileSync(artifactsPath, 'utf8')).toContain('test_artifact');
            expect(readFileSync(telemetryPath, 'utf8')).toContain('test_usage');
        } finally {
            if (prevDebugArtifactsDir === undefined) {
                delete process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
            } else {
                process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = prevDebugArtifactsDir;
            }
            if (prevExtensionArtifactsEnabled === undefined) {
                delete process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED;
            } else {
                process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED = prevExtensionArtifactsEnabled;
            }
            if (prevExtensionTelemetryEnabled === undefined) {
                delete process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED;
            } else {
                process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED = prevExtensionTelemetryEnabled;
            }
            rmSync(artifactsRoot, { recursive: true, force: true });
        }
    });

    it('proves built-in parity: SessionHostBridge and createExecutionRunBackend both route through EngineRegistry bindings for codex', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            providerId: 'codex',
            opts: { cwd: '/tmp/codex', resume: 'resume-1' },
            config: {},
        };
        const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
        const executionBackend = {
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const createExecutionRunBackend = vi.fn(() => executionBackend);
        const bindings = {
            createSessionRuntime,
            createExecutionRunBackend,
        };
        const bindingsFactory = vi.fn(async () => ({ bindings }));
        seedCodexBuiltInRegistry({ bindingsFactory });

        const { SessionHostBridge } = await import('@/agent/runtime/bridges/session/SessionHostBridge');
        const bridge = new SessionHostBridge();

        await expect(bridge.createSessionRuntime('codex', { cwd: '/tmp/codex', resume: 'resume-1' })).resolves.toEqual(createdPlan);

        const runtime = (await import('@/agent/executionRuns/runtime/createExecutionRunBackend')).createExecutionRunRuntime({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
            accountSettings: {},
            start: {
                intent: 'plan',
                retentionPolicy: 'ephemeral',
            },
        });
        await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'run-session-1' });

        expect(bindingsFactory).toHaveBeenCalled();
        expect(createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/codex', resume: 'resume-1' });
        expect(createExecutionRunBackend).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
            start: expect.objectContaining({
                intent: 'plan',
                retentionPolicy: 'ephemeral',
            }),
        }));
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('preserves a first-class plugin backend bindings factory instead of rebuilding a plugin-only fallback core', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            providerId: 'acme.sample.backend',
            opts: { cwd: '/tmp/plugin', resume: 'resume-1' },
            config: {},
        };
        const executionBackend = {
            provisionSession: vi.fn(async () => ({ sessionId: 'plugin-run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const bindings = {
            createSessionRuntime: vi.fn(async () => createdPlan),
            createExecutionRunBackend: vi.fn(() => executionBackend),
        };
        const runtimeBinding = {
            bindings,
            facets: {
                transcriptSource: {
                    supported: true,
                },
            },
        };
        const bindingsFactory = vi.fn(async () => runtimeBinding);
        const seededRegistry = seedPluginRegistry({ bindingsFactory });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributions: seededRegistry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        });
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: { launch: vi.fn(async () => ({ marker: 'should-not-be-used' })) },
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        } as unknown);

        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        await expect(
            resolution?.engineAdapter.bindings.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(
            resolution?.engineAdapter.bindings.createExecutionRunBackend({
                cwd: '/tmp/plugin',
                backendId: 'acme.sample.backend',
                permissionMode: 'read_only',
            }),
        ).toBe(executionBackend);
        expect(bindings.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/plugin', resume: 'resume-1' });
        expect(bindings.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/plugin',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });
        expect(resolution?.engineAdapter.facets).toEqual({
            transcriptSource: {
                supported: true,
            },
        });
        expect(bindingsFactory).toHaveBeenCalledWith(expect.objectContaining({
            backend: expect.objectContaining({
                id: 'acme.sample.backend',
                provenance: 'external',
                source: { kind: 'path' },
            }),
            provider: expect.objectContaining({
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
            }),
            executionSurfaces: expect.objectContaining({
                terminalRuntime: expect.objectContaining({
                    launch: expect.any(Function),
                }),
            }),
        }));
    });

    it('resolves plugin backends from the authoritative active runtime registry when merged contributions are stale', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            providerId: 'acme.sample.backend',
            opts: { cwd: '/tmp/plugin', resume: 'resume-1' },
            config: {},
        };
        const bindings = {
            createSessionRuntime: vi.fn(async () => createdPlan),
            createExecutionRunBackend: vi.fn(() => ({
                provisionSession: vi.fn(async () => ({ sessionId: 'plugin-run-session-2' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
            })),
        };
        const bindingsFactory = vi.fn(async () => ({ bindings }));

        resolveMergedContributionRegistryMock.mockResolvedValue({
            providers: [],
            backends: [],
            actions: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        });

        const authoritativeContributions = {
            providers: [{
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    ownedBackendIds: ['acme.sample.backend'],
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            backends: [{
                id: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        providerId: 'acme.sample.provider',
                        runtimeKind: 'native',
                        capabilities: {},
                        runtimeAdapters: [],
                    },
                },
                runtimeKind: 'native',
                runtimeAdapters: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                getBindings: async () => bindingsFactory,
            }],
            actions: [],
            hookRegistrations: [],
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            backendDefinitionsById: new Map([
                ['acme.sample.backend', {
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        providerId: 'acme.sample.provider',
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            providerId: 'acme.sample.provider',
                            runtimeKind: 'native',
                            capabilities: {},
                            runtimeAdapters: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeAdapters: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getBindings: async () => bindingsFactory,
                }],
            ]),
            providerDefinitionsById: new Map([
                ['acme.sample.provider', {
                    id: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };

        const authoritativeRuntimeRegistry = {
            contributions: authoritativeContributions,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeAdapterHandlersByBackendId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        };
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 2,
            activeRegistry: authoritativeRuntimeRegistry,
            lastResult: null,
        });
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        } as unknown);

        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        expect(resolution?.backend.id).toBe('acme.sample.backend');
        await expect(
            resolution?.engineAdapter.bindings.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });
});
