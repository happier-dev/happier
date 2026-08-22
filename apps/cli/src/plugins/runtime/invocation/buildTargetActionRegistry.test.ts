import { describe, expect, it, vi } from 'vitest';
import {
    PluginError,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import {
    createDefaultPluginAccessScopeRegistry,
    type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { buildTargetActionInvocationRegistry } from './buildTargetActionRegistry';
import {
    createTargetActionHostBindingResolver,
    createTargetActionHostPolicyResolver,
} from '../hostAccess/resolve';
import {
    addConnectedAccountsAvailablePluginInvocationServiceBinding,
    createLoggerAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
    createUnavailablePluginServicesFactory,
} from './services/factory';
import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './services/connectedAccounts';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPluginActionCallerMaterializationFixture } from './services/actionCaller.testkit';
import type { TargetActionAuthorizationFacts } from '../policy/evaluate';

type BuildRegistryParams = Omit<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveAuthorizationFacts' | 'resolveHostBinding' | 'resolveHostPolicy'
> & Partial<Pick<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveHostBinding' | 'resolveHostPolicy'
>> & Readonly<{
    resolveAuthorizationFacts?: (action: Readonly<{
        pluginId: string;
        generation: string;
        qualifiedId: string;
    }>) => TargetActionAuthorizationFacts;
}>;

function buildRegistry(
    params: BuildRegistryParams,
) {
    return buildTargetActionInvocationRegistry({
        createServices: createUnavailablePluginServicesFactory(),
        resolveAuthorizationFacts: () => authorizationFacts(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        resolveHostPolicy: createTargetActionHostPolicyResolver(),
        ...params,
    });
}

const handler = async () => ({ ok: true });

function manifest(params: Readonly<{
    hostAccess?: Readonly<Record<string, unknown>>;
    actionHostAccess?: readonly string[];
    dangerLevel?: 'safe' | 'writesLocal' | 'writesRemote' | 'externalSideEffect' | 'destructive';
    surfaces?: readonly ('cli' | 'mcp' | 'agent' | 'ui' | 'plugin')[];
    inputSchema?: Readonly<Record<string, unknown>>;
    resultSchema?: Readonly<Record<string, unknown>>;
    availability?: Readonly<Record<string, unknown>>;
}> = {}) {
    const surfaces = params.surfaces ?? ['cli'];
    const rawManifest = createPluginManifestV2Fixture({
        id: 'acme.alpha',
        version: '1.2.3',
        hostAccess: params.hostAccess ?? { required: [], optional: [] },
        contributes: {
            actions: [{
                id: 'run', title: 'Run', description: 'Run', scopes: ['global'], surfaces,
                execution: { target: 'daemon' },
                placementBindings: ['commandPalette'], dangerLevel: params.dangerLevel ?? 'safe',
                ...(params.dangerLevel
                    && params.dangerLevel !== 'safe'
                    && surfaces.some((surface) => surface !== 'plugin')
                    ? {
                        confirmation: {
                            title: 'Confirm run',
                            body: { key: 'actions.run.confirmationBody', fallback: 'This action changes external state.' },
                            confirmLabel: 'Run action',
                        },
                    }
                    : {}),
                ...(params.actionHostAccess ? { hostAccess: params.actionHostAccess } : {}),
                ...(params.inputSchema ? { inputSchema: params.inputSchema } : {}),
                ...(params.resultSchema ? { resultSchema: params.resultSchema } : {}),
                ...(params.availability ? { availability: params.availability } : {}),
            }],
        },
    });
    const value = readCanonicalPluginManifest(rawManifest);
    if (!value) throw new Error('canonical action manifest fixture is invalid');
    return value;
}

function connectedAccountActionHostAccess(params: Readonly<{
    id?: string;
}> = {}) {
    return {
        id: params.id ?? 'action-account',
        capability: 'connectedAccounts' as const,
        reason: 'Use the selected Action account',
        scope: {
            serviceRefs: ['account'],
            operations: ['select' as const, 'use' as const],
        },
    };
}

function connectedAccountActionManifest(params: Readonly<{
    optional?: boolean;
    multipleSelectRequests?: boolean;
    omitPurposeBinding?: boolean;
}> = {}) {
    const actionAccountAccess = connectedAccountActionHostAccess();
    const actionAccountRequests = [
        actionAccountAccess,
        ...(params.multipleSelectRequests
            ? [connectedAccountActionHostAccess({ id: 'secondary-action-account' })]
            : []),
    ];
    const value = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: 'acme.alpha',
        version: '1.2.3',
        hostAccess: {
            required: params.optional ? [] : actionAccountRequests,
            optional: params.optional ? actionAccountRequests : [],
        },
        contributes: {
            connectedAccountDescriptors: [{
                id: 'account',
                title: 'Account',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string' },
                            secret: true,
                        }],
                    }],
                },
            }],
            actions: [{
                id: 'run',
                title: 'Run',
                description: 'Run',
                scopes: ['global'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                placementBindings: ['commandPalette'],
                dangerLevel: 'safe',
                hostAccess: actionAccountRequests.map((request) => request.id),
                ...(params.omitPurposeBinding
                    ? {}
                    : {
                        connectedAccountPurposeBindings: [{
                            path: 'credentialRef',
                            purpose: actionAccountAccess.id,
                        }],
                    }),
                inputSchema: {
                    type: 'object',
                    properties: {
                        credentialRef: {
                            type: 'object',
                            properties: {
                                service: {
                                    type: 'object',
                                    properties: {
                                        pluginId: { type: 'string' },
                                        localId: { type: 'string' },
                                    },
                                    required: ['pluginId', 'localId'],
                                    additionalProperties: false,
                                },
                                accountId: { type: 'string' },
                            },
                            required: ['service', 'accountId'],
                            additionalProperties: false,
                        },
                    },
                    required: ['credentialRef'],
                    additionalProperties: false,
                },
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Connected Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                },
            }],
        },
    }));
    if (!value) throw new Error('canonical Connected Account Action manifest fixture is invalid');
    return value;
}

function historyGapResetActionManifest() {
    const sourceCredentialRefSchema = {
        type: 'object',
        properties: {
            service: {
                type: 'object',
                properties: {
                    pluginId: { type: 'string' },
                    localId: { type: 'string' },
                },
                required: ['pluginId', 'localId'],
                additionalProperties: false,
            },
            accountId: { type: 'string' },
        },
        required: ['service', 'accountId'],
        additionalProperties: false,
    } as const;
    const value = readCanonicalPluginManifest(createPluginManifestV2Fixture({
        id: 'acme.alpha',
        version: '1.2.3',
        hostAccess: {
            required: [{
                id: 'source-account',
                capability: 'connectedAccounts',
                reason: 'Read the configured Event source',
                scope: {
                    serviceRefs: ['account'],
                    operations: ['use'],
                    materializationKinds: ['httpHeaders'],
                },
            }],
            optional: [],
        },
        contributes: {
            connectedAccountDescriptors: [{
                id: 'account',
                title: 'Account',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string' },
                            secret: true,
                        }],
                    }],
                },
            }],
            actions: [{
                id: 'reset-history',
                title: 'Reset history',
                scopes: ['global'],
                surfaces: ['plugin'],
                execution: { target: 'daemon' },
                dangerLevel: 'writesLocal',
                hostAccess: ['source-account'],
                inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
            }],
            events: [{
                id: 'repository-updated',
                kind: 'event',
                title: 'Repository updated',
                payloadSchema: { type: 'object', additionalProperties: false },
                automation: {
                    v: 1,
                    eligible: true,
                    source: {
                        sourceContractVersion: 1,
                        supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema: {
                            type: 'object',
                            properties: { credentialRef: sourceCredentialRefSchema },
                            required: ['credentialRef'],
                            additionalProperties: false,
                        },
                        historyGapResetActionRef: {
                            pluginId: 'acme.alpha',
                            localId: 'reset-history',
                        },
                        connectedAccountPurposeBindings: [{
                            path: 'credentialRef',
                            purpose: 'source-account',
                        }],
                    },
                },
            }],
        },
    }));
    if (!value) throw new Error('canonical history-gap reset manifest fixture is invalid');
    return value;
}

function connectedAccountActionServices(
    resolveOptionalAccess?: (pluginId: string) => readonly PluginAccessSelection[],
) {
    const owner: StablePluginConnectedAccountsOwner = Object.freeze({
        getBinding: async () => null,
        requestSelection: async () => {
            throw new Error('Connected Account Action test must not request selection');
        },
        materialize: async () => {
            throw new Error('Connected Account Action test must not materialize credentials');
        },
        listAccounts: async () => {
            throw new Error('Connected Account listing is outside this fixture');
        },
        materializeListedAccount: async () => {
            throw new Error('Exact-listed Connected Account materialization is outside this fixture');
        },
        watch: () => Object.freeze({ dispose() {} }),
    });
    return Object.freeze({
        createServices: createPluginInvocationServicesFactory({
            loggerSink: { write() {} },
            connectedAccounts: createStablePluginConnectedAccountsHost(owner),
        }),
        resolveHostBinding: createTargetActionHostBindingResolver({
            createServiceBinding: (generation, id) => (
                addConnectedAccountsAvailablePluginInvocationServiceBinding(
                    createLoggerAvailablePluginInvocationServiceBinding(generation, id),
                )
            ),
            ...(resolveOptionalAccess ? { resolveOptionalAccess } : {}),
        }),
    });
}

function currentActionFormConnectedAccounts() {
    return Object.freeze({
        resolveBindingIntent: vi.fn(async () => Object.freeze({
            purpose: {
                consumer: { pluginId: 'acme.alpha', localId: 'run' },
                purpose: 'action-account',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
        })),
        activatePurposeBindings: vi.fn(() => Object.freeze({
            subjectId: 'operation:action-form-test',
            isCurrent: () => true,
            resolvePurposeBinding: () => null,
            listPurposeBindings: () => Object.freeze([]),
            dispose() {},
        })),
    });
}

function activationTarget(
    pluginManifest = manifest(),
    trustPolicy: 'local_trusted' | 'prompt' | 'untrusted' = 'local_trusted',
) {
    return {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: 'acme.alpha',
        manifestPath: '/tmp/plugin.json',
        daemonEntryPath: '/tmp/plugin.js',
        sourceSpec: { kind: 'path' as const, locator: '/tmp', trustPolicy, installPolicy: 'link' as const },
        manifest: pluginManifest,
    };
}

function registry(params: Readonly<{
    pluginManifest?: ReturnType<typeof manifest>;
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
}> = {}) {
    const pluginManifest = params.pluginManifest ?? manifest();
    return {
        actions: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.alpha',
            definition: {
                kindVersion: 1, id: 'run', title: 'Run', description: null, safety: 'safe',
                dangerLevel: 'safe',
                placements: [], slash: null, bindings: null, examples: null,
                surfaces: { ui: false, voice: false, agent: false, mcp: false, cli: true, rpc: false, sdk: false, plugin: false },
                execution: { target: 'daemon' },
                inputHints: null, inputSchema: {},
            },
        }],
        materializationIdsByPluginId: {
            'acme.alpha': 'materialization-alpha-current',
        },
        activationTargets: [activationTarget(pluginManifest, params.trustPolicy)],
    } as unknown as ResolvedContributionRegistry;
}

function authorizationFacts(overrides: Readonly<{
    packageIdentity?: string;
    reviewedPackageIdentity?: string | null;
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    resourceSelections?: TargetActionAuthorizationFacts['resourceSelections'];
}> = {}): TargetActionAuthorizationFacts {
    return Object.freeze({
        packageTrust: Object.freeze({
            packageIdentity: overrides.packageIdentity ?? 'package:acme.alpha:generation-7',
            reviewedPackageIdentity: overrides.reviewedPackageIdentity === undefined
                ? 'package:acme.alpha:generation-7'
                : overrides.reviewedPackageIdentity,
        }),
        generation: Object.freeze({
            targetGeneration: '7',
            desiredGeneration: overrides.desiredGeneration === undefined ? '7' : overrides.desiredGeneration,
            appliedGeneration: overrides.appliedGeneration === undefined ? '7' : overrides.appliedGeneration,
        }),
        resourceSelections: overrides.resourceSelections ?? Object.freeze([]),
        scopedGrants: Object.freeze([]),
        operatingSystemAuthorization: Object.freeze([]),
    });
}

function registryWithHostAccess() {
    const base = registry();
    const pluginManifest = manifest({
        hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } }], optional: [] },
        actionHostAccess: ['api'],
    });
    return {
        actions: [base.actions[0]!],
        activationTargets: [activationTarget(pluginManifest)],
    } as unknown as ResolvedContributionRegistry;
}

function fact(overrides: Partial<PluginTargetActivationFact> = {}): PluginTargetActivationFact {
    return {
        pluginId: 'acme.alpha', pluginVersion: '1.2.3', source: 'localPath', generation: '7',
        host: 'daemon', platform: 'darwin', occurredAtMs: 1, status: 'active',
        required: [{ family: 'actions', localId: 'run' }],
        bound: [{ family: 'actions', localId: 'run' }], diagnostics: [], ...overrides,
    };
}

describe('buildTargetActionInvocationRegistry', () => {
    it('delegates daemon Action present-user policy to the runtime final-policy owner', () => {
        const policy = Object.freeze({
            qualifiedId: 'acme.alpha/actions/run',
            generation: '7',
            dangerLevel: 'safe' as const,
            scopes: Object.freeze(['global']),
            surfaces: Object.freeze(['cli']),
            authorization: Object.freeze({
                packageTrust: Object.freeze({
                    packageIdentity: 'package:acme.alpha:generation-7',
                    reviewedPackageIdentity: 'package:acme.alpha:generation-7',
                }),
                generation: Object.freeze({
                    targetGeneration: '7',
                    desiredGeneration: '7',
                    appliedGeneration: '7',
                    targetGenerationMode: 'current' as const,
                }),
                resourceSelections: Object.freeze([]),
                scopedGrants: Object.freeze([]),
                serviceAvailability: Object.freeze([]),
                operatingSystemAuthorization: Object.freeze([]),
            }),
        });
        const resolvePresentUserGatePolicy = vi.fn(() => policy);
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
            resolvePresentUserGatePolicy,
        });

        expect(target.resolvePresentUserGatePolicy?.('acme.alpha', 'run')).toBe(policy);
        expect(resolvePresentUserGatePolicy).toHaveBeenCalledWith('acme.alpha', 'run');
    });

    it('keeps a retained Action registration backed by its own active generation', async () => {
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact({ generation: '7' })],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
    });

    it('provides a declared Connected Accounts service to the Action handler', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        const actionFormConnectedAccounts = currentActionFormConnectedAccounts();
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: async (_input: JsonValue, context: PluginInvocationContext) => {
                        await context.services.connectedAccounts.getBinding('action-account');
                        return {
                            connectedAccounts: context.services.availability('connectedAccounts').status,
                        };
                    },
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts,
        });
        const input = {
            credentialRef: {
                service: { pluginId: 'acme.alpha', localId: 'account' },
                accountId: 'account-1',
            },
        };

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input,
            surface: 'ui',
        })).resolves.toEqual({
            status: 'executed',
            value: { connectedAccounts: 'available' },
        });
    });

    it('materializes the current history-gap source Account under its exact operation binding', async () => {
        const pluginManifest = historyGapResetActionManifest();
        const sourceAccount = {
            service: { pluginId: 'acme.alpha', localId: 'account' },
            accountId: 'source-account-a',
        } as const;
        const durableSelectedAccount = {
            service: { pluginId: 'acme.alpha', localId: 'account' },
            accountId: 'durable-selected-account-b',
        } as const;
        const materialize = vi.fn<StablePluginConnectedAccountsOwner['materialize']>(async (input) => {
            expect(input.exactPurposeBindingSubjectId).toBe('operation:history-gap-reset');
            expect(input.expectedAccount).toEqual(sourceAccount);
            expect(input.expectedAccount).not.toEqual(durableSelectedAccount);
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer source-a' } };
        });
        const connectedAccountsOwner: StablePluginConnectedAccountsOwner = Object.freeze({
            getBinding: async () => null,
            requestSelection: async () => {
                throw new Error('History-gap recovery must not request a durable selection');
            },
            materialize,
            listAccounts: async () => {
                throw new Error('History-gap recovery must not enumerate Accounts');
            },
            materializeListedAccount: async () => {
                throw new Error('History-gap recovery must not materialize a listed Account');
            },
            watch: () => Object.freeze({ dispose() {} }),
        });
        const actionFormConnectedAccounts = {
            resolveBindingIntent: vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(
                async (input) => ({ purpose: input.purpose, target: input.target }),
            ),
            activatePurposeBindings: vi.fn<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']>(
                (input) => {
                    expect(input.subject).toMatchObject({
                        kind: 'operation',
                        consumer: { pluginId: 'acme.alpha', localId: 'reset-history' },
                    });
                    expect(input.bindings).toEqual([{
                        purpose: {
                            consumer: { pluginId: 'acme.alpha', localId: 'reset-history' },
                            purpose: 'source-account',
                        },
                        target: { kind: 'account', account: sourceAccount },
                    }]);
                    return Object.freeze({
                        subjectId: 'operation:history-gap-reset',
                        isCurrent: () => true,
                        resolvePurposeBinding: () => null,
                        listPurposeBindings: () => Object.freeze([]),
                        dispose() {},
                    });
                },
            ),
        };
        const services = {
            createServices: createPluginInvocationServicesFactory({
                loggerSink: { write() {} },
                connectedAccounts: createStablePluginConnectedAccountsHost(connectedAccountsOwner),
            }),
            resolveHostBinding: createTargetActionHostBindingResolver({
                createServiceBinding: (generation, id) => (
                    addConnectedAccountsAvailablePluginInvocationServiceBinding(
                        createLoggerAvailablePluginInvocationServiceBinding(generation, id),
                    )
                ),
            }),
        };
        const contributes = {
            actions: [],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.alpha',
                manifestPath: '/tmp/plugin.json',
                daemonEntryPath: '/tmp/plugin.js',
                sourceSpec: {
                    kind: 'path',
                    locator: '/tmp',
                    trustPolicy: 'local_trusted',
                    installPolicy: 'link',
                },
                manifest: pluginManifest,
            }],
        } as unknown as ResolvedContributionRegistry;
        const handler = vi.fn(async (
            _input: import('@happier-dev/plugin-sdk').JsonValue,
            context: import('@happier-dev/plugin-sdk').PluginInvocationContext,
        ) => {
            const materialization = await context.services.connectedAccounts.materialize(
                'source-account',
                {
                    kind: 'httpHeaders',
                    origin: 'https://api.github.com',
                    headerNames: ['authorization'],
                },
                { expectedAccount: sourceAccount },
            );
            return materialization.kind === 'httpHeaders' ? { kind: 'baselined' } : { kind: 'stale' };
        });
        const resolveAutomationEventHistoryGapSource = vi.fn(async () => Object.freeze({
            eventLocalId: 'repository-updated',
            sourceConfig: { credentialRef: sourceAccount },
        }));
        const target = buildRegistry({
            contributes,
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'reset-history', value: handler },
            }],
            targetActivationFacts: [fact({
                required: [{ family: 'actions', localId: 'reset-history' }],
                bound: [{ family: 'actions', localId: 'reset-history' }],
            })],
            ...services,
            actionFormConnectedAccounts,
            resolveAutomationEventHistoryGapSource,
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'reset-history',
            input: {
                automationId: 'automation-1',
                templateVersion: 3,
                sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            surface: 'plugin',
        })).resolves.toEqual({ status: 'executed', value: { kind: 'baselined' } });
        expect(resolveAutomationEventHistoryGapSource).toHaveBeenCalledOnce();
        expect(actionFormConnectedAccounts.resolveBindingIntent).toHaveBeenCalledWith(expect.objectContaining({
            target: { kind: 'account', account: sourceAccount },
        }));
        expect(actionFormConnectedAccounts.activatePurposeBindings).toHaveBeenCalledOnce();
        expect(materialize).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch a Connected Accounts Action after its generation retires', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        let generationCurrent = true;
        const generationLifecycle = Object.freeze({
            isCurrent: () => generationCurrent,
            retirementSignal: new AbortController().signal,
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: async () => ({ ok: true }) },
            }],
            targetActivationFacts: [fact()],
            ...services,
            resolveGenerationLifecycle: () => generationLifecycle,
        });
        generationCurrent = false;

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_generation_retired',
        });
    });

    it('re-evaluates optional Connected Accounts authorization at Action dispatch', async () => {
        const pluginManifest = connectedAccountActionManifest({ optional: true });
        const actionAccountAccess = connectedAccountActionHostAccess();
        const selection = createDefaultPluginAccessScopeRegistry().createSelection({
            pluginId: 'acme.alpha',
            accessId: actionAccountAccess.id,
            capability: actionAccountAccess.capability,
            scope: actionAccountAccess.scope,
            selectedAtMs: 1,
        });
        let selected = true;
        const resolveOptionalAccess = () => selected ? [selection] : [];
        const services = connectedAccountActionServices(resolveOptionalAccess);
        const actionFormConnectedAccounts = currentActionFormConnectedAccounts();
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: async (_input: JsonValue, context: PluginInvocationContext) => {
                        await context.services.connectedAccounts.getBinding('action-account');
                        return {
                            connectedAccounts: context.services.availability('connectedAccounts').status,
                        };
                    },
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts,
            resolveOptionalAccess,
        });
        const invoke = () => target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        });

        await expect(invoke()).resolves.toEqual({
            status: 'executed',
            value: { connectedAccounts: 'available' },
        });
        selected = false;

        await expect(invoke()).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_host_access_resource_not_selected',
        });
    });

    it('uses the declared credential-reference mapping instead of HostAccess request order', async () => {
        const pluginManifest = connectedAccountActionManifest({ multipleSelectRequests: true });
        const services = connectedAccountActionServices();
        const actionFormConnectedAccounts = currentActionFormConnectedAccounts();
        const handler = vi.fn(async () => ({ connectedAccounts: 'available' }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts,
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        })).resolves.toEqual({
            status: 'executed',
            value: { connectedAccounts: 'available' },
        });
        expect(actionFormConnectedAccounts.resolveBindingIntent).toHaveBeenCalledWith(
            expect.objectContaining({
                purpose: {
                    consumer: { pluginId: 'acme.alpha', localId: 'run' },
                    purpose: 'action-account',
                },
            }),
        );
        expect(actionFormConnectedAccounts.activatePurposeBindings).toHaveBeenCalledWith(
            expect.objectContaining({
                purposes: [{
                    consumer: { pluginId: 'acme.alpha', localId: 'run' },
                    purpose: 'action-account',
                }],
            }),
        );
        expect(handler).toHaveBeenCalledOnce();
    });

    it('fails closed when a dynamic Connected Account field lacks its typed purpose mapping', async () => {
        const pluginManifest = connectedAccountActionManifest({ omitPurposeBinding: true });
        const services = connectedAccountActionServices();
        const actionFormConnectedAccounts = currentActionFormConnectedAccounts();
        const handler = vi.fn(async () => ({ connectedAccounts: 'available' }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts,
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_form_connected_account_options_unavailable',
        });
        expect(actionFormConnectedAccounts.resolveBindingIntent).not.toHaveBeenCalled();
        expect(actionFormConnectedAccounts.activatePurposeBindings).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('revalidates a selected Action-form Account through the canonical purpose-binding owner', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        const resolveBindingIntent = vi.fn(async () => Object.freeze({
            purpose: {
                consumer: { pluginId: 'acme.alpha', localId: 'run' },
                purpose: 'action-account',
            },
            target: {
                kind: 'account' as const,
                account: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
        }));
        const handler = vi.fn(async () => ({ accepted: true }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts: {
                resolveBindingIntent,
                activatePurposeBindings: currentActionFormConnectedAccounts().activatePurposeBindings,
            },
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        })).resolves.toEqual({
            status: 'executed',
            value: { accepted: true },
        });
        expect(resolveBindingIntent).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'acme.alpha', localId: 'run' },
                purpose: 'action-account',
            },
            target: {
                kind: 'account',
                account: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            serviceRefs: [{ pluginId: 'acme.alpha', localId: 'account' }],
            signal: expect.any(AbortSignal),
        }));
        expect(handler).toHaveBeenCalledOnce();
    });

    it('does not dispatch a selected Action-form Account that the canonical binding owner no longer resolves', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        const resolveBindingIntent = vi.fn(async () => {
            throw new PluginError({
                code: 'plugin_host_access_resource_not_selected',
                message: 'The selected Connected Account no longer exists',
            });
        });
        const handler = vi.fn(async () => ({ accepted: true }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts: { resolveBindingIntent },
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'retired-account',
                },
            },
            surface: 'ui',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_form_connected_account_options_unavailable',
        });
        expect(resolveBindingIntent).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
    });

    it('does not invoke an Action handler after its target retires during Account revalidation', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        let current = true;
        const resolveBindingIntent = vi.fn(async () => {
            current = false;
            return Object.freeze({
                purpose: {
                    consumer: { pluginId: 'acme.alpha', localId: 'run' },
                    purpose: 'action-account',
                },
                target: {
                    kind: 'account' as const,
                    account: {
                        service: { pluginId: 'acme.alpha', localId: 'account' },
                        accountId: 'account-1',
                    },
                },
            });
        });
        const handler = vi.fn(async () => ({ accepted: true }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts: { resolveBindingIntent },
            resolveGenerationLifecycle: () => Object.freeze({
                isCurrent: () => current,
                retirementSignal: new AbortController().signal,
            }),
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {
                credentialRef: {
                    service: { pluginId: 'acme.alpha', localId: 'account' },
                    accountId: 'account-1',
                },
            },
            surface: 'ui',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_generation_retired',
        });
        expect(resolveBindingIntent).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
    });

    it('leaves nested caller materialization stamping to the invocation-service owner', async () => {
        const createServices = vi.fn(createUnavailablePluginServicesFactory());
        const target = buildRegistry({
            contributes: registry(),
            createServices,
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({ status: 'executed' });
        const seed = createServices.mock.calls[0]?.[0];
        expect(seed).toBeDefined();
        expect(seed).not.toHaveProperty('materialization');
    });

    it('enforces the canonical manifest resultSchema at the production registry builder', async () => {
        const pluginManifest = manifest({
            resultSchema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
            },
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: async () => ({ wrong: true }),
                },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'invalid',
            code: 'plugin_action_result_schema_invalid',
        });
    });

    it('uses committed package authorization instead of the discovery source trust string', async () => {
        const committedHandler = vi.fn(handler);
        const committed = buildRegistry({
            contributes: registry({ trustPolicy: 'prompt' }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: committedHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts(),
        });
        await expect(committed.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({ status: 'executed' });
        expect(committedHandler).toHaveBeenCalledOnce();

        const uncommittedHandler = vi.fn(handler);
        const uncommitted = buildRegistry({
            contributes: registry({ trustPolicy: 'local_trusted' }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: uncommittedHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts({ reviewedPackageIdentity: null }),
        });
        await expect(uncommitted.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable', code: 'plugin_action_package_untrusted',
        });
        expect(uncommittedHandler).not.toHaveBeenCalled();
    });

    it.each([
        'writesLocal',
        'writesRemote',
        'externalSideEffect',
        'destructive',
    ] as const)('requires current intent before invoking a %s action', async (dangerLevel) => {
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ dangerLevel }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable', code: 'plugin_action_current_intent_unavailable',
        });
        expect(actionHandler).not.toHaveBeenCalled();

        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({
            status: 'approved' as const,
            fingerprint,
        }));
        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'visible', requiresCurrentIntent: true,
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli', requestCurrentIntent,
        })).resolves.toMatchObject({ status: 'executed' });
        expect(requestCurrentIntent).toHaveBeenCalledOnce();
        expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({
                confirmation: {
                    title: 'Confirm run',
                    body: { key: 'actions.run.confirmationBody', fallback: 'This action changes external state.' },
                    confirmLabel: 'Run action',
                },
            }),
        }));
        expect(actionHandler).toHaveBeenCalledOnce();
    });

    it('does not request present-user current intent for a declared plugin-to-plugin target action', async () => {
        const actionHandler = vi.fn(async (_input, context) => ({
            surface: context.surface,
            caller: context.caller,
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture(
            'acme.caller',
            { materializationId: 'materialization-caller-current' },
        );
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({
                dangerLevel: 'writesRemote',
                surfaces: ['plugin'],
            }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'plugin',
            invocationSurface: 'background',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'send', qualifiedId: 'acme.caller/actions/send' },
                materialization: callerMaterialization.materialization,
                originSurface: 'ui',
            },
        })).resolves.toEqual(expect.objectContaining({
            status: 'executed',
            value: {
                surface: 'plugin',
                caller: {
                    kind: 'plugin',
                    pluginId: 'acme.caller',
                    contribution: { id: 'send', qualifiedId: 'acme.caller/actions/send' },
                    materialization: callerMaterialization.materialization,
                    originSurface: 'ui',
                },
            },
        }));
        expect(actionHandler).toHaveBeenCalledOnce();
    });

    it('does not execute a plugin-only target Action through direct UI dispatch', async () => {
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ surfaces: ['plugin'] }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'ui',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_surface_unavailable',
        });
        expect(actionHandler).not.toHaveBeenCalled();
    });

    it('requires fresh current intent for a mounted UI dispatch of a dangerous plugin target', async () => {
        const actionHandler = vi.fn(async (_input, context) => ({
            surface: context.surface,
            caller: context.caller,
        }));
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({
                dangerLevel: 'writesRemote',
                surfaces: ['plugin'],
            }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
        });
        const mountedMaterialization = createPluginActionCallerMaterializationFixture(
            'acme.mounted',
            { materializationId: 'materialization-mounted-current' },
        );
        const invocation = {
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'plugin' as const,
            invocationSurface: 'ui' as const,
            caller: {
                kind: 'plugin' as const,
                pluginId: 'acme.mounted',
                contribution: { id: 'dashboard', qualifiedId: 'acme.mounted/dashboard' },
                materialization: mountedMaterialization.materialization,
                originSurface: 'ui' as const,
            },
        };

        await expect(target.invoke(invocation)).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_current_intent_unavailable',
        });
        expect(actionHandler).not.toHaveBeenCalled();

        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({
            status: 'approved' as const,
            fingerprint,
        }));
        await expect(target.invoke({ ...invocation, requestCurrentIntent })).resolves.toEqual({
            status: 'executed',
            value: {
                surface: 'plugin',
                caller: invocation.caller,
            },
        });
        expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
            surface: 'plugin',
            invocationSurface: 'ui',
        }));
        expect(actionHandler).toHaveBeenCalledOnce();
    });

    it.each([
        ['desired generation', { desiredGeneration: '8' }],
        ['applied generation', { appliedGeneration: '8' }],
        ['package identity', { packageIdentity: 'package:acme.alpha:generation-8' }],
    ] as const)('rechecks %s after present intent before calling the handler', async (_label, changedFacts) => {
        let facts = authorizationFacts();
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ dangerLevel: 'writesRemote' }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => facts,
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
            requestCurrentIntent: async ({ fingerprint }) => {
                facts = authorizationFacts(changedFacts);
                return { status: 'approved', fingerprint };
            },
        })).resolves.toMatchObject({ status: 'unavailable' });
        expect(actionHandler).not.toHaveBeenCalled();
    });

    it.each([
        ['exact selection', 'selected', 'executed'],
        ['absent selection', 'absent', 'unavailable'],
        ['broader request', 'broader', 'unavailable'],
    ] as const)('enforces the %s from persisted host-resource authorization facts', async (_label, selection, status) => {
        const actionHandler = vi.fn(handler);
        const requestedResourceId = 'mcp:acme.tools/runtime:listTools';
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: actionHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts({
                resourceSelections: [Object.freeze({
                    id: 'selected-mcp',
                    required: true,
                    requestedResourceId,
                    ...(selection === 'selected'
                        ? { selectedResourceId: requestedResourceId }
                        : selection === 'broader'
                            ? { selectedResourceId: `${requestedResourceId}:discover` }
                            : {}),
                })],
            }),
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({ status });
        expect(actionHandler).toHaveBeenCalledTimes(status === 'executed' ? 1 : 0);
    });

    it('rejects missing, extra, and activation-fact-mismatched action publications', () => {
        expect(() => buildRegistry({
            contributes: registry(), targetRegistrations: [], targetActivationFacts: [fact()],
        })).toThrow(/no committed registration/i);

        expect(() => buildRegistry({
            contributes: registry(),
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '8', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        })).toThrow(/not backed by an active generation fact/i);

        expect(() => buildRegistry({
            contributes: registry(),
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '7', registration: { family: 'actions', localId: 'extra', value: handler } }],
            targetActivationFacts: [fact({ required: [], bound: [{ family: 'actions', localId: 'extra' }] })],
        })).toThrow(/no matching manifest action/i);
    });

    it('uses host-owned activation metadata and exact qualified identity', async () => {
        let contextVersion: string | undefined;
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha', generation: '7',
                registration: { family: 'actions', localId: 'run', value: async (_input: JsonValue, context: PluginInvocationContext) => {
                    contextVersion = context.plugin.version;
                    return { ok: true };
                } },
            }],
            targetActivationFacts: [fact()],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toEqual({ status: 'executed', value: { ok: true } });
        expect(contextVersion).toBe('1.2.3');
    });

    it('rebuilds from the complete live generation publication after lazy activation', async () => {
        const targetRegistrations: Array<{
            pluginId: string;
            generation: string;
            registration: { family: 'actions'; localId: string; value: typeof handler };
        }> = [];
        const targetActivationFacts: PluginTargetActivationFact[] = [];
        const target = buildRegistry({
            contributes: registry(), targetRegistrations, targetActivationFacts,
        });
        expect(target.has('acme.alpha', 'run')).toBe(false);

        targetRegistrations.push({
            pluginId: 'acme.alpha', generation: '7',
            registration: { family: 'actions', localId: 'run', value: handler },
        });
        targetActivationFacts.push(fact());
        target.refresh();

        expect(target.has('acme.alpha', 'run')).toBe(true);
        await expect(target.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
    });

    it('passes the exact structured manifest request to the host-access owner', async () => {
        const unavailableResolver = createTargetActionHostBindingResolver();
        const resolveHostBinding = vi.fn(unavailableResolver);
        const target = buildRegistry({
            contributes: registryWithHostAccess(),
            resolveHostBinding,
            targetRegistrations: [{ pluginId: 'acme.alpha', generation: '7', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_host_access_service_unavailable' });
        expect(resolveHostBinding).toHaveBeenCalledWith(
            expect.objectContaining({ pluginId: 'acme.alpha' }),
            expect.objectContaining({
                hostAccessRequests: [expect.objectContaining({
                    required: true,
                    request: expect.objectContaining({ capability: 'network', scope: expect.objectContaining({ methods: ['GET'] }) }),
                })],
            }),
        );
    });

    it('keeps catalog authorization aligned with unavailable declared host access', async () => {
        const target = buildRegistry({
            contributes: registryWithHostAccess(),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
        });

        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        });
    });

    it('keeps catalog authorization aligned with declaration availability', async () => {
        const pluginManifest = manifest({
            availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            },
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                generation: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
        });

        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'unavailable',
            code: 'plugin_contribution_not_applicable',
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_contribution_not_applicable',
        });
    });
});
