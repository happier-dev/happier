import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
    accountSettingsParse,
    deriveBoxPublicKeyFromSeed,
    ProviderConnectionIdSchema,
    ProviderRuntimeBindingBasisV1Schema,
    resolveProviderManagedRuntimeDeclarationV1,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
    createPluginStateStore,
    writeCommittedLocalPathPluginFixture,
} from '@/plugins/store/state.testkit';
import {
    createMergedContributionRegistry,
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
    createAgentRuntimeCatalogEntryHooks,
} from '@/plugins/projection/registry/agentCatalogEntryHooks';
import {
    projectLoadedPluginContributes,
    resolvePluginContributes,
} from '@/plugins/projection/registry/resolvePluginContributions';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    readPluginRegistryCommitRecord,
    replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
    ImmutablePluginGenerationRecordSchema,
    prepareImmutablePluginGeneration,
    persistInstallationStateRevision,
    readCurrentCommittedPluginGenerations,
    readInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import {
    SAMPLE_PLUGIN_BACKEND_ID,
    SAMPLE_PLUGIN_ID,
    SAMPLE_PLUGIN_PROVIDER_ID,
    materializeSamplePluginFixture,
} from '@/plugins/testkit/samplePackage';

import {
    resolveExecutablePluginRuntimeRegistry,
    type RetainedManagedProviderRuntimeInvocationScope,
} from './resolveExecutablePluginRuntimeRegistry';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { adaptTargetActivationFacts } from '@/plugins/projection/introspection/targetActivationFacts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import { resolveEffectiveCodingPromptPlan } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    notificationChannelSettingFieldId,
} from '@/plugins/settings/notificationChannelSettings';
import type {
    StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
    ManagedProviderOperationAuthority,
} from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';

async function createTrustedLocalLinkInstall(params: Readonly<{
    pluginId: string;
    sourceRootPath: string;
    manifestVersion: string;
}>) {
    const distribution = await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
    return {
        mode: 'link' as const,
        manifestVersion: params.manifestVersion,
        installedPath: null,
        trust: createPluginTrustRecord({
            pluginId: params.pluginId,
            distribution,
            approvedAtMs: 1,
        }),
    };
}

describe('resolveExecutablePluginRuntimeRegistry (integration)', () => {
    it('retires current materialization after acquiring exact managed Provider runtimes across provenance', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-managed-provider-acquisition-home-'),
        );
        const pluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-managed-provider-acquisition-plugin-'),
        );
        const pluginId = 'acme.provider.acquisition';
        const managedProviderIds = [
            'bundled-gateway',
            'development-gateway',
            'external-gateway',
        ] as const;
        const descriptorOnlyProviderId = 'descriptor-only';
        const providerDefinition = (id: string, managed: boolean) => ({
            v: 1,
            id,
            name: id,
            kind: 'aggregator',
            endpointTemplates: [
                {
                    id: 'api',
                    protocol: 'openai-responses',
                    baseUrl: 'https://example.test/v1',
                    capabilities: {
                        streaming: 'supported',
                        toolRoundTrips: 'supported',
                        statefulResponses: 'unknown',
                        reasoningControls: 'supported',
                    },
                },
                {
                    id: 'api-chat',
                    protocol: 'openai-chat',
                    baseUrl: 'https://example.test/chat',
                    capabilities: {
                        streaming: 'supported',
                        toolRoundTrips: 'supported',
                        statefulResponses: 'unknown',
                        reasoningControls: 'supported',
                    },
                },
            ],
            catalog: {
                source: 'static',
                manualModelPolicy: 'allowed',
                staticModels: [{ id: 'example', name: 'Example' }],
            },
            ...(managed
                ? {
                    managedRuntime: {
                        kind: 'managed',
                        endpointTemplateIds: ['api', 'api-chat'],
                        ...(id === 'external-gateway'
                            ? {
                                connectedAccounts: [{
                                    purpose: 'upstream',
                                    service: 'accounts',
                                    required: false,
                                    materializationKinds: ['httpHeaders'],
                                }],
                                requestAuthUses: [{
                                    purpose: 'upstream',
                                    materialization: {
                                        kind: 'httpHeaders',
                                        origin: 'https://api.example.test',
                                        headerNames: ['authorization'],
                                    },
                                }],
                            }
                            : {}),
                    },
                }
                : {}),
        });

        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(
            join(pluginRoot, '.happier-plugin', 'plugin.json'),
            JSON.stringify({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Managed Provider acquisition fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                contributes: {
                    connectedAccountDescriptors: [{
                        id: 'accounts',
                        title: 'Fixture upstream account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string', minLength: 1 },
                                    secret: true,
                                }],
                            }],
                        },
                    }],
                    providers: [
                        ...managedProviderIds.map((id) => providerDefinition(id, true)),
                        providerDefinition(descriptorOnlyProviderId, false),
                    ],
                },
            }),
            'utf8',
        );
        await writeFile(
            join(pluginRoot, 'daemon.mjs'),
            `export function activate(api) {
                api.connectedAccounts.register('accounts', {
                    authentication: {
                        modes: {
                            manual: {
                                kind: 'manual',
                                async complete() {
                                    return {
                                        status: 'connected',
                                        accountId: 'account-1',
                                        displayName: 'Fixture account',
                                        scopes: []
                                    };
                                }
                            }
                        }
                    },
                    async refresh() { return { status: 'unavailable' }; },
                    async revoke() { return { status: 'remoteUnsupported' }; },
                    async status() {
                        return {
                            status: 'connected',
                            displayName: 'Fixture account'
                        };
                    },
                    async materialize() {
                        return { kind: 'httpHeaders', headers: {} };
                    }
                });
                for (const id of ${JSON.stringify(managedProviderIds)}) {
                    api.providers.register(id, {
                        async start() {
                            throw new Error('managed Provider runtime is not invoked during acquisition');
                        }
                    });
                }
            }`,
            'utf8',
        );
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId,
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
                install: await createTrustedLocalLinkInstall({
                    pluginId,
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                }),
                state: { enabled: true },
            },
        });

        const localContributes = projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }),
            provenance: 'first_party',
            existingAgentIds: new Set(),
        });
        const merged = createMergedContributionRegistry(localContributes, {});
        const provenanceByLocalId = new Map<string, Readonly<{
            provenance: ResolvedProviderContribution['provenance'];
            source: ResolvedProviderContribution['source'];
        }>>([
            ['bundled-gateway', { provenance: 'first_party', source: { kind: 'bundled' } }],
            ['development-gateway', { provenance: 'external', source: { kind: 'path' } }],
            ['external-gateway', { provenance: 'external', source: { kind: 'package' } }],
            [descriptorOnlyProviderId, { provenance: 'external', source: { kind: 'archive' } }],
        ]);
        const contributes: ResolvedContributionRegistry = Object.freeze({
            ...merged,
            materializationIdsByPluginId: Object.freeze({
                ...(merged.materializationIdsByPluginId ?? {}),
                [pluginId]: 'materialization-current',
            }),
            providers: Object.freeze((merged.providers ?? []).map((provider) => Object.freeze({
                ...provider,
                ...provenanceByLocalId.get(provider.identity.localId),
            } as ResolvedProviderContribution))),
        });
        const generationAuthority = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: [] },
        );
        if (!generationAuthority) {
            throw new Error('Expected current managed Provider generation authority');
        }

        const getBinding = vi.fn(async () => Object.freeze({
            purpose: 'upstream',
            service: Object.freeze({
                pluginId,
                localId: 'accounts',
            }),
            account: Object.freeze({
                service: Object.freeze({
                    pluginId,
                    localId: 'accounts',
                }),
                accountId: 'account-1',
            }),
            target: Object.freeze({
                kind: 'account' as const,
                accountId: 'account-1',
                displayName: 'Captured upstream',
            }),
        }));
        const requestSelection = vi.fn(async () => {
            throw new Error('exact managed Provider invocation must deny selection');
        });
        const connectedAccounts = Object.freeze({
            getBinding,
            requestSelection,
            async materialize() {
                return Object.freeze({
                    kind: 'httpHeaders' as const,
                    headers: Object.freeze({ authorization: 'Bearer fixture' }),
                });
            },
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch() {
                return Object.freeze({ dispose() {} });
            },
        }) satisfies StablePluginConnectedAccountsOwner;
        const cleanupOperationAuthority = vi.fn(async () => undefined);
        const activateOperationAuthority = vi.fn(async (
            _input: Parameters<ManagedProviderOperationAuthority['activate']>[0],
        ) => Object.freeze({
            exactPurposeBindingSubjectId: 'managed-provider-operation:exact-fixture',
            requestAuth: Object.freeze({
                realm: 'managedProviderStart' as const,
                capabilityPath: join(happyHomeDir, 'request-auth-capability.json'),
                requestAuthUses: Object.freeze([Object.freeze({
                    purpose: 'upstream',
                    materialization: Object.freeze({
                        kind: 'httpHeaders' as const,
                        origin: 'https://api.example.test',
                        headerNames: Object.freeze(['authorization']),
                    }),
                })]),
                isCurrent: () => true,
            }),
            cleanup: cleanupOperationAuthority,
        }));
        let currentExecutionOriginMachineId = 'machine-1';
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
            generationAuthority,
            connectedAccounts,
            resolveCurrentMachineId: () => 'machine-1',
            resolveCurrentMachineExecutionOriginContext: async () => Object.freeze({
                serverIdentityId: 'srv_runtime_origin_fixture',
                machineId: currentExecutionOriginMachineId,
            }),
            managedProviderOperationAuthority: Object.freeze({
                activate: activateOperationAuthority,
            }),
        });
        try {
            expect(runtimeRegistry.activatedPluginIds.has(pluginId)).toBe(false);
            expect((runtimeRegistry.contributes.providers ?? []).every(
                (provider) => provider.managedRuntime === undefined,
            )).toBe(true);

            const acquireManagedProviderRuntime =
                runtimeRegistry.acquireManagedProviderRuntime;
            expect(acquireManagedProviderRuntime).toBeTypeOf('function');
            if (!acquireManagedProviderRuntime) return;

            await expect(acquireManagedProviderRuntime({
                pluginId,
                localId: descriptorOnlyProviderId,
            })).resolves.toBeNull();
            expect(runtimeRegistry.activatedPluginIds.has(pluginId)).toBe(false);

            const acquired = await Promise.all(managedProviderIds.map(async (localId) => ({
                localId,
                provider: (contributes.providers ?? []).find(
                    (candidate) => candidate.identity.localId === localId,
                ),
                runtime: await acquireManagedProviderRuntime({ pluginId, localId }),
            })));
            expect(acquired.map(({ provider, runtime }) => ({
                provenance: provider?.provenance,
                source: provider?.source.kind,
                acquired: runtime !== null,
                current: runtime?.isCurrent(),
            }))).toEqual([
                { provenance: 'first_party', source: 'bundled', acquired: true, current: true },
                { provenance: 'external', source: 'path', acquired: true, current: true },
                { provenance: 'external', source: 'package', acquired: true, current: true },
            ]);
            expect(runtimeRegistry.activatedPluginIds.has(pluginId)).toBe(true);
            expect(runtimeRegistry.resolveCurrentPluginMaterializationRef?.(pluginId)).toEqual({
                pluginId,
                machineId: 'machine-1',
                materializationId: 'materialization-current',
            });
            await expect(runtimeRegistry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toEqual({
                serverIdentityId: 'srv_runtime_origin_fixture',
                materializationRef: {
                    pluginId,
                    machineId: 'machine-1',
                    materializationId: 'materialization-current',
                },
            });
            currentExecutionOriginMachineId = 'machine-other';
            await expect(runtimeRegistry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toBeNull();
            currentExecutionOriginMachineId = 'machine-1';
            // The exact mediator contribution resolver is deliberately
            // generation-owned: a matching plugin id alone cannot make an
            // undeclared contribution current.
            const resolveCurrentMediatorContributionMaterializationRef = (
                runtimeRegistry as typeof runtimeRegistry & Readonly<{
                    resolveCurrentMediatorContributionMaterializationRef?: (mediator: Readonly<{
                        pluginId: string;
                        contributionLocalId: string;
                    }>) => unknown;
                }>
            ).resolveCurrentMediatorContributionMaterializationRef;
            expect(resolveCurrentMediatorContributionMaterializationRef?.({
                pluginId,
                contributionLocalId: managedProviderIds[0],
            })).toEqual({
                pluginId,
                machineId: 'machine-1',
                materializationId: 'materialization-current',
            });
            expect(resolveCurrentMediatorContributionMaterializationRef?.({
                pluginId,
                contributionLocalId: 'undeclared-mediator-contribution',
            })).toBeNull();
            expect((runtimeRegistry.contributes.providers ?? []).every(
                (provider) => provider.managedRuntime === undefined,
            )).toBe(true);

            const createManagedProviderRuntimeInvocationServices =
                runtimeRegistry.createManagedProviderRuntimeInvocationServices;
            expect(createManagedProviderRuntimeInvocationServices).toBeTypeOf('function');
            if (!createManagedProviderRuntimeInvocationServices) return;
            const exactInvocation =
                await createManagedProviderRuntimeInvocationServices({
                    identity: {
                        pluginId,
                        localId: 'external-gateway',
                    },
                    purposeBindings: {
                        v: 1,
                        bindings: [{
                            purpose: {
                                consumer: {
                                    pluginId,
                                    localId: 'external-gateway',
                                },
                                purpose: 'upstream',
                            },
                            target: {
                                kind: 'account',
                                account: {
                                    service: {
                                        pluginId,
                                        localId: 'accounts',
                                    },
                                    accountId: 'account-1',
                                },
                            },
                        }],
                    },
                    operationClaim: {
                        kind: 'explicitStart',
                        machineId: 'machine-1',
                    },
                    signal: new AbortController().signal,
                    isCurrent: () => true,
                });
            expect(exactInvocation).not.toBeNull();
            expect(activateOperationAuthority).toHaveBeenCalledWith({
                identity: {
                    pluginId,
                    localId: 'external-gateway',
                },
                operationId: JSON.stringify([
                    'managed-provider-explicit-start',
                    'machine-1',
                    pluginId,
                    'external-gateway',
                ]),
                purposes: [{
                    consumer: {
                        pluginId,
                        localId: 'external-gateway',
                    },
                    purpose: 'upstream',
                }],
                purposeBindings: expect.objectContaining({
                    v: 1,
                    bindings: [expect.objectContaining({
                        purpose: expect.objectContaining({ purpose: 'upstream' }),
                    })],
                }),
                requestAuthUses: [{
                    purpose: {
                        consumer: {
                            pluginId,
                            localId: 'external-gateway',
                        },
                        purpose: 'upstream',
                    },
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.example.test',
                        headerNames: ['authorization'],
                    },
                }],
                isCurrent: expect.any(Function),
            });
            expect(exactInvocation?.bootstrap).toMatchObject({
                identity: {
                    pluginId,
                    localId: 'external-gateway',
                },
                operationClaimId: JSON.stringify([
                    'managed-provider-explicit-start',
                    'machine-1',
                    pluginId,
                    'external-gateway',
                ]),
                requestAuth: {
                    capabilityPath: join(
                        happyHomeDir,
                        'request-auth-capability.json',
                    ),
                    requestAuthUses: [expect.objectContaining({
                        purpose: 'upstream',
                    })],
                },
            });
            await expect(
                exactInvocation?.connectedAccounts.getBinding('upstream'),
            ).resolves.toMatchObject({
                purpose: 'upstream',
                target: { kind: 'account', accountId: 'account-1' },
            });
            expect(getBinding).toHaveBeenCalledWith(expect.objectContaining({
                exactPurposeBindingSubjectId:
                    'managed-provider-operation:exact-fixture',
            }));
            await expect(
                exactInvocation?.connectedAccounts.requestSelection({
                    purpose: 'upstream',
                    reason: 'captured invocation cannot mutate bindings',
                }),
            ).rejects.toMatchObject({
                code: 'plugin_host_access_operation_denied',
            });
            expect(requestSelection).not.toHaveBeenCalled();
            cleanupOperationAuthority.mockRejectedValueOnce(
                new Error('operation_authority_cleanup_busy'),
            );
            await expect(exactInvocation?.cleanup()).rejects.toThrow(
                'operation_authority_cleanup_busy',
            );
            await expect(exactInvocation?.cleanup()).resolves.toBeUndefined();
            await expect(exactInvocation?.cleanup()).resolves.toBeUndefined();
            expect(cleanupOperationAuthority).toHaveBeenCalledTimes(2);

            const createBoundedInvocation = async () => (
                await createManagedProviderRuntimeInvocationServices({
                    identity: {
                        pluginId,
                        localId: 'external-gateway',
                    },
                    purposeBindings: { v: 1, bindings: [] },
                    signal: new AbortController().signal,
                    isCurrent: () => true,
                })
            );
            const firstBounded = await createBoundedInvocation();
            const secondBounded = await createBoundedInvocation();
            expect(firstBounded?.bootstrap.operationClaimId).toMatch(
                /^managed-provider-bounded:/u,
            );
            expect(secondBounded?.bootstrap.operationClaimId).not.toBe(
                firstBounded?.bootstrap.operationClaimId,
            );
            expect(activateOperationAuthority).toHaveBeenCalledTimes(3);
            await firstBounded?.cleanup();
            await secondBounded?.cleanup();
            expect(cleanupOperationAuthority).toHaveBeenCalledTimes(4);

            const sessionRuntimeBindingBasis = {
                v: 1 as const,
                agentTargetKey: 'backend:fixture',
                connectionId:
                    ProviderConnectionIdSchema.parse('pc_fixture_session'),
                contributionKey:
                    `${pluginId}/external-gateway`,
                runtimeCredentialTransport: null,
                prepared: {
                    v: 1 as const,
                    materialization: 'spawnEnv' as const,
                },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['openai-responses'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv' as const,
                    applyPolicy: 'restart_session' as const,
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal' as const,
                    implementationIdentity: {
                        pluginId,
                        localId: 'external-gateway',
                    },
                    managedRuntime: {
                        kind: 'managed' as const,
                        dependencies: [],
                        endpointTemplateIds: ['api', 'api-chat'],
                        connectedAccounts: [{
                            purpose: 'upstream',
                            service: {
                                pluginId,
                                localId: 'accounts',
                            },
                            required: false,
                            materializationKinds: ['httpHeaders'],
                        }],
                        requestAuthUses: [{
                            purpose: 'upstream',
                            materialization: {
                                kind: 'httpHeaders' as const,
                                origin: 'https://api.example.test',
                                headerNames: ['authorization'],
                            },
                        }],
                    },
                    purposeBindings: { v: 1 as const, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: 'api',
                    protocol: 'openai-responses' as const,
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'connection-security',
                    grantFingerprint: 'grant',
                },
            } satisfies ProviderRuntimeBindingBasisV1;
            const bindSessionCustody = vi.fn(async (
                _scope: unknown,
                _dependencies: unknown,
            ) => Object.freeze({
                managedServices: exactInvocation!.managedServices,
                projectEndpointAccess: async () => null,
                adoptService: vi.fn(async () => undefined),
            }));
            const createSessionDemandInvocation = async (sessionId: string) => (
                await createManagedProviderRuntimeInvocationServices({
                    identity: {
                        pluginId,
                        localId: 'external-gateway',
                    },
                    purposeBindings: { v: 1, bindings: [] },
                    operationClaim: {
                        kind: 'sessionDemand',
                        sessionId,
                        runtimeBindingBasis:
                            sessionRuntimeBindingBasis,
                        bindSessionCustody,
                    },
                    signal: new AbortController().signal,
                    isCurrent: () => true,
                })
            );
            const sessionAFirst = await createSessionDemandInvocation('session-a');
            const sessionAReplacement =
                await createSessionDemandInvocation('session-a');
            const sessionB = await createSessionDemandInvocation('session-b');
            const developmentRuntimeBindingBasis = {
                ...sessionRuntimeBindingBasis,
                contributionKey:
                    `${pluginId}/development-gateway`,
                deployment: {
                    ...sessionRuntimeBindingBasis.deployment,
                    implementationIdentity: {
                        pluginId,
                        localId: 'development-gateway',
                    },
                    managedRuntime: {
                        kind: 'managed' as const,
                        dependencies: [],
                        connectedAccounts: [],
                        requestAuthUses: [],
                        endpointTemplateIds: ['api', 'api-chat'],
                    },
                },
            } satisfies ProviderRuntimeBindingBasisV1;
            const developmentSession =
                await createManagedProviderRuntimeInvocationServices({
                    identity: {
                        pluginId,
                        localId: 'development-gateway',
                    },
                    purposeBindings: { v: 1, bindings: [] },
                    operationClaim: {
                        kind: 'sessionDemand',
                        sessionId: 'session-development',
                        runtimeBindingBasis:
                            developmentRuntimeBindingBasis,
                        bindSessionCustody,
                    },
                    signal: new AbortController().signal,
                    isCurrent: () => true,
                });
            expect(sessionAFirst?.bootstrap).toMatchObject({
                identity: {
                    pluginId,
                    localId: 'external-gateway',
                },
                manifestAuthority: 'external',
            });
            const externalRuntime = acquired.find(
                ({ localId }) => localId === 'external-gateway',
            )?.runtime;
            expect(sessionAFirst?.bootstrap).toMatchObject({
                activationGeneration: externalRuntime?.activationGeneration,
                immutableGenerationId: externalRuntime?.immutableGenerationId,
            });
            expect(sessionAFirst?.bootstrap).not.toHaveProperty(
                'manifestDigest',
            );
            expect(developmentSession?.bootstrap).toMatchObject({
                identity: {
                    pluginId,
                    localId: 'development-gateway',
                },
                manifestAuthority: 'external',
            });
            expect(bindSessionCustody).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: 'session-a' }),
                expect.objectContaining({
                    status: expect.any(Function),
                    ensure: expect.any(Function),
                    update: expect.any(Function),
                    remove: expect.any(Function),
                }),
            );
            expect(sessionAFirst?.bootstrap.operationClaimId).toBe(
                sessionAReplacement?.bootstrap.operationClaimId,
            );
            expect(activateOperationAuthority.mock.calls
                .filter(([activation]) => activation.operationId
                    === sessionAFirst?.bootstrap.operationClaimId))
                .toHaveLength(2);
            expect(sessionB?.bootstrap.operationClaimId).not.toBe(
                sessionAFirst?.bootstrap.operationClaimId,
            );
            const retainedScope = sessionAFirst
                ? Object.freeze({
                    sessionId: 'session-a',
                    runtimeBindingBasis:
                        sessionRuntimeBindingBasis,
                    identity: sessionAFirst.bootstrap.identity,
                    activationGeneration:
                        sessionAFirst.bootstrap.activationGeneration,
                    immutableGenerationId:
                        sessionAFirst.bootstrap.immutableGenerationId,
                    manifestAuthority:
                        sessionAFirst.bootstrap.manifestAuthority,
                    operationClaimId:
                        sessionAFirst.bootstrap.operationClaimId,
                })
                : null;
            await sessionAFirst?.cleanup();
            await sessionAReplacement?.cleanup();
            await sessionB?.cleanup();
            await developmentSession?.cleanup();

            const retainedGeneration = generationAuthority.generations.get(
                pluginId,
            );
            if (!retainedGeneration) {
                throw new Error('Expected retained Provider generation');
            }
            const retainedManifestPath = join(
                retainedGeneration.rootPath,
                ...retainedGeneration.record.manifestRelativePath.split('/'),
            );
            const retainedManifest = await readFile(
                retainedManifestPath,
                'utf8',
            );
            // The retained P declaration is normalized and compared directly.
            // Formatting-only bytes in its daemon-custodied manifest are not a
            // second currentness authority.
            await writeFile(
                retainedManifestPath,
                `\n${retainedManifest}`,
                'utf8',
            );

            runtimeRegistry.retirePluginConsumers?.([pluginId]);
            expect(acquired.every(({ runtime }) => runtime?.isCurrent() === false)).toBe(true);
            expect(runtimeRegistry.resolveCurrentPluginMaterializationRef?.(pluginId)).toBeNull();
            await expect(runtimeRegistry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toBeNull();
            expect(resolveCurrentMediatorContributionMaterializationRef?.({
                pluginId,
                contributionLocalId: managedProviderIds[0],
            })).toBeNull();
            await expect(acquireManagedProviderRuntime({
                pluginId,
                localId: managedProviderIds[0],
            })).resolves.toBeNull();
            const createRetained = runtimeRegistry
                .createRetainedManagedProviderRuntimeInvocationServices;
            expect(createRetained).toBeTypeOf('function');
            expect(retainedScope).toMatchObject({
                manifestAuthority: 'external',
            });
            expect(retainedScope).not.toHaveProperty('manifestDigest');
            if (!createRetained || !retainedScope) return;
            const revalidatePolicy = vi.fn(async () => true);
            const readAdoptedPublicOutcome = vi.fn(async () => ({
                operationClaimId:
                    retainedScope.operationClaimId,
                serviceId: 'fixture-provider',
                endpointTemplateIds: ['api', 'api-chat'],
                endpoints: [
                    {
                        endpointTemplateId: 'api',
                        servicePath: '/v1',
                    },
                    {
                        endpointTemplateId: 'api-chat',
                        servicePath: '/chat',
                    },
                ],
                endpointAccess: 'runnerProjected' as const,
            }));
            const retained = await createRetained({
                scope: retainedScope,
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome,
                revalidatePolicy,
            });
            expect(retained).not.toBeNull();
            expect(retained?.bootstrap).toMatchObject({
                identity: retainedScope.identity,
                activationGeneration:
                    retainedScope.activationGeneration,
                immutableGenerationId:
                    retainedScope.immutableGenerationId,
                operationClaimId:
                    retainedScope.operationClaimId,
            });
            expect(revalidatePolicy).toHaveBeenCalledTimes(2);
            expect(readAdoptedPublicOutcome).toHaveBeenCalledTimes(2);
            await retained?.connectedAccounts.getBinding('upstream');
            expect(getBinding).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    exactPurposeBindingSubjectId:
                        'managed-provider-operation:exact-fixture',
                }),
            );
            await retained?.cleanup();
            await expect(createRetained({
                scope: retainedScope,
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome,
                revalidatePolicy: async () => false,
            })).resolves.toBeNull();
            await expect(createRetained({
                scope: retainedScope,
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome: async () => null,
                revalidatePolicy: async () => true,
            })).resolves.toBeNull();
            await expect(createRetained({
                scope: {
                    ...retainedScope,
                    manifestAuthority: 'bundled_first_party',
                },
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome,
                revalidatePolicy: async () => true,
            })).resolves.toBeNull();
            await expect(createRetained({
                scope: {
                    ...retainedScope,
                    runtimeBindingBasis:
                        ProviderRuntimeBindingBasisV1Schema.parse({
                            ...retainedScope.runtimeBindingBasis,
                            deployment: {
                                ...retainedScope.runtimeBindingBasis.deployment,
                                managedRuntime: {
                                    ...retainedScope.runtimeBindingBasis.deployment
                                        .managedRuntime,
                                    endpointTemplateIds: ['api'],
                                },
                            },
                        }),
                },
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome,
                revalidatePolicy: async () => true,
            })).resolves.toBeNull();
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('reconstructs an adopted bundled Provider from exact P bytes after desired Q removal and denies external reserved-id spoofing', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-retained-bundled-provider-home-'),
        );
        const pluginId = 'happier.provider.cliproxyapi';
        const providerLocalId = 'cliproxyapi';
        const endpointTemplateIds = [
            'cliproxyapi-openai-responses',
            'cliproxyapi-openai-chat',
            'cliproxyapi-anthropic',
        ] as const;
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const bundledArtifact =
            BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find((artifact) => (
                artifact.record.pluginId === pluginId
            ));
        expect(bundledArtifact).toBeDefined();
        if (!bundledArtifact) {
            throw new Error('Expected the generated CLIProxyAPI immutable artifact');
        }
        const generationAuthority =
            await readCurrentCommittedPluginGenerations(paths, {
                bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
            });
        expect(generationAuthority?.generations.get(pluginId)?.record).toEqual(
            bundledArtifact.record,
        );
        if (!generationAuthority) {
            throw new Error('Expected bundled generation authority');
        }

        const contributes = await resolveMergedContributionRegistry({
            happyHomeDir,
        });
        const provider = (contributes.providers ?? []).find((candidate) => (
            candidate.identity.pluginId === pluginId
            && candidate.identity.localId === providerLocalId
        ));
        expect(provider?.definition.managedRuntime?.kind).toBe('managed');
        if (provider?.definition.managedRuntime?.kind !== 'managed') {
            throw new Error('Expected bundled CLIProxyAPI managed Provider');
        }
        const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: {
                pluginId,
                localId: providerLocalId,
            },
            managedRuntime: provider.definition.managedRuntime,
        });
        expect(managedRuntime.endpointTemplateIds).toEqual(endpointTemplateIds);

        const connectedAccounts = Object.freeze({
            async getBinding() {
                return null;
            },
            async requestSelection() {
                throw new Error('retained Provider fixture cannot select accounts');
            },
            async materialize() {
                return Object.freeze({
                    kind: 'httpHeaders' as const,
                    headers: Object.freeze({}),
                });
            },
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch() {
                return Object.freeze({ dispose() {} });
            },
        }) satisfies StablePluginConnectedAccountsOwner;
        const cleanupOperationAuthority = vi.fn(async () => undefined);
        const activateOperationAuthority = vi.fn(async () => Object.freeze({
            exactPurposeBindingSubjectId:
                'managed-provider-operation:retained-bundled-fixture',
            requestAuth: Object.freeze({
                realm: 'managedProviderStart' as const,
                capabilityPath: join(
                    happyHomeDir,
                    'retained-bundled-request-auth-capability.json',
                ),
                requestAuthUses: Object.freeze([Object.freeze({
                    purpose: 'openai-upstream',
                    materialization: Object.freeze({
                        kind: 'httpHeaders' as const,
                        origin: 'https://chatgpt.com',
                        headerNames: Object.freeze([
                            'authorization',
                            'chatgpt-account-id',
                        ]),
                    }),
                })]),
                isCurrent: () => true,
            }),
            cleanup: cleanupOperationAuthority,
        }));
        const registryA = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
            generationAuthority,
            connectedAccounts,
            managedProviderOperationAuthority: Object.freeze({
                activate: activateOperationAuthority,
            }),
        });
        let registryB: Awaited<ReturnType<
            typeof resolveExecutablePluginRuntimeRegistry
        >> | null = null;
        try {
            const createFresh =
                registryA.createManagedProviderRuntimeInvocationServices;
            expect(createFresh).toBeTypeOf('function');
            if (!createFresh) return;
            const custodyServices = await createFresh({
                identity: { pluginId, localId: providerLocalId },
                purposeBindings: { v: 1, bindings: [] },
                signal: new AbortController().signal,
                isCurrent: () => true,
            });
            expect(custodyServices).not.toBeNull();
            if (!custodyServices) return;

            const runtimeBindingBasis = {
                v: 1 as const,
                agentTargetKey: 'backend:retained-bundled-fixture',
                connectionId: ProviderConnectionIdSchema.parse(
                    'pc_retained_bundled_fixture',
                ),
                contributionKey: `${pluginId}/${providerLocalId}`,
                runtimeCredentialTransport: null,
                prepared: {
                    v: 1 as const,
                    materialization: 'spawnEnv' as const,
                },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['openai-responses'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv' as const,
                    applyPolicy: 'restart_session' as const,
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal' as const,
                    implementationIdentity: {
                        pluginId,
                        localId: providerLocalId,
                    },
                    managedRuntime,
                    purposeBindings: { v: 1 as const, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: endpointTemplateIds[0],
                    protocol: 'openai-responses' as const,
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'connection-security',
                    grantFingerprint: 'grant',
                },
            } satisfies ProviderRuntimeBindingBasisV1;
            const retainedScopes:
                RetainedManagedProviderRuntimeInvocationScope[] = [];
            const cleanupCustody = vi.fn(async () => undefined);
            cleanupCustody.mockRejectedValueOnce(
                new Error('session_custody_cleanup_busy'),
            );
            const sessionInvocation = await createFresh({
                identity: { pluginId, localId: providerLocalId },
                purposeBindings: { v: 1, bindings: [] },
                operationClaim: {
                    kind: 'sessionDemand',
                    sessionId: 'session-retained-bundled-p',
                    runtimeBindingBasis,
                    bindSessionCustody: async (scope) => {
                        retainedScopes.push(scope);
                        return Object.freeze({
                            managedServices: custodyServices.managedServices,
                            projectEndpointAccess:
                                custodyServices.projectEndpointAccess,
                            adoptService: vi.fn(async () => undefined),
                            cleanup: cleanupCustody,
                        });
                    },
                },
                signal: new AbortController().signal,
                isCurrent: () => true,
            });
            expect(sessionInvocation?.bootstrap).toMatchObject({
                identity: { pluginId, localId: providerLocalId },
                immutableGenerationId:
                    bundledArtifact.record.immutableGenerationId,
                manifestAuthority: 'bundled_first_party',
            });
            expect(sessionInvocation?.bootstrap).not.toHaveProperty(
                'manifestDigest',
            );
            expect(retainedScopes).toHaveLength(1);
            const retainedScope = retainedScopes[0];
            expect(retainedScope).toMatchObject({
                manifestAuthority: 'bundled_first_party',
            });
            if (!sessionInvocation || !retainedScope) {
                throw new Error('Expected one retained managed Provider custody scope');
            }
            const operationAuthorityCleanupCount =
                cleanupOperationAuthority.mock.calls.length;
            await expect(sessionInvocation.cleanup()).rejects.toThrow(
                'session_custody_cleanup_busy',
            );
            expect(cleanupOperationAuthority).toHaveBeenCalledTimes(
                operationAuthorityCleanupCount + 1,
            );
            await expect(sessionInvocation.cleanup()).resolves.toBeUndefined();
            await expect(sessionInvocation.cleanup()).resolves.toBeUndefined();
            expect(cleanupCustody).toHaveBeenCalledTimes(2);
            expect(cleanupOperationAuthority).toHaveBeenCalledTimes(
                operationAuthorityCleanupCount + 1,
            );
            await custodyServices.cleanup();
            registryA.retirePluginConsumers?.([pluginId]);

            registryB = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: createMergedContributionRegistry({}, {}),
                generationAuthority,
                connectedAccounts,
                managedProviderOperationAuthority: Object.freeze({
                    activate: activateOperationAuthority,
                }),
            });
            expect(registryB.activatedPluginIds.has(pluginId)).toBe(false);
            const createRetained = registryB
                .createRetainedManagedProviderRuntimeInvocationServices;
            expect(createRetained).toBeTypeOf('function');
            if (!createRetained) return;
            const adoptedPublicOutcome = Object.freeze({
                operationClaimId: retainedScope.operationClaimId,
                serviceId: 'cliproxyapi-service-p',
                endpointTemplateIds,
                endpoints: Object.freeze([
                    Object.freeze({
                        endpointTemplateId: endpointTemplateIds[0],
                        servicePath: '/responses',
                    }),
                    Object.freeze({
                        endpointTemplateId: endpointTemplateIds[1],
                        servicePath: '/chat',
                    }),
                    Object.freeze({
                        endpointTemplateId: endpointTemplateIds[2],
                        servicePath: '/',
                    }),
                ]),
                endpointAccess: 'runnerProjected' as const,
            });
            const retained = await createRetained({
                scope: retainedScope,
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome: async () => adoptedPublicOutcome,
                revalidatePolicy: async () => true,
            });
            expect(retained?.bootstrap).toMatchObject({
                identity: retainedScope.identity,
                activationGeneration: retainedScope.activationGeneration,
                immutableGenerationId: retainedScope.immutableGenerationId,
                manifestAuthority: 'bundled_first_party',
                operationClaimId: retainedScope.operationClaimId,
            });
            await retained?.cleanup();

            const externalSpoofClaimId = JSON.stringify([
                'managed-provider-session-demand',
                retainedScope.sessionId,
                retainedScope.identity.pluginId,
                retainedScope.identity.localId,
                retainedScope.activationGeneration,
                retainedScope.immutableGenerationId,
                'external',
            ]);
            const externalSpoofScope = Object.freeze({
                ...retainedScope,
                manifestAuthority: 'external' as const,
                operationClaimId: externalSpoofClaimId,
            });
            await expect(createRetained({
                scope: externalSpoofScope,
                signal: new AbortController().signal,
                isCurrent: () => true,
                readAdoptedPublicOutcome: async () => Object.freeze({
                    ...adoptedPublicOutcome,
                    operationClaimId: externalSpoofClaimId,
                }),
                revalidatePolicy: async () => true,
            })).resolves.toBeNull();
        } finally {
            await registryB?.dispose();
            await registryA.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('reconstructs stable PluginServices from a retained Agent binding instead of the desired runtime callback', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-retained-agent-services-home-'),
        );
        const runtimeRegistry =
            await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                pluginIds: ['happier.agent.codex'],
            });
        try {
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'happier.agent.codex',
                family: 'agents',
                localId: 'codex',
            }]);
            const binding = runtimeRegistry
                .agentRuntimesByAgentId
                .get('codex')
                ?.sessionRunnerFactoryBinding;
            expect(binding).toBeDefined();
            if (!binding) return;
            const createRetained =
                runtimeRegistry
                    .createRetainedRunnerAgentInvocationServices;
            expect(createRetained).toBeDefined();
            if (!createRetained) return;

            // An ordinary H update may remove this Agent from the desired
            // registry. That is not revocation of the exact G Session.
            const mutableDesiredRegistry = runtimeRegistry as unknown as {
                agentRuntimesByAgentId: Map<string, unknown>;
            };
            mutableDesiredRegistry.agentRuntimesByAgentId.delete('codex');

            const retained = await createRetained({
                binding,
                sessionId: 'session-retained-g',
                correlationId: 'session-retained-g',
                cwd: '/workspace',
                environment: {},
                providerBindingActive: false,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });

            expect(retained.services.availability('exec'))
                .toEqual({ status: 'available' });
            expect(retained.services.availability('storage'))
                .not.toMatchObject({
                    status: 'unavailable',
                    code:
                        'plugin_services_retained_generation_unavailable',
                });
            await expect(
                retained.services.storage.daemon.set(
                    'retained-generation-proof',
                    binding.immutableGenerationId,
                ),
            ).resolves.toBeUndefined();
            await expect(
                retained.services.storage.daemon.get(
                    'retained-generation-proof',
                ),
            ).resolves.toBe(
                binding.immutableGenerationId,
            );
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('projects Antigravity localharness through the canonical managed-installable adapter', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-antigravity-managed-home-'));
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            pluginIds: ['happier.agent.antigravity'],
        });
        try {
            const contribution = (runtimeRegistry.contributes.managedDependencies ?? []).find((entry) => (
                entry.pluginId === 'happier.agent.antigravity'
                && entry.definition.id === 'localharness'
            ));
            expect(contribution?.definition).toMatchObject({
                id: 'localharness',
                sources: [expect.objectContaining({
                    kind: 'managedPypiWheelAsset',
                    installId: 'dep.antigravity.localharness',
                })],
                executable: 'localharness',
            });

            const status = await runtimeRegistry.managedDependencies
                ?.bind('happier.agent.antigravity')
                .status('localharness');
            expect(status?.state).toEqual(expect.stringMatching(/^(missing|ready|updateAvailable)$/));
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps uncommitted local-trusted actions from invoking the production system-source owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-plugin-'));
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-managed-dependency-tool-'));
        const toolName = process.platform === 'win32' ? 'acme-runtime.exe' : 'acme-runtime';
        const unavailablePlatform = process.platform === 'darwin' ? 'linux' : 'macos';
        const toolPath = join(toolRoot, toolName);
        const originalPath = process.env.PATH;
        await symlink(process.execPath, toolPath);
        process.env.PATH = `${toolRoot}${delimiter}${originalPath ?? ''}`;
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.managed.runtime',
            version: '1.0.0',
            displayName: 'Managed runtime fixture',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'managed-runtime-process', capability: 'process', reason: 'Run the declared managed runtime',
                    scope: { executables: [{ kind: 'managedDependency', id: 'runtime' }] },
                }],
                optional: [],
            },
            contributes: {
                managedDependencies: [{
                    id: 'runtime', title: 'Runtime', executable: toolName,
                    sources: [{ kind: 'system', executableNames: [toolName], versionArguments: ['--version'] }],
                }, {
                    id: 'wrong-platform', title: 'Wrong platform', platforms: [unavailablePlatform], executable: toolName,
                    sources: [{ kind: 'system', executableNames: [toolName] }],
                }, {
                    id: 'manual-only', title: 'Manual dependency', executable: 'manual-only',
                    sources: [{ kind: 'manual', instructions: 'Install the dependency manually' }],
                }],
                actions: [{
                    id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe',
                    hostAccess: ['managed-runtime-process'],
                }],
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.actions.register('run', async (_input, context) => {
                const result = await context.services.exec.run({
                    executable: { kind: 'managedDependency', id: 'runtime' },
                    args: ['-e', 'process.stdout.write("production-managed-ok")']
                });
                return { stdout: new TextDecoder().decode(result.stdout) };
            });
        }`, 'utf8');
        const store = createPluginStateStore({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.managed.runtime': {
                    source: {
                        kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
                    state: { enabled: true },
                },
            },
        });

        try {
            const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            try {
                const dependencies = runtimeRegistry.managedDependencies?.bind('acme.managed.runtime');
                await expect(dependencies?.status('runtime')).resolves.toMatchObject({
                    state: 'ready', sourceId: 'acme.managed.runtime/runtime#0',
                });
                await expect(dependencies?.update('runtime')).rejects.toMatchObject({
                    code: 'plugin_managed_dependency_system_missing',
                });
                await expect(dependencies?.remove('runtime')).rejects.toMatchObject({
                    code: 'plugin_managed_dependency_system_missing',
                });
                await expect(dependencies?.status('wrong-platform')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_platform_unsupported',
                });
                await expect(dependencies?.status('manual-only')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_manual_required',
                });
                expect(runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
                    'acme.managed.runtime',
                    'run',
                )).toMatchObject({ outcome: 'unavailable', code: 'plugin_action_handler_missing' });
                await expect(runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: 'acme.managed.runtime', family: 'actions', localId: 'run',
                }])).resolves.toEqual([expect.objectContaining({
                    pluginId: 'acme.managed.runtime',
                    diagnostics: expect.arrayContaining([
                        expect.objectContaining({ code: 'plugin_source_missing' }),
                    ]),
                })]);
                const executable = await runtimeRegistry.managedDependencies?.resolveExecutable(
                    { kind: 'managedDependency', id: 'runtime' },
                    'acme.managed.runtime',
                );
                expect(executable).toMatchObject({ command: toolPath });
                executable?.release();
                await runtimeRegistry.dispose();
                await expect(dependencies?.status('runtime')).resolves.toMatchObject({
                    state: 'unsupported', code: 'plugin_managed_dependency_generation_retired',
                });
            } finally {
                await runtimeRegistry.dispose();
            }
        } finally {
            process.env.PATH = originalPath;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('materializes CodeRabbit and DeepSec bundled prompt assets once through SVC11', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-prompts-home-'));
        for (const artifact of BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS) {
            expect(() => ImmutablePluginGenerationRecordSchema.parse(artifact.record)).not.toThrow();
        }
        const admitted = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
        );
        expect(admitted?.unavailableBundledPackageNames).toEqual(new Set());
        expect([...admitted?.generations.keys() ?? []].sort()).toEqual([
            'happier.review.coderabbit',
            'happier.review.deepsec',
        ]);
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            pluginIds: ['happier.review.coderabbit', 'happier.review.deepsec'],
        });
        try {
            const deepsecRuntimeLease = runtimeRegistry.agentRuntimesByAgentId.get('deepsec');
            expect(deepsecRuntimeLease).toMatchObject({
                pluginId: 'happier.review.deepsec',
                agentId: 'deepsec',
                generation: String(runtimeRegistry.generation),
            });
            if (!deepsecRuntimeLease?.hasPrimaryRuntime) {
                throw new Error('DeepSec must register a primary Agent runtime');
            }
            const deepsecRuntime = await deepsecRuntimeLease.createRuntime({
                signal: new AbortController().signal,
            });
            expect(deepsecRuntime?.executionRuns?.open).toEqual(expect.any(Function));
            expect(deepsecRuntime?.sessions).toBeUndefined();

            const coderabbit = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'coderabbit' });
            const deepsec = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'deepsec' });
            const deepsecAudit = await runtimeRegistry.resolvePromptAssetBlocks({
                agentId: 'deepsec',
                selectedAsset: {
                    pluginId: 'happier.review.deepsec',
                    localId: 'repository-security-audit-prompt',
                },
            });
            expect(coderabbit).toEqual([{
                id: 'plugin_prompt_asset.happier.review.coderabbit/review-prompt',
                scope: 'session',
                text: await readFile(join(
                    process.cwd(),
                    '../../packages/plugins/review-coderabbit/resources/review-prompt.md',
                ), 'utf8'),
            }]);
            expect(deepsec.map((block) => block.id)).toEqual([
                'plugin_prompt_asset.happier.review.deepsec/repository-security-audit-prompt',
                'plugin_prompt_asset.happier.review.deepsec/review-prompt',
            ]);
            expect(new Set(deepsec.map((block) => block.id)).size).toBe(deepsec.length);
            expect(deepsecAudit).toEqual([{
                id: 'plugin_prompt_asset.happier.review.deepsec/repository-security-audit-prompt',
                scope: 'session',
                text: await readFile(join(
                    process.cwd(),
                    '../../packages/plugins/review-deepsec/resources/repository-security-audit-prompt.md',
                ), 'utf8'),
            }]);
            const machineKey = new Uint8Array(32).fill(11);
            const promptPlan = await resolveEffectiveCodingPromptPlan({
                credentials: {
                    token: 'token',
                    encryption: {
                        type: 'dataKey',
                        machineKey,
                        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
                    },
                },
                settings: {},
                profileId: null,
                baseOverride: 'Base prompt',
                memoryRecallGuidanceEnabled: false,
                agentId: 'coderabbit',
                promptAssetBlocks: coderabbit,
            });
            expect(promptPlan.plan.blocks.filter((block) => block.id === coderabbit[0]?.id)).toEqual([{
                ...coderabbit[0]!,
                text: coderabbit[0]!.text.trim(),
            }]);
        } finally {
            await runtimeRegistry.dispose();
        }
    });

    it('binds native Agent readiness and declared system-tool resolution through production services', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-agent-services-home-'));
        const toolRoot = await mkdtemp(join(tmpdir(), 'happier-native-agent-services-tool-'));
        const toolName = process.platform === 'win32' ? 'pi.cmd' : 'pi';
        const toolPath = join(toolRoot, toolName);
        const originalPath = process.env.PATH;
        const originalClaudePath = process.env.HAPPIER_CLAUDE_PATH;
        const originalJavaScriptRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
        await writeFile(toolPath, process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" -e "process.stdout.write(process.env.UNADMITTED_CUSTOM || process.env.PROFILE_CUSTOM || '')"\r\n`
            : '#!/usr/bin/env node\nprocess.stdout.write(process.env.UNADMITTED_CUSTOM ?? process.env.PROFILE_CUSTOM ?? "");\n', 'utf8');
        await chmod(toolPath, 0o755);
        process.env.PATH = `${toolRoot}${delimiter}${originalPath ?? ''}`;
        process.env.HAPPIER_CLAUDE_PATH = process.execPath;
        process.env.HAPPIER_JS_RUNTIME_PATH = process.execPath;

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.activatedPluginIds.has('happier.agent.pi')).toBe(false);
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'happier.agent.pi',
                family: 'agents',
                localId: 'pi',
            }]);
            expect(runtimeRegistry.activatedPluginIds.has('happier.agent.pi')).toBe(true);
            const services = await runtimeRegistry.createAgentInvocationServices({
                pluginId: 'happier.agent.pi',
                pluginVersion: '0.0.0',
                agentId: 'pi',
                generation: String(runtimeRegistry.generation),
                correlationId: 'pi-native-services',
                cwd: toolRoot,
                environment: { PROFILE_CUSTOM: 'profile-value' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(services.exec.agentCli.checkReadiness({
                candidates: ['claude'],
                requirement: 'any',
                cwd: toolRoot,
            })).resolves.toEqual({ launchable: [{ agentId: 'claude' }] });
            await expect(services.exec.systemTools.resolve({
                toolId: 'pi-cli',
                purpose: 'Run Pi',
                cwd: toolRoot,
                preferredPath: toolPath,
            })).resolves.toMatchObject({
                executable: { kind: 'systemTool', id: 'pi-cli' },
                executablePath: toolPath,
            });
            const executable = await services.exec.systemTools.resolve({
                toolId: 'pi-cli',
                purpose: 'Run Pi with the host-admitted Profile environment',
                cwd: toolRoot,
                preferredPath: toolPath,
            });
            const result = await services.exec.run({
                executable: executable.executable,
                env: { PROFILE_CUSTOM: 'profile-value' },
            });
            expect(Buffer.from(result.stdout).toString('utf8')).toBe('profile-value');
            const undeclaredOverlay = await services.exec.run({
                executable: executable.executable,
                env: { UNADMITTED_CUSTOM: 'explicit-overlay' },
            });
            expect(Buffer.from(undeclaredOverlay.stdout).toString('utf8')).toBe('explicit-overlay');
        } finally {
            await runtimeRegistry.dispose();
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
            if (originalClaudePath === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
            else process.env.HAPPIER_CLAUDE_PATH = originalClaudePath;
            if (originalJavaScriptRuntimePath === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
            else process.env.HAPPIER_JS_RUNTIME_PATH = originalJavaScriptRuntimePath;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(toolRoot, { recursive: true, force: true });
        }
    });

    it('routes dynamic and discovered MCP servers through the bound native session owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-mcp-session-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-mcp-session-plugin-'));
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.mcp.session',
            version: '1.0.0',
            displayName: 'Session MCP fixture',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'session-tools-access',
                    capability: 'mcp',
                    reason: 'Use the session MCP server',
                    scope: { serverRefs: ['session-tools'], operations: ['listTools', 'callTools'] },
                }],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'session-agent', title: 'Session agent', runtime: { kind: 'custom' }, primary: 'sessions',
                    capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                }],
                mcp: {
                    servers: [{ id: 'session-tools', title: 'Session tools', kind: 'dynamic', sessionScope: 'session' }],
                    discoverySources: [{ id: 'pi-synthetic', title: 'Pi discovery' }],
                },
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'agentRuntime.mjs'), `export const sessionAgentRuntimeFactory = () => ({
            async dispose() {},
            sessions: {
                async open(request) {
                    return {
                        async send() { return { status: 'admitted' }; },
                        watch() { return { dispose() {} }; },
                        async dispose() {},
                        sessionId: request.sessionId
                    };
                }
            }
        });`, 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `import { sessionAgentRuntimeFactory } from './agentRuntime.mjs';
        export function activate(api) {
            api.agents.register('session-agent', sessionAgentRuntimeFactory, {
                sessionRunnerFactory: {
                    module: './agentRuntime.mjs',
                    export: 'sessionAgentRuntimeFactory',
                    runtimeApiVersion: 1
                }
            });
            api.mcp.registerServer('session-tools', {
                async dispose() {},
                async listTools() {
                    return { items: [{ name: 'confirm', inputSchema: { type: 'object' } }] };
                },
                async callTool(_request, context) {
                    const result = await context.services.interactions.confirm({
                        kind: 'confirmation',
                        message: 'Run the session MCP tool?'
                    });
                    return { confirmed: result.status === 'approved' };
                },
                async listResources() {
                    return { items: [{ uri: 'file:///guide.md', name: 'guide', mimeType: 'text/markdown' }] };
                },
                async listResourceTemplates() {
                    return { items: [{ uriTemplate: 'file:///{path}', name: 'file' }] };
                },
                async readResource(request) {
                    return { contents: [
                        { uri: request.uri, mimeType: 'text/markdown', text: '# Guide' },
                        { uri: 'file:///image.png', mimeType: 'image/png', blob: 'aW1hZ2U=' }
                    ] };
                },
                async subscribeResource(request, listener) {
                    queueMicrotask(() => listener({ uri: request.uri }));
                    return { async dispose() {} };
                },
                async listPrompts() {
                    return { items: [{ name: 'review', arguments: [{ name: 'scope', required: true }] }] };
                },
                async getPrompt(request) {
                    return { messages: [{ role: 'user', content: { type: 'text', text: 'Review ' + request.args.scope } }] };
                }
            });
            api.mcp.registerDiscoverySource('pi-synthetic', async (_input, context) => {
                const service = await context.services.managedServices.supervise({
                    id: 'pi-docs',
                    mode: {
                        kind: 'attach',
                        baseUrl: 'http://127.0.0.1:4312'
                    },
                    healthCheck: { kind: 'none' }
                }, { signal: context.signal });
                const snapshot = await service.waitUntilHealthy({ signal: context.signal });
                if (snapshot.state !== 'healthy' || snapshot.baseUrl === null) {
                    throw new Error('Managed MCP service did not publish a healthy endpoint');
                }
                return {
                    items: [{
                        provider: { pluginId: 'acme.mcp.session', localId: 'pi-synthetic' },
                        discoveryId: 'pi.docs',
                        title: 'Discovered docs'
                    }],
                    endpoints: [{
                        id: 'pi.docs',
                        name: 'discovered-docs',
                        kind: 'http',
                        url: new URL('/mcp', snapshot.baseUrl).toString()
                    }]
                };
            });
        }`, 'utf8');
        const paths = resolvePluginStorePaths({ happyHomeDir });
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.mcp.session',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                    resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: { status: 'unknown', diagnostics: [] },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.mcp.session',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                }),
                state: { enabled: true },
            },
        });
        const handleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
        const cleanupWarning = vi.spyOn(logger, 'warn');
        let projectedUrlAfterRegistryDispose: string | null = null;

        try {
            const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            try {
                expect(runtimeRegistry.contributes.mcpDiscoverySources).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        pluginId: 'acme.mcp.session',
                        definition: expect.objectContaining({ id: 'pi-synthetic' }),
                    }),
                ]));
                const discovery = await runtimeRegistry.discoverMcpServersForDetection?.({
                    pluginId: 'acme.mcp.session',
                    localId: 'pi-synthetic',
                    input: {
                        sessionId: 'mcp-detection',
                        directory: pluginRoot,
                    },
                    signal: new AbortController().signal,
                });
                expect(discovery).toEqual({
                    endpoints: [{
                        id: 'pi.docs',
                        name: 'discovered-docs',
                        kind: 'http',
                        url: 'http://127.0.0.1:4312/mcp',
                    }],
                    warnings: [],
                });
                await runtimeRegistry.activateContributionsOnDemand([{
                    pluginId: 'acme.mcp.session',
                    family: 'agents',
                    localId: 'session-agent',
                }]);
                expect(runtimeRegistry.agentRuntimesByAgentId.get('acme.mcp.session/session-agent')).toMatchObject({
                    pluginId: 'acme.mcp.session',
                    agentId: 'acme.mcp.session/session-agent',
                    generation: String(runtimeRegistry.generation),
                });
                const currentSessionUi = createNativeAgentCurrentSessionUiServices({
                    permissionHandler: { handleToolCall },
                    pluginId: 'acme.mcp.session',
                    contributionId: 'session-agent',
                    runtimeId: 'session-agent',
                    sessionId: 'session-1',
                    generationId: String(runtimeRegistry.generation),
                    interactionDeadlineMs: 1_000,
                    isCurrent: () => true,
                    signal: new AbortController().signal,
                });
                const services = await runtimeRegistry.createAgentInvocationServices({
                    pluginId: 'acme.mcp.session',
                    pluginVersion: '1.0.0',
                    agentId: 'session-agent',
                    generation: String(runtimeRegistry.generation),
                    correlationId: 'session-1',
                    cwd: pluginRoot,
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                    session: { id: 'session-1', current: currentSessionUi },
                });
                const client = await services.mcp.connect(
                    { pluginId: 'acme.mcp.session', localId: 'session-tools' },
                    { sessionId: 'session-1', elicitation: { mode: 'hostMediated', sessionId: 'session-1' } },
                );

                await expect(client.callTool('confirm', {})).resolves.toEqual({ confirmed: true });
                await expect(client.listResources()).resolves.toMatchObject({ items: [{ name: 'guide' }] });
                await expect(client.listResourceTemplates()).resolves.toMatchObject({ items: [{ name: 'file' }] });
                await expect(client.readResource('file:///guide.md')).resolves.toMatchObject({
                    contents: [{ text: '# Guide' }, { blob: 'aW1hZ2U=' }],
                });
                await expect(client.listPrompts()).resolves.toMatchObject({ items: [{ name: 'review' }] });
                await expect(client.getPrompt('review', { scope: 'src' })).resolves.toMatchObject({
                    messages: [{ role: 'user', content: { text: 'Review src' } }],
                });
                const resourceUpdates: string[] = [];
                const resourceSubscription = await client.subscribeResource('file:///guide.md', ({ uri }) => {
                    resourceUpdates.push(uri);
                });
                await vi.waitFor(() => expect(resourceUpdates).toEqual(['file:///guide.md']));
                await resourceSubscription.dispose();
                expect(handleToolCall).toHaveBeenCalledWith(
                    expect.any(String),
                    'AgentConfirmation',
                    expect.objectContaining({ message: 'Run the session MCP tool?' }),
                    expect.objectContaining({
                        owner: {
                            kind: 'plugin',
                            pluginId: 'acme.mcp.session',
                            runtimeId: 'acme.mcp.session/mcp.servers/session-tools',
                        },
                    }),
                );
                const agentContribution = runtimeRegistry.contributes.agentDefinitionsById.get('acme.mcp.session/session-agent');
                if (!agentContribution) throw new Error('Expected session Agent contribution');
                const backendContribution = {
                    id: 'session-agent',
                    agentId: 'session-agent',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'session-agent',
                        agentId: 'session-agent',
                    },
                    runtimeKind: 'custom',
                    pluginId: 'acme.mcp.session',
                } satisfies ResolvedAgentRuntimeContribution;
                const createHostOwners = (
                    permissionHandlerOverride: Readonly<{
                        handleToolCall: ProviderEnforcedPermissionHandler['handleToolCall'];
                    }>,
                ) => {
                    const session = createMutableApiSessionClientFixture({
                        overrides: { sessionId: 'session-1' },
                    });
                    const permissionHandler = createProviderEnforcedPermissionHandler({
                        session,
                        logPrefix: '[Session MCP integration]',
                    });
                    vi.spyOn(permissionHandler, 'handleToolCall')
                        .mockImplementation(permissionHandlerOverride.handleToolCall);
                    const hostRuntimeParams = {
                        directory: pluginRoot,
                        metadata: createTestMetadata({ path: pluginRoot }),
                        machineId: 'machine-1',
                        agentTargetKey: 'backend:session-agent',
                        session,
                        transcriptSession: session,
                        messageBuffer: new MessageBuffer(),
                        accountSettings: accountSettingsParse({
                            mcpServersSettingsV1: {
                                v: 1,
                                strictMode: false,
                                servers: [{
                                    id: 'pi.docs',
                                    name: 'discovered-docs',
                                    transport: 'http',
                                    remote: { url: 'https://mcp.example.test/discovered', headers: {} },
                                    env: {},
                                    createdAt: 1,
                                    updatedAt: 1,
                                }],
                                bindings: [{
                                    id: 'pi.docs-binding',
                                    serverId: 'pi.docs',
                                    enabled: true,
                                    target: { t: 'allMachines' },
                                    createdAt: 1,
                                    updatedAt: 1,
                                }],
                            },
                        }),
                        permissionHandler,
                        mcpServers: {},
                        getPermissionMode: () => 'default' as const,
                        setThinking: () => undefined,
                        memoryRecallGuidanceEnabled: false,
                        runnerProcessIdentity: null,
                        startupModelSelection: null,
                        runWithTerminalModelSelection: async (effect) => ({
                            status: 'completed',
                            value: await effect(null, async (localEffect) => ({
                                status: 'completed',
                                value: await localEffect(),
                            })),
                        }),
                    } satisfies HostSessionRuntimeFactoryParams;
                    return createNativeAgentSessionHostServiceOwners({
                        runtimeRegistry,
                        identity: {
                            pluginId: 'acme.mcp.session',
                            pluginVersion: '1.0.0',
                            agentId: 'session-agent',
                            generation: String(runtimeRegistry.generation),
                            isCurrent: () => true,
                        },
                        backend: backendContribution,
                        agent: agentContribution,
                        hostRuntimeParams,
                        sessionId: 'session-1',
                        directory: pluginRoot,
                        signal: new AbortController().signal,
                    });
                };
                const hostOwners = createHostOwners({ handleToolCall });
                const projected = await hostOwners.mcp.resolveForSession({
                    sessionId: 'session-1',
                    directory: pluginRoot,
                });
                expect(projected).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        id: 'acme.mcp.session/session-tools',
                        transport: {
                            kind: 'http',
                            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
                        },
                        scope: { sessionId: 'session-1', directory: pluginRoot },
                    }),
                    expect.objectContaining({
                        id: 'pi.docs',
                        name: 'discovered-docs',
                        transport: {
                            kind: 'http',
                            url: 'https://mcp.example.test/discovered',
                        },
                        scope: { sessionId: 'session-1', directory: pluginRoot },
                    }),
                ]));
                expect(projected).toHaveLength(2);
                const projectedDynamic = projected?.find((server) => (
                    server.id === 'acme.mcp.session/session-tools'
                ));
                const projectedUrl = projectedDynamic?.transport.kind === 'http'
                    ? projectedDynamic.transport.url
                    : null;
                if (!projectedUrl) throw new Error('Expected hosted MCP session projection');
                projectedUrlAfterRegistryDispose = projectedUrl;
                const projectedClient = new Client(
                    { name: 'happier-mcp-session-integration', version: '1.0.0' },
                    { capabilities: {} },
                );
                await projectedClient.connect(new StreamableHTTPClientTransport(new URL(projectedUrl)));
                const projectedTools = await projectedClient.listTools();
                expect(projectedTools.tools).toEqual([
                    expect.objectContaining({
                        name: expect.stringMatching(/^happier\.proxy_[a-f0-9]{24}$/),
                    }),
                ]);
                await expect(projectedClient.callTool({
                    name: projectedTools.tools[0]!.name,
                    arguments: {},
                })).resolves.toEqual({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ confirmed: true }),
                    }],
                });
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await projectedClient.close();
                await hostOwners.dispose();
                await expect(fetch(projectedUrl, {
                    signal: AbortSignal.timeout(1_000),
                })).rejects.toBeInstanceOf(Error);

                const reboundHandleToolCall = vi.fn(async () => ({ decision: 'approved' as const }));
                const reboundHostOwners = createHostOwners({
                    handleToolCall: reboundHandleToolCall,
                });
                const reboundProjected = await reboundHostOwners.mcp.resolveForSession({
                    sessionId: 'session-1',
                    directory: pluginRoot,
                });
                const reboundDynamic = reboundProjected.find((server) => (
                    server.id === 'acme.mcp.session/session-tools'
                ));
                const reboundProjectedUrl = reboundDynamic?.transport.kind === 'http'
                    ? reboundDynamic.transport.url
                    : null;
                if (!reboundProjectedUrl) throw new Error('Expected rebound hosted MCP session projection');
                expect(reboundProjectedUrl).not.toBe(projectedUrl);
                const reboundProjectedClient = new Client(
                    { name: 'happier-mcp-session-rebound-integration', version: '1.0.0' },
                    { capabilities: {} },
                );
                await reboundProjectedClient.connect(new StreamableHTTPClientTransport(new URL(reboundProjectedUrl)));
                const reboundTools = await reboundProjectedClient.listTools();
                await expect(reboundProjectedClient.callTool({
                    name: reboundTools.tools[0]!.name,
                    arguments: {},
                })).resolves.toEqual({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ confirmed: true }),
                    }],
                });
                expect(reboundHandleToolCall).toHaveBeenCalledOnce();
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await reboundProjectedClient.close();

                const committedBeforeRevocation = await readPluginRegistryCommitRecord(paths);
                if (!committedBeforeRevocation) throw new Error('Expected current MCP fixture commit before revocation');
                const remainingPluginGenerations = { ...committedBeforeRevocation.pluginGenerations };
                delete remainingPluginGenerations['acme.mcp.session'];
                await replacePluginRegistryCommitRecord({
                    paths,
                    expectedCurrent: committedBeforeRevocation,
                    next: {
                        ...committedBeforeRevocation,
                        revision: committedBeforeRevocation.revision + 1,
                        transactionId: 'mcp-session-runtime-revocation',
                        baseRevision: committedBeforeRevocation.revision,
                        pluginGenerations: remainingPluginGenerations,
                        createdAtMs: 2,
                    },
                });
                runtimeRegistry.retirePluginConsumers?.(['acme.mcp.session']);

                await expect(client.callTool('confirm', {})).rejects.toMatchObject({
                    code: 'plugin_mcp_generation_retired',
                });
                expect(handleToolCall).toHaveBeenCalledTimes(2);
                await client.dispose();
                await reboundHostOwners.dispose();
            } finally {
                await runtimeRegistry.dispose();
            }
            if (!projectedUrlAfterRegistryDispose) throw new Error('Expected hosted MCP cleanup endpoint');
            await expect(fetch(projectedUrlAfterRegistryDispose, {
                signal: AbortSignal.timeout(1_000),
            })).rejects.toBeInstanceOf(Error);
            expect(cleanupWarning.mock.calls.some(([message]) => (
                message === '[PLUGIN RUNTIME] Plugin cleanup step failed during disposal'
            ))).toBe(false);
        } finally {
            cleanupWarning.mockRestore();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('binds all five selected resource kinds through real prompt and external-action consumers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-home-'));
        const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-source-'));
        const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        const manifest = {
            schemaVersion: 2,
            id: 'acme.resource.action',
            version: '1.0.0',
            displayName: 'Resource action',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'read-prompt', title: 'Read prompt', scopes: ['global'], surfaces: ['cli'],
                    execution: { target: 'daemon' },
                    placementBindings: ['primary'], dangerLevel: 'safe',
                }, {
                    id: 'open-client-preview', title: 'Open client preview', scopes: ['session'], surfaces: ['ui'],
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: 'client-preview',
                            modulePath: './client-preview',
                            exportName: 'activatePreview',
                        },
                        platforms: ['web'],
                    },
                    placementBindings: ['detailsPanel'], dangerLevel: 'safe',
                }],
                resources: [
                    { id: 'shared', kind: 'prompt', path: './resources/shared.txt', contentType: 'text/plain' },
                    { id: 'review-skill', kind: 'skill', path: './resources/review-skill.md', contentType: 'text/markdown' },
                    { id: 'report-template', kind: 'template', path: './resources/report-template.md', contentType: 'text/markdown' },
                    { id: 'preview-icon', kind: 'asset', path: './resources/preview-icon.svg', contentType: 'image/svg+xml' },
                    { id: 'defaults', kind: 'config', path: './resources/defaults.json', contentType: 'application/json' },
                ],
                agents: [{
                    id: 'novel-reviewer', title: 'Novel reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
                    capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                }],
                promptAssets: [{
                    id: 'committed-instructions', kind: 'systemPrompt', resource: 'shared',
                    target: { kind: 'agent', agent: 'novel-reviewer' }, priority: 4,
                }],
            },
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        const agentRuntimeBytes = Buffer.from(`export const novelReviewerRuntimeFactory = () => ({
            sessions: {
                async open(request) {
                    return {
                        async send() { return { status: 'admitted' }; },
                        watch() { return { dispose() {} }; },
                        async dispose() {},
                        sessionId: request.sessionId
                    };
                }
            }
        });`, 'utf8');
        const daemonBytes = Buffer.from(`import { novelReviewerRuntimeFactory } from './agentRuntime.mjs';
        export function activate(api) {
            api.agents.register('novel-reviewer', novelReviewerRuntimeFactory, {
                sessionRunnerFactory: {
                    module: './agentRuntime.mjs',
                    export: 'novelReviewerRuntimeFactory',
                    runtimeApiVersion: 1
                }
            });
            api.actions.register('read-prompt', async (_input, context) => {
                const ids = ['shared', 'review-skill', 'report-template', 'preview-icon', 'defaults'];
                const resources = await Promise.all(ids.map(async (id) => {
                    const result = await context.services.resources.read(id);
                    return {
                        id,
                        kind: result.kind,
                        text: new TextDecoder().decode(result.bytes),
                        digest: result.digest
                    };
                }));
                return {
                    availability: context.services.availability('resources').status,
                    resources
                };
            });
        }`, 'utf8');
        const promptBytes = Buffer.from('committed prompt bytes', 'utf8');
        const resourceBytesByPath = {
            'resources/defaults.json': Buffer.from('{"tone":"concise"}', 'utf8'),
            'resources/preview-icon.svg': Buffer.from('<svg/>', 'utf8'),
            'resources/report-template.md': Buffer.from('# Report template', 'utf8'),
            'resources/review-skill.md': Buffer.from('# Review skill', 'utf8'),
            'resources/shared.txt': promptBytes,
        } as const;
        await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
        await mkdir(join(sourceRoot, 'resources'), { recursive: true });
        await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), manifestBytes);
        await writeFile(join(sourceRoot, 'daemon.mjs'), daemonBytes);
        await writeFile(join(sourceRoot, 'agentRuntime.mjs'), agentRuntimeBytes);
        await Promise.all(Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => (
            writeFile(join(sourceRoot, relativePath), bytes)
        )));

        const paths = resolvePluginStorePaths({ happyHomeDir });
        const immutableGenerationId = 'acme-resource-generation-1';
        const generationRecord = {
            sourceProvenance: 'registryCustodied' as const,
            t: 'happier_plugin_generation_v1' as const, schemaVersion: 1 as const,
            pluginId: 'acme.resource.action', immutableGenerationId,
            createdAtMs: 1,
            files: [
                { relativePath: '.happier-plugin/plugin.json', byteLength: manifestBytes.byteLength },
                { relativePath: 'agentRuntime.mjs', byteLength: agentRuntimeBytes.byteLength },
                { relativePath: 'daemon.mjs', byteLength: daemonBytes.byteLength },
                ...Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => ({
                    relativePath,
                    byteLength: bytes.byteLength,
                })),
            ],
            manifestRelativePath: '.happier-plugin/plugin.json',
        };
        const store = createPluginStateStore({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: sourceRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: sourceRoot,
                        manifestPath: join(sourceRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: sourceRoot,
                        manifestVersion: '1.0.0',
                    }),
                    state: { enabled: true },
                },
            },
        });
        // Bootstrap the canonical installation revision before preparing bytes.
        // Otherwise startup cleanup correctly removes an as-yet unreferenced
        // immutable generation while the fixture is still assembling it.
        const prepared = await prepareImmutablePluginGeneration({
            paths,
            sourceRootPath: sourceRoot,
            record: generationRecord,
        });
        const immutableRoot = prepared.rootPath;
        const seededCommit = await readPluginRegistryCommitRecord(paths);
        if (!seededCommit) throw new Error('Expected canonical resource-action fixture commit');
        await replacePluginRegistryCommitRecord({
            paths,
            expectedCurrent: seededCommit,
            next: {
                ...seededCommit,
                revision: seededCommit.revision + 1,
                transactionId: 'resource-runtime-commit',
                baseRevision: seededCommit.revision,
                pluginGenerations: { 'acme.resource.action': prepared.reference },
                createdAtMs: 1,
                creator: { pid: 42, instanceId: 'daemon-a' },
            },
        });

        const generationBRoot = await mkdtemp(join(tmpdir(), 'happier-resource-runtime-generation-b-'));
        const generationBManifest = { ...manifest, version: '2.0.0', displayName: 'Resource action B' };
        const generationBManifestBytes = Buffer.from(JSON.stringify(generationBManifest), 'utf8');
        await mkdir(join(generationBRoot, '.happier-plugin'), { recursive: true });
        await mkdir(join(generationBRoot, 'resources'), { recursive: true });
        await writeFile(join(generationBRoot, '.happier-plugin', 'plugin.json'), generationBManifestBytes);
        await writeFile(join(generationBRoot, 'daemon.mjs'), daemonBytes);
        await writeFile(join(generationBRoot, 'agentRuntime.mjs'), agentRuntimeBytes);
        await Promise.all(Object.entries(resourceBytesByPath).map(([relativePath, bytes]) => (
            writeFile(join(generationBRoot, relativePath), relativePath === 'resources/shared.txt' ? 'generation B bytes' : bytes)
        )));
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: generationBRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: generationBRoot,
                        manifestPath: join(generationBRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: generationBRoot,
                        manifestVersion: '2.0.0',
                    }),
                    state: { enabled: true },
                },
            },
        });
        const generationBContributes = await resolveMergedContributionRegistry({ happyHomeDir });
        await store.write({
            t: 'happier_plugin_state_v1', schemaVersion: 1,
            plugins: {
                'acme.resource.action': {
                    source: {
                        kind: 'path', locator: immutableRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                        resolvedPath: immutableRoot,
                        manifestPath: join(immutableRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: 'acme.resource.action',
                        sourceRootPath: immutableRoot,
                        manifestVersion: '1.0.0',
                    }),
                    state: { enabled: true },
                },
            },
        });
        const resourceCommit = await readPluginRegistryCommitRecord(paths);
        if (!resourceCommit) throw new Error('Expected current resource-action fixture commit');
        const resourceInstallationState = await readInstallationStateRevision({
            paths,
            reference: resourceCommit.installationState,
        });
        const installationState = await persistInstallationStateRevision({
            paths,
            state: {
                ...resourceInstallationState,
                revisionId: 'resource-runtime-state',
                createdAtMs: generationRecord.createdAtMs,
            },
        });
        await replacePluginRegistryCommitRecord({
            paths,
            expectedCurrent: resourceCommit,
            next: {
                ...resourceCommit,
                revision: resourceCommit.revision + 1,
                transactionId: 'resource-runtime-health-commit',
                baseRevision: resourceCommit.revision,
                installationState,
                createdAtMs: generationRecord.createdAtMs,
            },
        });
        const canonicalContributes = await resolveMergedContributionRegistry({ happyHomeDir });
        const scopedContributes = {
            ...canonicalContributes,
            resources: canonicalContributes.resources.filter((entry) => entry.pluginId !== 'acme.resource.action'),
            promptAssets: canonicalContributes.promptAssets?.filter((entry) => entry.pluginId !== 'acme.resource.action'),
            activationTargets: canonicalContributes.activationTargets.filter((entry) => entry.pluginId !== 'acme.resource.action'),
        };
        const scopedRuntime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: scopedContributes,
            pluginIds: [],
        });
        await scopedRuntime.dispose();

        let mismatchedRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        let mismatchError: unknown;
        try {
            mismatchedRuntime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: generationBContributes,
            });
        } catch (error) {
            mismatchError = error;
        } finally {
            await mismatchedRuntime?.dispose();
        }
        expect(mismatchError).toEqual(expect.objectContaining({
            message: expect.stringMatching(/committed.*(activation|runtime).*identity/i),
        }));

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.pluginFinalPolicyCurrentGenerationsById?.get('acme.resource.action'))
                .toMatchObject({
                    immutableGenerationId: generationRecord.immutableGenerationId,
                    applied: false,
                });
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.resource.action',
                family: 'agents',
                localId: 'novel-reviewer',
            }]);
            expect(runtimeRegistry.pluginFinalPolicyCurrentGenerationsById?.get('acme.resource.action'))
                .toMatchObject({
                    immutableGenerationId: generationRecord.immutableGenerationId,
                    applied: true,
                });
            expect(runtimeRegistry.targetActionInvocations?.has(
                'acme.resource.action',
                'open-client-preview',
            )).toBe(false);
            expect(runtimeRegistry.resolveActionPresentUserGatePolicy?.(
                'acme.resource.action',
                'open-client-preview',
            )).toMatchObject({
                qualifiedId: 'acme.resource.action/actions/open-client-preview',
                authorization: {
                    generation: {
                        targetGeneration: generationRecord.immutableGenerationId,
                        desiredGeneration: generationRecord.immutableGenerationId,
                        appliedGeneration: generationRecord.immutableGenerationId,
                        targetGenerationMode: 'current',
                    },
                    serviceAvailability: [],
                },
            });
            expect(runtimeRegistry.agentRuntimesByAgentId.get('acme.resource.action/novel-reviewer')).toMatchObject({
                generation: String(runtimeRegistry.generation),
                immutableGenerationId,
            });
            const promptAssetBlocks = await runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'acme.resource.action/novel-reviewer' });
            const machineKey = new Uint8Array(32).fill(9);
            const promptPlan = await resolveEffectiveCodingPromptPlan({
                credentials: {
                    token: 'token',
                    encryption: { type: 'dataKey', machineKey, publicKey: deriveBoxPublicKeyFromSeed(machineKey) },
                },
                settings: {}, profileId: null, baseOverride: 'Base prompt', memoryRecallGuidanceEnabled: false,
                agentId: 'novel-reviewer', promptAssetBlocks,
            });
            expect(promptAssetBlocks).toEqual([{
                id: 'plugin_prompt_asset.acme.resource.action/committed-instructions',
                scope: 'session',
                text: 'committed prompt bytes',
            }]);
            expect(promptPlan.plan.blocks.filter((block) => block.id === promptAssetBlocks[0]?.id)).toEqual(promptAssetBlocks);
            await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.resource.action', family: 'actions', localId: 'read-prompt',
            }]);
            expect(runtimeRegistry.targetActionInvocations?.evaluateCatalogPolicy(
                'acme.resource.action',
                'read-prompt',
            )).toMatchObject({ outcome: 'visible', code: 'plugin_action_available' });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    availability: 'available',
                    resources: [
                        { id: 'shared', kind: 'prompt', text: 'committed prompt bytes', digest: digest(promptBytes) },
                        { id: 'review-skill', kind: 'skill', text: '# Review skill', digest: digest(resourceBytesByPath['resources/review-skill.md']) },
                        { id: 'report-template', kind: 'template', text: '# Report template', digest: digest(resourceBytesByPath['resources/report-template.md']) },
                        { id: 'preview-icon', kind: 'asset', text: '<svg/>', digest: digest(resourceBytesByPath['resources/preview-icon.svg']) },
                        { id: 'defaults', kind: 'config', text: '{"tone":"concise"}', digest: digest(resourceBytesByPath['resources/defaults.json']) },
                    ],
                },
            });
            await writeFile(
                join(immutableRoot, 'resources', 'shared.txt'),
                Buffer.alloc(promptBytes.byteLength, 'x'),
            );
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'failed',
                code: 'plugin_resource_integrity_mismatch',
            });
            await writeFile(join(immutableRoot, 'resources', 'shared.txt'), promptBytes);
            const currentCommit = await readPluginRegistryCommitRecord(paths);
            if (!currentCommit) throw new Error('Expected current resource-action commit');
            await replacePluginRegistryCommitRecord({
                paths,
                expectedCurrent: currentCommit,
                next: {
                    ...currentCommit,
                    revision: currentCommit.revision + 1,
                    transactionId: 'resource-runtime-replacement',
                    baseRevision: currentCommit.revision,
                    createdAtMs: 2,
                    creator: { pid: 42, instanceId: 'daemon-a' },
                    pluginGenerations: {},
                },
            });
            await expect(runtimeRegistry.resolvePromptAssetBlocks({ agentId: 'acme.resource.action/novel-reviewer' }))
                .rejects.toMatchObject({ code: 'plugin_generation_stale' });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.resource.action', localId: 'read-prompt', input: {}, surface: 'cli',
            })).resolves.toEqual({
                status: 'failed',
                code: 'plugin_generation_stale',
                message: 'Plugin generation is stale',
            });
            runtimeRegistry.retirePluginConsumers?.(['acme.resource.action']);
        } finally {
            await runtimeRegistry.dispose();
        }
    });

    it('demands and re-reads a novel qualified connected-account runtime through the host registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-account-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-connected-account-plugin-'));
        const fetchMock = vi.fn(async (
            _input: string | URL | Request,
        ) => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
            schemaVersion: 2,
            id: 'acme.novel.accounts',
            version: '1.0.0',
            displayName: 'Novel accounts',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'provider-api',
                    capability: 'network',
                    reason: 'Call the configured provider API',
                    scope: {
                        targets: [{
                            kind: 'connectedAccountOrigin',
                            service: 'same-local-id',
                        }],
                        methods: ['POST'],
                    },
                }],
                optional: [],
            },
            contributes: {
                connectedAccountDescriptors: [{
                    id: 'same-local-id',
                    title: 'Novel account',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{
                            id: 'manual',
                            kind: 'manual',
                            outcomeReconciliation: 'none',
                            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                            configuration: {
                                scope: 'service',
                                changeBehavior: 'refresh',
                                fields: [{
                                    id: 'api-origin',
                                    title: 'API origin',
                                    schema: { type: 'string', minLength: 1 },
                                    required: true,
                                    semantic: 'connectedAccountOrigin',
                                }],
                            },
                        }],
                    },
                }],
            },
        }), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.connectedAccounts.register('same-local-id', {
                authentication: { modes: { manual: { kind: 'manual', async complete(_input, context) {
                    const origin = context.configuration.values['api-origin'];
                    const response = await context.services.http.request({
                        url: origin + '/session',
                        method: 'POST',
                        redirect: 'error'
                    });
                    if (response.status !== 200) return { status: 'unavailable', diagnostic: { code: 'fixture_http', severity: 'error' } };
                    return { status: 'connected', accountId: 'novel-1', displayName: 'Novel account', scopes: [] };
                } } } },
                async refresh() { return { status: 'unavailable' }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async status() { return { status: 'connected', displayName: 'Novel account' }; },
                async materialize() { return { kind: 'environment', env: {} }; }
            });
        }`, 'utf8');
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.novel.accounts',
            sourceRootPath: pluginRoot,
            plugin: {
                source: {
                    kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                    resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                },
                compatibility: { status: 'unknown', diagnostics: [] },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.novel.accounts',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                }),
                state: { enabled: true },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        try {
            expect(runtimeRegistry.activatedPluginIds.has('acme.novel.accounts')).toBe(false);
            const lease = await runtimeRegistry.resolveConnectedAccountRuntime!({
                pluginId: 'acme.novel.accounts', localId: 'same-local-id',
            });
            if (!lease) throw new Error('Expected a resolvable connected-account lease');
            expect(runtimeRegistry.activatedPluginIds.has('acme.novel.accounts')).toBe(true);
            expect(lease).toMatchObject({
                ref: { pluginId: 'acme.novel.accounts', localId: 'same-local-id' },
                descriptor: {
                    id: 'same-local-id',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{ id: 'manual', kind: 'manual' }],
                    },
                },
            });
            expect(await lease.runtime.status({} as never)).toMatchObject({ displayName: 'Novel account' });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                target: Object.freeze({
                    kind: 'service',
                    service: lease.ref,
                    modeId: 'manual',
                }),
                revision: 'configuration-1',
                values: Object.freeze({
                    'api-origin': 'https://tenant.example.test',
                }),
                getSecret: async () => null,
            });
            const attemptCredentials = Object.freeze({
                get: async () => null,
                set: async () => undefined,
                delete: async () => undefined,
            });
            const invoke = async (
                isConfigurationCurrent: (
                    snapshot: PluginConnectedAccountRuntimeConfiguration,
                ) => boolean | Promise<boolean>,
            ) => await runtimeRegistry.connectedAccountRuntimeInvoker?.invokeAuthentication({
                admission: Object.freeze({
                    service: lease.ref,
                    descriptor: lease.descriptor.authentication.modes[0]!,
                    modeId: 'manual',
                    generation: lease.generation,
                    immutableGenerationId: lease.immutableGenerationId,
                }),
                operation: Object.freeze({
                    kind: 'submitManual',
                    fields: Object.freeze({ token: 'novel-token' }),
                }),
                context: Object.freeze({
                    service: lease.ref,
                    attempt: Object.freeze({
                        kind: 'connect',
                        attemptId: 'novel-attempt-1',
                    }),
                    configuration,
                    attemptCredentials,
                }),
                isConfigurationCurrent,
                signal: new AbortController().signal,
            });
            await expect(invoke(() => true)).resolves.toMatchObject({
                status: 'connected',
                accountId: 'novel-1',
            });
            expect(fetchMock).toHaveBeenCalledOnce();
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
                'https://tenant.example.test/session',
            );

            let currentnessChecks = 0;
            let releaseFinalCheck!: () => void;
            const finalCheckReleased = new Promise<void>((resolve) => {
                releaseFinalCheck = resolve;
            });
            let notifyFinalCheck!: () => void;
            const finalCheckStarted = new Promise<void>((resolve) => {
                notifyFinalCheck = resolve;
            });
            let configurationCurrent = true;
            const staleInvocation = invoke(async () => {
                currentnessChecks += 1;
                if (currentnessChecks === 2) {
                    notifyFinalCheck();
                    await finalCheckReleased;
                }
                return configurationCurrent;
            });
            await finalCheckStarted;
            configurationCurrent = false;
            releaseFinalCheck();
            await expect(staleInvocation).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(fetchMock).toHaveBeenCalledOnce();
            const introspection = adaptTargetActivationFacts({
                generation: runtimeRegistry.generation!,
                candidates: runtimeRegistry.contributes.introspectionContributions ?? [],
                plugins: runtimeRegistry.contributes.activationTargets.map((target) => ({
                    pluginId: target.pluginId,
                    pluginVersion: target.manifest.version,
                    source: mapPluginSourceToDiagnosticSource(target.sourceSpec),
                })),
                targetActivationFacts: runtimeRegistry.targetActivationFacts ?? [],
                runtimeState: 'current',
            });
            expect(introspection.runtimeFactsByQualifiedId.get(
                'acme.novel.accounts/connectedAccountDescriptors/same-local-id',
            )).toMatchObject({
                registration: { requirement: 'required', state: 'bound' },
                activation: { state: 'active' },
            });
        } finally {
            await runtimeRegistry.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('demands and re-reads an exact current cross-plugin notification channel from a stable action service', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const actionRoot = await mkdtemp(join(tmpdir(), 'happier-notification-action-'));
        const channelRoot = await mkdtemp(join(tmpdir(), 'happier-notification-channel-'));
        const invocationLogRecords: Readonly<Record<string, unknown>>[] = [];
        const endpointSettingId = notificationChannelSettingFieldId('external', 'endpoint');
        const tokenSecretId = notificationChannelSettingFieldId('external', 'webhook-token');
        const accountSecretId = 'notification-webhook-secret';
        const accountSecretBindingKey = JSON.stringify([
            'acme.notification.channel',
            'account',
            tokenSecretId,
        ]);
        const setNotificationAccountSnapshot = (params: Readonly<{
            token: string | null;
            version: number;
            policy: Readonly<Record<string, unknown>>;
        }>): void => {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    attentionDeliveryPolicyV1: params.policy,
                    ...(params.token === null ? {} : {
                        secrets: [{
                            id: accountSecretId,
                            name: 'Notification webhook token',
                            kind: 'other',
                            encryptedValue: {
                                _isSecretValue: true,
                                value: params.token,
                            },
                            createdAt: 1,
                            updatedAt: params.version,
                        }],
                        pluginSecretBindingsV1: {
                            [accountSecretBindingKey]: {
                                pluginId: 'acme.notification.channel',
                                custody: 'account',
                                localId: tokenSecretId,
                                savedSecretId: accountSecretId,
                                createdForBinding: true,
                            },
                        },
                    }),
                }),
                settingsVersion: params.version,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: 'notification-integration',
            });
        };
        const materialize = async (root: string, manifest: object, daemonSource: string) => {
            const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
            const daemonBytes = Buffer.from(daemonSource, 'utf8');
            await mkdir(join(root, '.happier-plugin'), { recursive: true });
            await writeFile(join(root, '.happier-plugin', 'plugin.json'), manifestBytes);
            await writeFile(join(root, 'daemon.mjs'), daemonBytes);
            return Object.freeze({ manifestBytes, daemonBytes });
        };
        const actionArtifact = await materialize(actionRoot, {
            schemaVersion: 2,
            id: 'acme.notification.action',
            version: '1.0.0',
            displayName: 'Notification action',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                actions: [{
                    id: 'send', title: 'Send', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe',
                }],
                events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
                notifications: [{
                    id: 'review-ready', kind: 'activity', title: 'Review ready', eventIds: ['review-ready-event'],
                    defaultChannels: [{ pluginId: 'acme.notification.channel', localId: 'external' }],
                }],
            },
        }, `export function activate(api) {
            api.actions.register('send', async (input, context) => {
                if (input.operation === 'preferences') {
                    return context.services.notifications.preferences('review-ready');
                }
                return context.services.notifications.send({
                    clientRequestId: input.clientRequestId,
                    categoryId: 'review-ready',
                    title: 'Review ready',
                    data: { credential: input.credential }
                });
            });
        }`);
        const channelArtifact = await materialize(channelRoot, {
            schemaVersion: 2,
            id: 'acme.notification.channel',
            version: '1.0.0',
            displayName: 'Notification channel',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                notificationChannels: [{
                    id: 'external', kind: 'webhook', title: 'External', configurable: true, defaultEnabled: true,
                    settings: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string', minLength: 1 },
                        default: 'https://default.invalid/webhook',
                    }, {
                        id: 'webhook-token',
                        title: 'Webhook token',
                        schema: { type: 'string', minLength: 1 },
                        secret: true,
                    }],
                }],
            },
        }, `export function activate(api) {
            api.notifications.registerChannel('external', async (request, context) => {
                try {
                    const endpoint = await context.services.settings.forScope({ kind: 'account' }).get(${JSON.stringify(endpointSettingId)});
                    const token = await context.services.secrets.get(${JSON.stringify(tokenSecretId)}, { reason: 'Authenticate webhook delivery' });
                    context.services.logger.info('notification credential ' + token);
                    if (endpoint !== 'https://default.invalid/webhook') {
                        return {
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'failed',
                            code: 'endpoint_invalid',
                            retryable: false
                        };
                    }
                    return token === 'configured-webhook-token'
                        ? { deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted', evidence: 'provider' }
                        : { deliveryId: request.deliveryId, channelId: request.channelId, status: 'failed', code: 'credential_invalid' };
                } catch (error) {
                    return {
                        deliveryId: request.deliveryId,
                        channelId: request.channelId,
                        status: 'failed',
                        code: typeof error?.code === 'string' ? error.code : 'credential_unavailable'
                    };
                }
            });
        }`);
        const store = createPluginStateStore({ happyHomeDir });
        const localPlugin = async (
            pluginId: string,
            root: string,
        ) => ({
            source: {
                kind: 'path' as const,
                locator: root,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedPath: root,
                manifestPath: join(root, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'unknown' as const, diagnostics: [] },
            install: {
                ...await createTrustedLocalLinkInstall({
                    pluginId,
                    sourceRootPath: root,
                    manifestVersion: '1.0.0',
                }),
            },
            state: { enabled: true },
        });
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.notification.action': await localPlugin('acme.notification.action', actionRoot),
                'acme.notification.channel': await localPlugin('acme.notification.channel', channelRoot),
            },
        });
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        const preparePluginGeneration = async (params: Readonly<{
            pluginId: string;
            immutableGenerationId: string;
            root: string;
            artifact: Readonly<{ manifestBytes: Buffer; daemonBytes: Buffer }>;
        }>) => await prepareImmutablePluginGeneration({
            paths,
            sourceRootPath: params.root,
            record: { sourceProvenance: 'registryCustodied',
                t: 'happier_plugin_generation_v1', schemaVersion: 1,
                pluginId: params.pluginId,
                immutableGenerationId: params.immutableGenerationId,
                createdAtMs: 1,
                files: [
                    {
                        relativePath: '.happier-plugin/plugin.json',
                        byteLength: params.artifact.manifestBytes.byteLength,
                    },
                    {
                        relativePath: 'daemon.mjs',
                        byteLength: params.artifact.daemonBytes.byteLength,
                    },
                ],
                manifestRelativePath: '.happier-plugin/plugin.json',
            },
        });
        const [preparedAction, preparedChannel] = await Promise.all([
            preparePluginGeneration({
                pluginId: 'acme.notification.action',
                immutableGenerationId: 'notification-action-generation-1',
                root: actionRoot,
                artifact: actionArtifact,
            }),
            preparePluginGeneration({
                pluginId: 'acme.notification.channel',
                immutableGenerationId: 'notification-channel-generation-1',
                root: channelRoot,
                artifact: channelArtifact,
            }),
        ]);
        const seededCommit = await readPluginRegistryCommitRecord(paths);
        if (!seededCommit) throw new Error('Expected canonical notification fixture commit');
        await replacePluginRegistryCommitRecord({
            paths,
            expectedCurrent: seededCommit,
            next: {
                ...seededCommit,
                revision: seededCommit.revision + 1,
                transactionId: 'notification-runtime-commit',
                baseRevision: seededCommit.revision,
                pluginGenerations: {
                    ...seededCommit.pluginGenerations,
                    'acme.notification.action': preparedAction.reference,
                    'acme.notification.channel': preparedChannel.reference,
                },
                createdAtMs: 1,
                creator: { pid: 42, instanceId: 'notification-daemon' },
            },
        });
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.notification.action': await localPlugin(
                    'acme.notification.action',
                    preparedAction.rootPath,
                ),
                'acme.notification.channel': await localPlugin(
                    'acme.notification.channel',
                    preparedChannel.rootPath,
                ),
            },
        });
        setNotificationAccountSnapshot({
            token: 'configured-webhook-token',
            version: 1,
            policy: {
                channels: {
                    webhook: { enabled: true },
                },
            },
        });

        const invocationLogSpy = vi.spyOn(logger, 'appendPluginInvocationLogRecord')
            .mockImplementation((record) => { invocationLogRecords.push(record); });
        const localContributes = await resolvePluginContributes({
            happyHomeDir,
            existingAgentIds: new Set(),
        });
        const localGenerationAuthority = await readCurrentCommittedPluginGenerations(paths, {
            bundledArtifacts: [],
        });
        if (!localGenerationAuthority) throw new Error('Expected current local notification generation authority');
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createMergedContributionRegistry(localContributes, {}),
            generationAuthority: localGenerationAuthority,
        });
        try {
            expect(runtimeRegistry.contributes.pluginDiagnosticsByPluginId['acme.notification.action'] ?? []).toEqual([]);
            expect(runtimeRegistry.contributes.activationTargets.map((target) => target.pluginId)).toContain('acme.notification.action');
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.action')).toBe(false);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(false);
            const channelSettings = runtimeRegistry.createPluginSettingsService?.({
                pluginId: 'acme.notification.channel',
                scope: { kind: 'account' },
            });
            if (!channelSettings) throw new Error('Expected canonical notification channel settings service');
            const channelSettingDescriptors = channelSettings.describe();
            expect(channelSettingDescriptors).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: endpointSettingId }),
                expect.objectContaining({ id: tokenSecretId, secret: true }),
            ]));
            expect(channelSettingDescriptors.find((field) => field.id === endpointSettingId)?.secret).not.toBe(true);
            await expect(channelSettings.get(endpointSettingId)).resolves.toBe('https://default.invalid/webhook');
            await expect(channelSettings.get(tokenSecretId)).rejects.toMatchObject({
                code: 'plugin_settings_secret_materialization_required',
            });
            const channelSecrets = runtimeRegistry.createPluginSecretsService?.({
                pluginId: 'acme.notification.channel',
            });
            if (!channelSecrets) throw new Error('Expected declared notification Account-secret service');
            await expect(channelSecrets.status(tokenSecretId)).resolves.toMatchObject({
                state: 'configured',
            });
            const activation = await runtimeRegistry.activateContributionsOnDemand([{
                pluginId: 'acme.notification.action', family: 'actions', localId: 'send',
            }]);
            expect(activation).toEqual([{
                pluginId: 'acme.notification.action',
                diagnostics: [],
            }]);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.action')).toBe(true);
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(false);

            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-configured', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'accepted',
                        evidence: 'provider',
                    })],
                },
            });
            expect(runtimeRegistry.activatedPluginIds.has('acme.notification.channel')).toBe(true);
            expect(JSON.stringify(invocationLogRecords)).toContain('[REDACTED]');
            expect(JSON.stringify(invocationLogRecords)).not.toContain('configured-webhook-token');

            setNotificationAccountSnapshot({
                token: 'invalid-webhook-token',
                version: 2,
                policy: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });
            const failedRequest = {
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-provider-failed', credential: 'required' }, surface: 'cli' as const,
            };
            await expect(runtimeRegistry.targetActionInvocations?.invoke(failedRequest)).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'credential_invalid',
                    })],
                },
            });
            setNotificationAccountSnapshot({
                token: 'configured-webhook-token',
                version: 3,
                policy: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke(failedRequest)).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: true,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'credential_invalid',
                    })],
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-provider-recovered', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'accepted',
                        evidence: 'provider',
                    })],
                },
            });

            setNotificationAccountSnapshot({
                token: 'configured-webhook-token',
                version: 4,
                policy: {
                    channels: {
                        webhook: { enabled: false },
                    },
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { operation: 'preferences' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: expect.objectContaining({
                    categoryId: 'review-ready',
                    enabled: false,
                    channelIds: [],
                }),
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-policy-suppressed', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'suppressed',
                        code: 'plugin_notification_channel_disabled',
                    })],
                },
            });
            setNotificationAccountSnapshot({
                token: 'configured-webhook-token',
                version: 5,
                policy: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });

            setNotificationAccountSnapshot({
                token: 'configured-webhook-token',
                version: 6,
                policy: {
                    events: {
                        'acme.notification.action/review-ready-event': { enabled: false },
                    },
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-event-policy-suppressed', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'suppressed',
                        code: 'plugin_notification_channel_disabled',
                    })],
                },
            });
            setNotificationAccountSnapshot({
                token: 'configured-webhook-token',
                version: 7,
                policy: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });

            setNotificationAccountSnapshot({
                token: null,
                version: 8,
                policy: {
                    channels: {
                        webhook: { enabled: true },
                    },
                },
            });
            await expect(runtimeRegistry.targetActionInvocations?.invoke({
                pluginId: 'acme.notification.action', localId: 'send',
                input: { clientRequestId: 'integration-missing', credential: 'required' }, surface: 'cli',
            })).resolves.toEqual({
                status: 'executed',
                value: {
                    replayed: false,
                    deliveries: [expect.objectContaining({
                        channelId: 'acme.notification.channel/external',
                        status: 'failed',
                        code: 'plugin_secret_missing',
                    })],
                },
            });

        } finally {
            invocationLogSpy.mockRestore();
            resetActiveAccountSettingsSnapshotForTests();
            await runtimeRegistry.dispose();
        }
    });

    it('does not report a dormant SCM registration as missing and refreshes SCM diagnostics after demand', async () => {
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry();
        const gitContribution = (runtimeRegistry.contributes.scmBackends ?? []).find((entry) => (
            entry.pluginId === 'happier.scm.backend.git' && entry.definition.id === 'git'
        ));
        expect(gitContribution).toBeDefined();

        expect(runtimeRegistry.pluginDiagnosticsByPluginId['happier.scm.backend.git'] ?? []).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_scm_backend_missing_activation' }),
            ]),
        );

        await runtimeRegistry.activateContributionsOnDemand([{
            pluginId: 'happier.scm.backend.git',
            family: 'scmBackends',
            localId: 'git',
        }]);

        expect(runtimeRegistry.scmBackendsById?.get('happier.scm.backend.git/git')).toEqual(expect.objectContaining({
            pluginId: 'happier.scm.backend.git',
        }));
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['happier.scm.backend.git'] ?? []).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'plugin_scm_backend_missing_activation' }),
            ]),
        );
        await runtimeRegistry.dispose();
    });

    it('projects an installed external Agent registration into the catalog daemon spawn hook with connected-service inputs', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-spawn-hook-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-agent-spawn-hook-plugin-'));
        let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await materializeSamplePluginFixture(pluginRoot);
            const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                contributes: {
                    agents: Array<Record<string, unknown>>;
                    hooks?: unknown;
                };
            };
            const [agent] = manifest.contributes.agents;
            if (!agent) throw new Error('Expected the sample plugin Agent declaration');
            delete manifest.contributes.hooks;
            agent.cli = {
                executable: {
                    binaryName: 'sample-provider',
                    sourcePreference: 'system-first',
                },
                install: { manual: { kind: 'none' } },
                auth: {
                    support: 'unsupported',
                    probe: { parser: 'none', backgroundChecks: 'safe' },
                    loginLaunches: [],
                },
            };
            await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                import { sampleAgentRuntimeFactory } from './agentRuntime.mjs';

                export function activate(api) {
                    api.agents.register('sample-provider', sampleAgentRuntimeFactory, {
                        sessionRunnerFactory: {
                            module: './agentRuntime.mjs',
                            export: 'sampleAgentRuntimeFactory',
                            runtimeApiVersion: 1,
                        },
                        daemonSpawnHooks: {
                            async resolveRuntimePrerequisites(selection) {
                                const binding = selection.connectedServices
                                    ?.bindingsByServiceId?.['openai-codex'];
                                if (binding?.profileId !== 'work') {
                                    return {
                                        ok: false,
                                        reasonCode: 'fixture_connected_service_missing',
                                        errorMessage: 'Expected the selected connected-service profile.',
                                    };
                                }
                                if (selection.env?.CONNECTED_SERVICE_TOKEN !== 'materialized') {
                                    return {
                                        ok: false,
                                        reasonCode: 'fixture_auth_environment_missing',
                                        errorMessage: 'Expected the materialized connected-service environment.',
                                    };
                                }
                                return { ok: true };
                            },
                            augmentEnv(selection) {
                                const binding = selection.connectedServices
                                    ?.bindingsByServiceId?.['openai-codex'];
                                return {
                                    EXTERNAL_AGENT_CONNECTED_PROFILE: binding?.profileId ?? 'missing',
                                    EXTERNAL_AGENT_SPAWN_TOOLS: typeof selection.tools?.resolveSystemTool,
                                };
                            },
                        },
                    });
                }
            `, 'utf8');
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
                        manifestPath,
                    },
                    compatibility: { status: 'unknown', diagnostics: [] },
                    install: await createTrustedLocalLinkInstall({
                        pluginId: SAMPLE_PLUGIN_ID,
                        sourceRootPath: pluginRoot,
                        manifestVersion: '1.0.0',
                    }),
                    state: { enabled: true },
                },
            });

            runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            expect(runtimeRegistry.pluginDiagnosticsByPluginId[SAMPLE_PLUGIN_ID] ?? []).toEqual([]);
            expect(
                runtimeRegistry.agentRuntimesByAgentId
                    .get(SAMPLE_PLUGIN_PROVIDER_ID)
                    ?.daemonSpawnHooks,
            ).toBeDefined();
            const catalogEntry = runtimeRegistry.contributes.catalogEntriesById[SAMPLE_PLUGIN_PROVIDER_ID];
            expect(catalogEntry?.getDaemonSpawnHooks).toBeTypeOf('function');
            if (!catalogEntry?.getDaemonSpawnHooks) return;
            const externalHooks = await catalogEntry.getDaemonSpawnHooks();
            expect(externalHooks).toBeDefined();
            if (!externalHooks) return;

            const bundledHooks = createAgentRuntimeCatalogEntryHooks({
                agentId: 'bundled-spawn-hook-fixture' as never,
                packageName: '@happier-dev/plugins-bundled-fixture',
                contribution: {
                    daemonSpawnHooks: {
                        augmentEnv: () => ({ BUNDLED_AGENT_SPAWN_HOOK: 'projected' }),
                    },
                },
            })();
            expect(bundledHooks.getDaemonSpawnHooks).toBeTypeOf('function');
            const bundledDaemonSpawnHooks = await bundledHooks.getDaemonSpawnHooks?.();
            expect(bundledDaemonSpawnHooks?.augmentEnv?.({})).toEqual({
                BUNDLED_AGENT_SPAWN_HOOK: 'projected',
            });

            const result = await resolveSpawnChildEnvironment({
                options: {
                    directory: '/workspace/external-agent',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'work',
                            },
                        },
                    },
                },
                profileEnvironmentVariables: {},
                daemonSpawnHooks: externalHooks,
                processEnv: {},
                logDebug: () => {},
                logInfo: () => {},
                logWarn: () => {},
                connectedServiceAuth: {
                    env: { CONNECTED_SERVICE_TOKEN: 'materialized' },
                    cleanupOnFailure: null,
                    cleanupOnExit: null,
                },
            });

            expect(result).toMatchObject({
                ok: true,
                extraEnvForChild: {
                    CONNECTED_SERVICE_TOKEN: 'materialized',
                    EXTERNAL_AGENT_CONNECTED_PROFILE: 'work',
                    EXTERNAL_AGENT_SPAWN_TOOLS: 'function',
                },
            });
        } finally {
            await runtimeRegistry?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('loads current Agent and hook registrations from one local-path plugin state entry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        await materializeSamplePluginFixture(pluginRoot);
        await writeFile(join(pluginRoot, 'daemon.mjs'), `
            import { sampleAgentRuntimeFactory } from './agentRuntime.mjs';
            export function activate(api) {
                api.agents.register('sample-provider', sampleAgentRuntimeFactory, {
                    sessionRunnerFactory: {
                        module: './agentRuntime.mjs',
                        export: 'sampleAgentRuntimeFactory',
                        runtimeApiVersion: 1,
                    },
                });
                api.hooks.register('resolve-prerequisites', async (_payload, context) => {
                    context.services.logger.info('integration hook invoked');
                    await context.services.storage.daemon.set('hook-service-binding', 'integration-bound');
                    return await context.services.storage.daemon.get('hook-service-binding');
                });
            }
        `, 'utf8');
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.sample',
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
                compatibility: {
                    status: 'unknown',
                    diagnostics: [],
                },
                install: await createTrustedLocalLinkInstall({
                    pluginId: 'acme.sample',
                    sourceRootPath: pluginRoot,
                    manifestVersion: '1.0.0',
                }),
                state: {
                    enabled: true,
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.contributes.agentDefinitionsById.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            id: SAMPLE_PLUGIN_PROVIDER_ID,
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                id: SAMPLE_PLUGIN_PROVIDER_ID,
            },
        });
        expect(runtimeRegistry.contributes).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(runtimeRegistry.contributes).not.toHaveProperty('surfaceHandlersByBackendId');
        expect(runtimeRegistry).not.toHaveProperty('runtimeCoreHandlersByBackendId');
        expect(runtimeRegistry.agentRuntimesByAgentId.get(SAMPLE_PLUGIN_PROVIDER_ID)).toMatchObject({
            pluginId: SAMPLE_PLUGIN_ID,
            agentId: SAMPLE_PLUGIN_PROVIDER_ID,
        });
        expect(runtimeRegistry.contributes.catalogEntriesById[SAMPLE_PLUGIN_PROVIDER_ID]).toBeUndefined();

        expect(runtimeRegistry).not.toHaveProperty('readHookEventEnvelopeV1');

        const handlers = runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites');
        const sampleHandler = handlers?.find((handler) => handler.pluginId === SAMPLE_PLUGIN_ID);
        expect(sampleHandler).toBeDefined();
        await expect(sampleHandler?.handler({ payload: {} }, {})).resolves.toBe('integration-bound');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.sample']).toEqual([]);
        await runtimeRegistry.dispose();
    });

    it('requires explicit approval before loading executable hook handlers for prompt-trust plugins', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        await materializeSamplePluginFixture(pluginRoot);
        await writeCommittedLocalPathPluginFixture({
            happyHomeDir,
            pluginId: 'acme.sample',
            sourceRootPath: pluginRoot,
            plugin: {
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
                    installedPath: pluginRoot,
                },
                state: {
                    enabled: true,
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect((runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? []).some(
            (handler) => handler.pluginId === SAMPLE_PLUGIN_ID,
        )).toBe(false);
        expect(runtimeRegistry.agentRuntimesByAgentId.has(SAMPLE_PLUGIN_PROVIDER_ID)).toBe(false);
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
