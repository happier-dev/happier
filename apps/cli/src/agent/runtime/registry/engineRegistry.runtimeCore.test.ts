import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSubagentsServiceV1 } from '@happier-dev/plugin-sdk';

import { configuration } from '@/configuration';
import { createPluginApiHost } from '@/plugins/runtime/api/host';
import {
    resolveBackendEngineAdapterResolution,
    resolveCliEngineRegistry,
} from './engineRegistry';

const {
    resolveMergedContributionRegistryMock,
    getExecutionRunBackendDescriptorMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolvePluginRuntimeAdapterSurfacesMock,
    pluginReloadControllerStateMock,
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    getExecutionRunBackendDescriptorMock: vi.fn<(...args: unknown[]) => unknown>((..._args: unknown[]) => {
        throw new Error('legacy executionRunBackendRegistry must not be used when runtimeCore exist');
    }),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolvePluginRuntimeAdapterSurfacesMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerStateMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('../../../plugins/runtime/reload/singleton', () => ({
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

describe('resolveCliEngineRegistry runtimeCore', () => {
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

    type ObservedPluginRuntimeContext = Readonly<{
        fetch?: unknown;
        config?: Readonly<{
            values?: Readonly<{
                currentCliVersion?: string;
            }>;
        }>;
        logger?: Readonly<{
            debug?: unknown;
        }>;
        features?: Readonly<{
            isEnabled?: unknown;
        }>;
        acp?: Readonly<{
            defineAcpBackend?: unknown;
            createRuntime?: unknown;
        }>;
        sessions?: Readonly<{
            subagents?: unknown;
            external?: unknown;
        }>;
        notifications?: Readonly<{
            send?: unknown;
            listCategories?: unknown;
            listChannels?: unknown;
            getUserPreferences?: unknown;
        }>;
        projects?: Readonly<{
            listAll?: unknown;
            listForCurrentMachine?: unknown;
            listForMachine?: unknown;
            get?: unknown;
            getActive?: unknown;
            watch?: unknown;
        }>;
        account?: Readonly<{
            settings?: Readonly<{
                get?: unknown;
                set?: unknown;
                onChange?: unknown;
            }>;
        }>;
        abort?: Readonly<{
            signal?: unknown;
        }>;
        storage?: Readonly<{
            ephemeral?: unknown;
            session?: unknown;
            local?: unknown;
            synced?: unknown;
        }>;
        settings?: Readonly<{
            get?: unknown;
            set?: unknown;
            onChange?: unknown;
            describeFields?: unknown;
            projectForm?: unknown;
        }>;
        secrets?: Readonly<{
            get?: unknown;
            set?: unknown;
            delete?: unknown;
            list?: unknown;
        }>;
        events?: Readonly<{
            emit?: unknown;
            subscribe?: unknown;
        }>;
        auth?: Readonly<{
            getIdentity?: unknown;
            onChange?: unknown;
            services?: Readonly<{
                materialize?: unknown;
            }>;
        }>;
        mcp?: Readonly<{
            resolveForSession?: unknown;
        }>;
        actions?: Readonly<{
            scm?: Readonly<{
                diffSummary?: Readonly<{
                    generate?: unknown;
                }>;
            }>;
        }>;
    }>;

    type AcpDefinitionContextForTest = Readonly<{
        acp: Readonly<{
            defineAcpBackend: (input: unknown) => unknown;
        }>;
    }>;

    type PermissionContextForTest = Readonly<{
        permissions: Readonly<{
            requestDecision: (input: unknown) => Promise<unknown>;
        }>;
    }>;

    type SessionScopedContextForTest = Readonly<{
        sessions: Readonly<{
            writeMetadata: (input: unknown) => Promise<void>;
            writeAgentState: (input: unknown) => Promise<void>;
        }>;
        telemetry: Readonly<{
            emit: (input: unknown) => void;
        }>;
        artifacts: Readonly<{
            write: (input: unknown) => Promise<void>;
        }>;
        permissions: Readonly<{
            requestDecision: (input: unknown) => Promise<unknown>;
        }>;
        transcripts: Readonly<{
            append: (input: unknown) => Promise<void> | void;
        }>;
    }>;

    type HostSessionRuntimePlanForTest = Readonly<{
        config: Readonly<{
            createSessionRuntime: (input: unknown) => Promise<unknown>;
        }>;
    }>;

    async function loadOpenCodeExtensionActivate(): Promise<(api: unknown) => unknown> {
        // Import extension source directly (not dist) so this test doesn't depend on build outputs.
        const moduleUrl = new URL(
            '../../../../../../packages/plugins/opencode/src/activate.ts',
            import.meta.url,
        );
        const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
        if (!isRecord(namespace) || typeof namespace.activate !== 'function') {
            throw new Error('Expected OpenCode extension module to export activate(api)');
        }
        return namespace.activate as (api: unknown) => unknown;
    }

    function seedCodexBuiltInRegistry(params: Readonly<{
        runtimeCoreFactory: (params: unknown) => unknown;
    }>): void {
        const catalogEntry = {
            id: 'codex',
            cliSubcommand: 'codex',
        };

        resolveMergedContributionRegistryMock.mockResolvedValue({
            providers: [],
            backends: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                    getRuntimeCore: async () => params.runtimeCoreFactory,
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        });
    }

    function seedPluginRegistry(params: Readonly<{
        runtimeCoreFactory: (params: unknown) => unknown;
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
                        runtimeCoreHooks: [],
                    },
                },
                runtimeKind: 'native',
                runtimeCoreHooks: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                            runtimeCoreHooks: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeCoreHooks: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getRuntimeCore: async () => params.runtimeCoreFactory,
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

    function seedPluginRegistryWithoutRuntimeCore(): void {
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
                        runtimeCoreHooks: [],
                    },
                },
                runtimeKind: 'native',
                runtimeCoreHooks: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                            runtimeCoreHooks: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeCoreHooks: [],
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

    function seedManifestOnlyAcpPluginRegistry(params?: Readonly<{
        backendDefinition?: Record<string, unknown>;
    }>) {
        const backendDefinition = params?.backendDefinition ?? {
            kindVersion: 1,
            id: 'acme.manifest.acp',
            providerId: 'acme.manifest.provider',
            engine: {
                kind: 'acp',
                transport: {
                    kind: 'stdio',
                    launch: {
                        kind: 'executable',
                        command: 'acme-agent',
                        args: ['acp'],
                    },
                },
                ux: {
                    title: 'Manifest ACP Agent',
                },
                mcp: {
                    policy: 'drop',
                },
            },
            capabilities: {},
            runtimeCoreHooks: [],
        };
        const registry = {
            providers: [{
                id: 'acme.manifest.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.manifest.provider',
                    ownedBackendIds: ['acme.manifest.acp'],
                },
                richDefinition: {
                    provenance: 'external',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.provider',
                        ownedBackendIds: ['acme.manifest.acp'],
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.manifest',
                daemonEntryPath: null,
            }],
            backends: [{
                id: 'acme.manifest.acp',
                providerId: 'acme.manifest.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.manifest.acp',
                    providerId: 'acme.manifest.provider',
                },
                richDefinition: {
                    provenance: 'external',
                    definition: backendDefinition,
                },
                runtimeKind: 'acp',
                runtimeCoreHooks: [],
                pluginId: 'acme.manifest',
                daemonEntryPath: null,
            }],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            backendDefinitionsById: new Map([
                ['acme.manifest.acp', {
                    id: 'acme.manifest.acp',
                    providerId: 'acme.manifest.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.acp',
                        providerId: 'acme.manifest.provider',
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: backendDefinition,
                    },
                    runtimeKind: 'acp',
                    runtimeCoreHooks: [],
                    pluginId: 'acme.manifest',
                    daemonEntryPath: null,
                }],
            ]),
            providerDefinitionsById: new Map([
                ['acme.manifest.provider', {
                    id: 'acme.manifest.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.provider',
                        ownedBackendIds: ['acme.manifest.acp'],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.manifest.provider',
                            ownedBackendIds: ['acme.manifest.acp'],
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.manifest',
                    daemonEntryPath: null,
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
        return registry;
    }

    function seedFirstPartyOpenCodeRegistryWithoutRuntimeCore(): void {
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
                runtimeCoreHooks: [],
            }],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                    runtimeCoreHooks: [],
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

    it('prefers a built-in catalog runtimeCore factory over the legacy fallback runtimeCore path', async () => {
        const customRuntimeCore = {
            createSessionRuntime: vi.fn(async (params: unknown) => ({
                source: 'custom-runtimeCore',
                params,
            })),
            createExecutionRunBackend: vi.fn((params: unknown) => ({
                source: 'custom-runtimeCore',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
                params,
            })),
        };
        const runtimeCoreFactory = vi.fn(async (params: unknown) => {
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
                runtimeCore: customRuntimeCore,
            };
        });
        seedCodexBuiltInRegistry({ runtimeCoreFactory });

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('codex');

        expect(runtimeCoreFactory).toHaveBeenCalledTimes(1);
        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/codex' }),
        ).resolves.toEqual({
            source: 'custom-runtimeCore',
            params: { cwd: '/tmp/codex' },
        });
        expect(
            resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
                cwd: '/tmp/codex',
                backendId: 'codex',
                permissionMode: 'read_only',
            }),
        ).toEqual(expect.objectContaining({
            source: 'custom-runtimeCore',
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
        expect(customRuntimeCore.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/codex' });
        expect(customRuntimeCore.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
        });
    });

    it('resolves plugin backends through a registered backend engine when no getRuntimeCore is declared on the backend', async () => {
        seedPluginRegistryWithoutRuntimeCore();
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
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
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

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        expect(observedContext).toEqual(expect.any(Object));
        const context = observedContext as unknown as ObservedPluginRuntimeContext;
        expect(context.config?.values?.currentCliVersion).toBe(configuration.currentCliVersion);
        expect(context.logger?.debug).toEqual(expect.any(Function));
        expect(context.features?.isEnabled).toEqual(expect.any(Function));
        expect(context.acp?.defineAcpBackend).toEqual(expect.any(Function));
        expect(context.acp?.createRuntime).toEqual(expect.any(Function));
        expect(context.fetch).toEqual(expect.any(Function));
        await expect((context.fetch as (request: unknown) => Promise<unknown>)({
            url: 'https://example.test/blocked',
        })).rejects.toThrow(/network/i);
        expect(context.sessions?.subagents).toEqual(expect.objectContaining({
            list: expect.any(Function),
            upsert: expect.any(Function),
            updateStatus: expect.any(Function),
            complete: expect.any(Function),
        }));
        const subagents = context.sessions?.subagents as PluginSubagentsServiceV1;
        await expect(subagents.upsert({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            origin: 'provider',
            kind: 'native',
            providerRef: { providerId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);
        await expect(subagents.list({ parentSessionId: 'session-1' }))
            .resolves
            .toEqual([]);
        await expect(subagents.complete({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            status: 'completed',
        })).rejects.toThrow(/unavailable/);
        expect(context.sessions?.external).toEqual(expect.objectContaining({
            listCandidates: expect.any(Function),
            attach: expect.any(Function),
            takeover: expect.any(Function),
            pageTranscript: expect.any(Function),
            readAfterTranscript: expect.any(Function),
            followTranscript: expect.any(Function),
        }));
        const externalSessions = context.sessions?.external as Readonly<{
            attach: (input: unknown) => Promise<unknown>;
            takeover: (input: unknown) => Promise<unknown>;
            followTranscript: (input: unknown, onEvent: (event: unknown) => void) => { unsubscribe: () => void };
        }>;
        await expect(externalSessions.attach({})).resolves.toMatchObject({ ok: false });
        await expect(externalSessions.takeover({})).resolves.toMatchObject({
            ok: false,
            errorCode: 'capability_unsupported',
        });
        expect(() => externalSessions.followTranscript({}, vi.fn()).unsubscribe()).not.toThrow();
        expect(context.notifications?.send).toEqual(expect.any(Function));
        expect(context.notifications?.listCategories).toEqual(expect.any(Function));
        expect(context.notifications?.listChannels).toEqual(expect.any(Function));
        expect(context.notifications?.getUserPreferences).toEqual(expect.any(Function));
        expect(context.projects?.listAll).toEqual(expect.any(Function));
        expect(context.projects?.listForCurrentMachine).toEqual(expect.any(Function));
        expect(context.projects?.listForMachine).toEqual(expect.any(Function));
        expect(context.projects?.get).toEqual(expect.any(Function));
        expect(context.projects?.getActive).toEqual(expect.any(Function));
        expect(context.projects?.watch).toEqual(expect.any(Function));
        expect(context.account?.settings?.get).toEqual(expect.any(Function));
        expect(context.account?.settings?.set).toEqual(expect.any(Function));
        expect(context.account?.settings?.onChange).toEqual(expect.any(Function));
        expect(context.abort?.signal).toEqual(expect.any(AbortSignal));

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

    it('keeps plugin subagent access typed-unavailable in A.13 host session scope', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => ({
                                        kind: 'hostSessionRuntimePlan',
                                        config: {
                                            createSessionRuntime: async () => ({ ok: true }),
                                        },
                                    }),
                                    createExecutionRunBackend: vi.fn(),
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

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin' }) as Readonly<{
            config: Readonly<{
                createSessionRuntime: (params: unknown) => Promise<unknown>;
            }>;
        }>;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'machine-1',
            session: { sessionId: 'session-1' },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const subagents = context.sessions?.subagents as PluginSubagentsServiceV1;
        await expect(subagents.upsert({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            origin: 'provider',
            kind: 'native',
            providerRef: { providerId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);

        await expect(subagents.list({ parentSessionId: 'session-2' })).resolves.toEqual([]);
        await expect(subagents.upsert({
            id: 'plugin-subagent-2',
            parentSessionId: 'session-2',
            origin: 'provider',
            kind: 'native',
            providerRef: { providerId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);
        expect(() => subagents.watch({ parentSessionId: 'session-2' }, vi.fn()).unsubscribe()).not.toThrow();
        await expect(subagents.complete({
            id: 'plugin-subagent-2',
            parentSessionId: 'session-2',
            status: 'completed',
        })).rejects.toThrow(/unavailable/);
    });

    it('hydrates plugin notification contributions into the plugin runtime context', async () => {
        seedPluginRegistryWithoutRuntimeCore();
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
        const baseContributes = await resolveMergedContributionRegistryMock();
        if (!isRecord(baseContributes)) {
            throw new Error('Expected mocked contribution registry to be an object');
        }
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: {
                ...baseContributes,
                notifications: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.sample',
                        definition: {
                            id: 'acme.notifications.reviewReady',
                            kind: 'activity',
                            title: 'Review ready',
                            eventIds: ['ready'],
                            defaultChannelIds: ['acme.notifications.memory'],
                        },
                    },
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.foreign',
                        definition: {
                            id: 'acme.foreign.reviewReady',
                            kind: 'activity',
                            title: 'Foreign review ready',
                            eventIds: ['ready'],
                            defaultChannelIds: ['acme.foreign.memory'],
                        },
                    },
                ],
                notificationChannels: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.sample',
                        definition: {
                            id: 'acme.notifications.memory',
                            kind: 'plugin',
                            title: 'Memory channel',
                        },
                    },
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.foreign',
                        definition: {
                            id: 'acme.foreign.memory',
                            kind: 'plugin',
                            title: 'Foreign memory channel',
                        },
                    },
                ],
            },
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend,
                                },
                            };
                        },
                    },
                }],
            ]),
            notificationCategoriesById: new Map(),
            notificationChannelsById: new Map([
                ['acme.notifications.memory', {
                    pluginId: 'acme.sample',
                    registration: {
                        id: 'acme.notifications.memory',
                        kind: 'plugin',
                        title: 'Memory channel',
                        send: async () => ({ delivered: true }),
                    },
                }],
                ['acme.foreign.memory', {
                    pluginId: 'acme.foreign',
                    registration: {
                        id: 'acme.foreign.memory',
                        kind: 'plugin',
                        title: 'Foreign memory channel',
                        send: async () => ({ delivered: true }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const notifications = context.notifications as Readonly<{
            listCategories: () => Promise<readonly Readonly<{ id: string }>[]>;
            listChannels: () => Promise<readonly Readonly<{ id: string }>[]>;
        }>;

        const categories = await notifications.listCategories();
        const channels = await notifications.listChannels();

        expect(categories).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.notifications.reviewReady' }),
        ]));
        expect(categories).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.foreign.reviewReady' }),
        ]));
        expect(channels).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.notifications.memory' }),
        ]));
        expect(channels).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.foreign.memory' }),
        ]));
    });

    it('rejects plugin backend engines that return unsupported executable surfaces beside runtimeCore', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async () => ({
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: vi.fn(),
                            },
                            terminalRuntimeSurface: {
                                launchTerminalRuntime: vi.fn(),
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        await expect(resolveBackendEngineAdapterResolution('acme.sample.backend')).rejects.toThrow(
            /unsupported BackendEngineV1 executable surface.*terminalRuntimeSurface/i,
        );
    });

    it('normalizes ACP-marked plugin backend engines through the host ACP runtime definition substrate', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: AcpDefinitionContextForTest) => ctx.acp.defineAcpBackend({
                            backendId: 'acme.sample.backend',
                            transport: {
                                kind: 'stdio',
                                launch: {
                                    kind: 'executable',
                                    command: 'acme-agent',
                                    args: ['acp'],
                                },
                            },
                            ux: {
                                title: 'Acme Agent',
                            },
                            mcp: {
                                policy: 'drop',
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
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

    it('resolves manifest-only ACP backend engines without activation registration', async () => {
        const registry = seedManifestOnlyAcpPluginRegistry();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: registry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map(),
            scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.manifest.acp');
        expect(resolution?.backendId).toBe('acme.manifest.acp');

        expect(() => resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.manifest.acp',
            permissionMode: 'read_only',
        })).not.toThrow();
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('reports invalid manifest-only ACP backend definitions instead of hiding them as missing runtimeCore', async () => {
        const invalidBackendDefinition = {
            kindVersion: 1,
            id: 'acme.manifest.acp',
            providerId: 'acme.manifest.provider',
            runtimeKind: 'acp',
            acp: {
                command: 'legacy-acp-agent',
            },
            capabilities: {},
            runtimeCoreHooks: [],
        };
        const registry = seedManifestOnlyAcpPluginRegistry({
            backendDefinition: invalidBackendDefinition,
        });

        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: registry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map(),
            scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        await expect(resolveBackendEngineAdapterResolution('acme.manifest.acp'))
            .rejects
            .toThrow(/Invalid manifest-only ACP backend 'acme\.manifest\.acp'/);
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('fails closed for execution-run permission requests that would require an interactive response', async () => {
        seedPluginRegistryWithoutRuntimeCore();
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
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: PermissionContextForTest) => ({
                            runtimeCore: {
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

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

	            resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
	                cwd: process.cwd(),
	                backendId: 'acme.sample.backend',
	                permissionMode: 'safe-yolo',
	            });

        expect(permissionDecisionPromise).not.toBeNull();
	        await expect(permissionDecisionPromise).resolves.toMatchObject({ decision: 'denied' });
	    });

    it('resolves OpenCode backend runtimeCore through the extracted extension engine', async () => {
        seedFirstPartyOpenCodeRegistryWithoutRuntimeCore();
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
        const host = createPluginApiHost({ runtimeCapabilities: ['backends'] });
        await activate(host.api);
        const registrations = host.registrations();
        expect(registrations.backendEngines.map((engine) => engine.backendId)).toEqual(['opencode']);

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['opencode', {
                    pluginId: '@happier-dev/plugins-opencode',
                    registration: registrations.backendEngines[0],
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('opencode');
        expect(resolution?.backendId).toBe('opencode');

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
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

    it('binds PluginContextV1 session-scoped services when plugin engine createSessionRuntime plan is executed', async () => {
        seedPluginRegistryWithoutRuntimeCore();
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
            updateMetadata: vi.fn(async (handler: (metadata: Record<string, unknown>) => unknown) => {
                handler({ existing: true });
            }),
            updateAgentState: vi.fn(async (handler: (agentState: Record<string, unknown>) => unknown) => {
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
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => ({
                            runtimeCore: {
                                createSessionRuntime: async (sessionParams: unknown) => ({
                                    kind: 'hostSessionRuntimePlan',
                                    providerId: 'acme.sample.backend',
                                    opts: sessionParams,
                                    config: {
                                        createSessionRuntime: async (_params: unknown) => {
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

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin' }) as HostSessionRuntimePlanForTest;
        try {
            await expect(plan.config.createSessionRuntime({
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

            const artifactsPath = join(artifactsRoot, 'plugins', 'acme.sample.backend', 'extension-artifacts.jsonl');
            const telemetryPath = join(artifactsRoot, 'plugins', 'acme.sample.backend', 'extension-telemetry.jsonl');
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

    it('injects A.11 persistence, event, and narrow auth services into plugin runtime context', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginRuntimeAdapterSurfacesMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                directSessions: null,
                attach: null,
                sessionHandoff: null,
            },
            diagnostics: [],
        });

        let observedContext: ObservedPluginRuntimeContext | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: ObservedPluginRuntimeContext) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => ({
                                        kind: 'hostSessionRuntimePlan',
                                        config: {},
                                    }),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            mcpServers: [
                {
                    pluginId: 'acme.other',
                    registration: {
                        id: 'acme.other.mcp',
                        name: 'other-mcp',
                        transport: { kind: 'hosted' },
                    },
                },
            ],
            eventSubscriptionPermissionsByPluginId: new Map([
                ['acme.sample', new Set(['session.subscribe'])],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });
        getExecutionRunBackendDescriptorMock.mockReturnValueOnce(null);
        const authMaterializeAdapter = vi.fn(async () => ({
            env: { TOKEN: 'value' },
        }));

        await expect(resolveBackendEngineAdapterResolution('acme.sample.backend', {
            authMaterializeAdapter,
        })).resolves.toMatchObject({
            backendId: 'acme.sample.backend',
        });

        expect(observedContext).toMatchObject({
            storage: {
                ephemeral: expect.any(Object),
                session: expect.any(Object),
                local: expect.any(Object),
                synced: expect.any(Object),
            },
            settings: {
                get: expect.any(Function),
                set: expect.any(Function),
                onChange: expect.any(Function),
                describeFields: expect.any(Function),
                projectForm: expect.any(Function),
            },
            secrets: {
                get: expect.any(Function),
                set: expect.any(Function),
                delete: expect.any(Function),
                list: expect.any(Function),
            },
            events: {
                emit: expect.any(Function),
                subscribe: expect.any(Function),
            },
            auth: {
                getIdentity: expect.any(Function),
                onChange: expect.any(Function),
                services: {
                    materialize: expect.any(Function),
                },
            },
            actions: {
                scm: {
                    diffSummary: {
                        generate: expect.any(Function),
                    },
                },
            },
        });
        const context = observedContext as unknown as ObservedPluginRuntimeContext;
        expect('getConnectedServices' in (context.auth ?? {})).toBe(false);
        expect('startConnect' in (context.auth ?? {})).toBe(false);
        expect('disconnect' in (context.auth ?? {})).toBe(false);

        const sessionListener = vi.fn();
        expect(() => (
            context.events?.subscribe as (eventName: string, listener: (event: unknown) => void) => { unsubscribe: () => void }
        )('@happier/session/ready', sessionListener)).not.toThrow();

        await expect((context.auth?.services?.materialize as (request: unknown) => Promise<unknown>)({
            serviceId: 'openai-codex',
            profileId: 'default',
        })).resolves.toEqual({ env: { TOKEN: 'value' } });
        expect(authMaterializeAdapter).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            profileId: 'default',
        });

        const resolveMcpForSession = context.mcp?.resolveForSession as
            | ((input: Readonly<{ sessionId: string; directory: string }>) => Promise<readonly unknown[]>)
            | undefined;
        await expect(resolveMcpForSession?.({
            sessionId: 'session-1',
            directory: '/tmp/project',
        })).resolves.toEqual([]);
    });

    it('proves built-in parity: SessionHostBridge and createExecutionRunBackend both route through EngineRegistry runtimeCore for codex', async () => {
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
        const runtimeCore = {
            createSessionRuntime,
            createExecutionRunBackend,
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore }));
        seedCodexBuiltInRegistry({ runtimeCoreFactory });

        const { SessionHostBridge } = await import('@/agent/runtime/bridges/session/SessionHostBridge');
        const bridge = new SessionHostBridge();

        await expect(bridge.createSessionRuntime('codex', { cwd: '/tmp/codex', resume: 'resume-1' })).resolves.toEqual(createdPlan);

        const runtime = (await import('@/agent/executionRuns/runtime/createExecutionRunRuntime')).createExecutionRunRuntime({
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

        expect(runtimeCoreFactory).toHaveBeenCalled();
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

    it('preserves a first-class plugin backend runtimeCore factory instead of rebuilding a plugin-only fallback core', async () => {
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
        const runtimeCore = {
            createSessionRuntime: vi.fn(async () => createdPlan),
            createExecutionRunBackend: vi.fn(() => executionBackend),
        };
        const runtimeCoreEnvelope = {
            runtimeCore,
            facets: {
                transcriptSource: {
                    supported: true,
                },
            },
        };
        const runtimeCoreFactory = vi.fn(async () => runtimeCoreEnvelope);
        const seededRegistry = seedPluginRegistry({ runtimeCoreFactory });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: seededRegistry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
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

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(
            resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
                cwd: '/tmp/plugin',
                backendId: 'acme.sample.backend',
                permissionMode: 'read_only',
            }),
        ).toBe(executionBackend);
        expect(runtimeCore.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/plugin', resume: 'resume-1' });
        expect(runtimeCore.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/plugin',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });
        expect(resolution?.engineAdapter.facets).toEqual({
            transcriptSource: {
                supported: true,
            },
        });
        expect(runtimeCoreFactory).toHaveBeenCalledWith(expect.objectContaining({
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
        const runtimeCore = {
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
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore }));

        resolveMergedContributionRegistryMock.mockResolvedValue({
            providers: [],
            backends: [],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                        runtimeCoreHooks: [],
                    },
                },
                runtimeKind: 'native',
                runtimeCoreHooks: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                getRuntimeCore: async () => runtimeCoreFactory,
            }],
            actions: [],
            hookRegistrations: [],
            runtimeCoreHooksByBackendId: new Map(),
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
                            runtimeCoreHooks: [],
                        },
                    },
                    runtimeKind: 'native',
                    runtimeCoreHooks: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getRuntimeCore: async () => runtimeCoreFactory,
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
            contributes: authoritativeContributions,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
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

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        expect(resolution?.backend.id).toBe('acme.sample.backend');
        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });
});
