import { describe, expect, it, beforeEach, vi } from 'vitest';
import { InstallableDependencyDescriptorSchema, readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedInstallableContribution,
} from '../../../plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    HOST_SESSION_RUNTIME_PLAN_KIND,
    type HostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/lifecycle';
import type { CliRuntimeCoreFactory } from './engineRegistryTypes';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { createPluginExecInstallablesRegistry } from './engineRegistry/contributions';
import { createHostPluginContextV1 } from './engineRegistry/pluginContext';

const { resolveExecutablePluginRuntimeRegistryMock } = vi.hoisted(() => ({
    resolveExecutablePluginRuntimeRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

const PROVIDER_ID = 'antigravity';
const BACKEND_ID = 'antigravity-terminal';
const PLUGIN_ID = 'happier.agent.antigravity';

function createProviderCatalogEntry(params?: Readonly<{
    getRuntimeCore?: ResolvedCatalogEntry['getRuntimeCore'];
    getTerminalPromptSubmitVerificationPolicy?: ResolvedCatalogEntry['getTerminalPromptSubmitVerificationPolicy'];
}>): ResolvedCatalogEntry {
    return {
        id: PROVIDER_ID,
        cliSubcommand: PROVIDER_ID,
        vendorResumeSupport: 'unsupported',
        ...params,
    } as ResolvedCatalogEntry;
}

function createProviderContribution(catalogEntry: ResolvedCatalogEntry): ResolvedAgentContribution {
    return {
        id: PROVIDER_ID,
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {
            kindVersion: 1,
            id: PROVIDER_ID,
            ownedBackendIds: [BACKEND_ID],
        },
        runtimeSpec: null,
        catalogEntry,
    };
}

function createBackendContribution(): ResolvedAgentRuntimeContribution {
    return {
        id: BACKEND_ID,
        agentId: PROVIDER_ID,
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {
            kindVersion: 1,
            id: BACKEND_ID,
            agentId: PROVIDER_ID,
        },
        surfaceHandlers: [],
    };
}

function createContributionRegistry(catalogEntry: ResolvedCatalogEntry): ResolvedContributionRegistry {
    const provider = createProviderContribution(catalogEntry);
    const backend = createBackendContribution();
    return {
        agents: [provider],
        agentRuntimes: [backend],
        actions: [],
        resources: [],
        uiDescriptors: [],
        notifications: [],
        notificationChannels: [],
        events: [],
        executionRunProfiles: [],
        managedDependencies: [],
        requestInterceptors: [],
        scmHostingProviders: [],
        scmBackends: [],
        connectedAccountDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {
            [PROVIDER_ID]: catalogEntry,
        },
        agentDefinitionsById: new Map([[PROVIDER_ID, provider]]),
        agentRuntimeDefinitionsById: new Map([[BACKEND_ID, backend]]),
        pluginDiagnosticsByPluginId: {},
    };
}

function createRuntimeRegistry(
    contributes: ResolvedContributionRegistry,
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes,
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        agentRuntimesByAgentId: new Map([
            [BACKEND_ID, {
                pluginId: PLUGIN_ID,
                registration: {
                    agentId: BACKEND_ID,
                    create: async (_ctx) => ({}),
                },
            }],
        ]),
        permissionsByPluginId: new Map([
            [PLUGIN_ID, new Set(['terminal.host.control'])],
        ]),
        runtimeCapabilitiesByPluginId: new Map([
            [PLUGIN_ID, new Set(['terminalHost'])],
        ]),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
        activatedPluginIds: new Set([PLUGIN_ID]),
        activatePluginsByEvent: vi.fn(async () => []),
        readHookEventEnvelopeV1,
        dispose: async () => undefined,
    };
}

describe('engineRegistry provider catalog entry lookup', () => {
    beforeEach(() => {
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
    });

    it('resolves a first-party catalog runtimeCore by provider id when backend id differs', async () => {
        const sessionPlan: HostSessionRuntimePlan = {
            kind: HOST_SESSION_RUNTIME_PLAN_KIND,
            agentId: PROVIDER_ID,
            opts: {
                credentials: {
                    token: 'test-token',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                directory: '/tmp/antigravity-terminal',
                permissionMode: 'default',
            } as HostSessionRuntimePlan['opts'],
            config: {
                providerName: 'Antigravity',
            } as HostSessionRuntimePlan['config'],
        };
        const createSessionRuntime = vi.fn(async () => sessionPlan);
        const runtimeCoreFactoryImpl: CliRuntimeCoreFactory = async () => ({
            runtimeCore: {
                createSessionRuntime,
                createExecutionRunBackend: (): never => {
                    throw new Error('createExecutionRunBackend should not be called in this test');
                },
            },
        });
        const runtimeCoreFactory = vi.fn(runtimeCoreFactoryImpl);
        const getRuntimeCoreSpy = vi.fn(async () => runtimeCoreFactory);
        const getRuntimeCore: NonNullable<ResolvedCatalogEntry['getRuntimeCore']> = () => getRuntimeCoreSpy();
        const contributes = createContributionRegistry(createProviderCatalogEntry({ getRuntimeCore }));

        resolveExecutablePluginRuntimeRegistryMock.mockRejectedValue(
            new Error('resolveExecutablePluginRuntimeRegistry should not be used for provider catalog runtimeCore resolution'),
        );

        const resolution = await resolveBackendEngineAdapterResolution(BACKEND_ID, { contributes });
        const sessionRuntime = await resolution?.engineAdapter.runtimeCore.createSessionRuntime({
            directory: '/tmp/antigravity-terminal',
            permissionMode: 'default',
        });

        expect(sessionRuntime).toEqual(sessionPlan);
        expect(getRuntimeCoreSpy).toHaveBeenCalledTimes(1);
        expect(runtimeCoreFactory).toHaveBeenCalledTimes(1);
        expect(runtimeCoreFactory).toHaveBeenCalledWith(expect.objectContaining({
            backend: expect.objectContaining({ id: BACKEND_ID, agentId: PROVIDER_ID }),
            provider: expect.objectContaining({ id: PROVIDER_ID }),
        }));
        expect(createSessionRuntime).toHaveBeenCalledTimes(1);
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });

    it('resolves provider-scoped terminal prompt policies by provider id in plugin context', async () => {
        const getTerminalPromptSubmitVerificationPolicy = vi.fn(async () => ({
            shouldVerifyBeforeSubmit: () => false,
            verifyBeforeSubmit: () => true,
            shouldVerifyAfterSubmit: () => false,
            verifyAfterSubmit: () => true,
        }));
        const contributes = createContributionRegistry(createProviderCatalogEntry({
            getTerminalPromptSubmitVerificationPolicy,
        }));

        const ctx = createHostPluginContextV1({
            backendId: BACKEND_ID,
            runtimeRegistry: createRuntimeRegistry(contributes),
        });

        await ctx.agentRuntime.terminalHost.resolve({ preference: 'auto' });

        expect(getTerminalPromptSubmitVerificationPolicy).toHaveBeenCalledTimes(1);
    });

    it('builds the plugin exec installables registry from managedDependencies contributions', () => {
        const descriptor = InstallableDependencyDescriptorSchema.parse({
            id: 'acme-release-tool',
            key: 'acme-release-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.acme-release-tool',
            display: { name: 'Acme Release Tool' },
            description: 'Acme release tool dependency',
            source: {
                kind: 'github_release_binary',
                repo: 'acme/release-tool',
                distTag: 'latest',
            },
            binary: {
                commands: ['acme-release-tool'],
                systemFirst: true,
                managedFallback: true,
            },
            defaultPolicy: {
                autoInstallWhenNeeded: false,
                autoUpdateMode: 'notify',
            },
            consent: {
                install: 'required',
                update: 'required',
            },
        });
        const contribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.plugin',
            manifestPath: '/plugins/acme/plugin.json',
            manifestDigest: 'sha256:acme',
            daemonEntryPath: '/plugins/acme/daemon.mjs',
            definition: descriptor,
        } satisfies ResolvedInstallableContribution;
        const contributes = {
            ...createContributionRegistry(createProviderCatalogEntry()),
            managedDependencies: [contribution],
        };

        const installablesRegistry = createPluginExecInstallablesRegistry(contributes);

        expect(installablesRegistry?.descriptorsByKey['acme-release-tool']).toMatchObject({
            owner: {
                provenance: 'external_plugin',
                pluginId: 'acme.plugin',
                manifestDigest: 'sha256:acme',
            },
            descriptor: {
                key: 'acme-release-tool',
                capabilityId: 'dep.acme-release-tool',
            },
        });
    });
});
