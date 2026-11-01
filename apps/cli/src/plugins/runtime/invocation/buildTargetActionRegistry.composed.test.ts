import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { describe, expect, it, vi } from 'vitest';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    type PluginActionContributionV2,
    createActionExecutor,
    formatQualifiedPluginActionId,
} from '@happier-dev/protocol';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';
import {
    PluginError,
    type ActionOperationDeclarationV1,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { normalizePluginManifestV2, readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import {
    createResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
    buildPluginContributionRegistry,
} from '@/plugins/projection/registry/normalize/package';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginTargetActivationFact } from '@/plugins/runtime/lifecycle/activation/facts';
import {
    createDefaultPluginAccessScopeRegistry,
    type PluginAccessSelection,
} from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { buildTargetActionInvocationRegistry } from './buildTargetActionRegistry';
import type { ActionHandler, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    createTargetActionHostBindingResolver,
    createTargetActionHostPolicyResolver,
} from '../hostAccess/resolve';
import {
    addConnectedAccountsAvailablePluginInvocationServiceBinding,
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
    createUnavailablePluginServicesFactory,
} from './services/factory';
import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './services/connectedAccounts';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createPluginActionCallerMaterializationFixture } from './services/actionCaller.testkit';
import type { TargetActionAuthorizationFacts } from '../policy/evaluate';
import { resolvePluginFinalPolicyAuthorizationFacts } from '../policy/facts';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '../reload/controller';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '../reload/runtimeLease';
import { unexpectedCaptureSourceResolution } from '@/plugins/testkit/unexpectedCaptureSourceResolution';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader } from './actions/createCommittedContributedActionDeps';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailablePluginServices } from './services/unavailable';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest.js';
import { withPluginInvocationAccountStorageAvailability } from './services/unavailable';
import { createTargetActionCurrentIntentAdapter, targetActionApprovalMatchesCurrentIntent } from '@/session/actions/approvals/targetActionCurrentIntent';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import type { PluginInvocationLogRecord } from './services/logger';

type BuildRegistryParams = Omit<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveAuthorizationFacts' | 'resolveHostBinding' | 'resolveHostPolicy'
> & Partial<Pick<
    Parameters<typeof buildTargetActionInvocationRegistry>[0],
    'createServices' | 'resolveHostBinding' | 'resolveHostPolicy'
>> & Readonly<{
    resolveAuthorizationFacts?: (action: Readonly<{
        pluginId: string;
        occurrenceId: string;
        qualifiedId: string;
    }>, purpose?: 'declaration') => TargetActionAuthorizationFacts;
}>;

function buildRegistry(
    params: BuildRegistryParams,
) {
    return buildTargetActionInvocationRegistry({
        createServices: createUnavailablePluginServicesFactory(),
        resolveAuthorizationFacts: () => authorizationFacts(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        resolveHostPolicy: createTargetActionHostPolicyResolver(),
        readCurrentPluginOccurrenceId: () => '7' as PluginRuntimeOccurrenceId,
        readCurrentPluginSourceCustody: () => ({
            kind: 'managed',
            immutableGenerationId: 'immutable-alpha',
            installSource: 'archive',
        }),
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
    inputHints?: PluginActionContributionV2['inputHints'];
    inputTypes?: NonNullable<ReturnType<typeof readCanonicalPluginManifest>>['contributes']['inputTypes'];
    resources?: NonNullable<ReturnType<typeof readCanonicalPluginManifest>>['contributes']['resources'];
    resultSchema?: Readonly<Record<string, unknown>>;
    availability?: Readonly<Record<string, unknown>>;
    operation?: ActionOperationDeclarationV1;
    execution?: PluginActionContributionV2['execution'];
}> = {}) {
    const surfaces = params.surfaces ?? ['cli'];
    const rawManifest = createPluginManifestV2Fixture({
        id: 'acme.alpha',
        version: '1.2.3',
        hostAccess: params.hostAccess ?? { required: [], optional: [] },
        contributes: {
            ...(params.inputTypes ? { inputTypes: params.inputTypes } : {}),
            ...(params.resources ? { resources: params.resources } : {}),
            actions: [{
                id: 'run', title: 'Run', description: 'Run', scopes: ['global'], surfaces,
                execution: params.execution ?? { target: 'daemon' },
                ...(params.operation ? { operation: params.operation } : {}),
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
                ...(params.inputHints ? { inputHints: params.inputHints } : {}),
                ...(params.resultSchema ? { resultSchema: params.resultSchema } : {}),
                ...(params.availability ? { availability: params.availability } : {}),
            }],
        },
    });
    return normalizePluginManifestV2(rawManifest);
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
    useDefaultBinding?: boolean;
}> = {}) {
    const accountAccess = connectedAccountActionHostAccess();
    const actionAccountAccess = { ...accountAccess, scope: { ...accountAccess.scope,
        ...(params.useDefaultBinding ? { materializationKinds: ['httpHeaders' as const] } : {}) } };
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
                ...(params.omitPurposeBinding || params.useDefaultBinding
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
                ...(params.useDefaultBinding ? {} : { inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Connected Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                } }),
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
    } satisfies Parameters<typeof createPluginEventAutomationSetupResultV1JsonSchema>[1];
    const sourceConfigSchema = {
        type: 'object',
        properties: { credentialRef: sourceCredentialRefSchema },
        required: ['credentialRef'],
        additionalProperties: false,
    } satisfies Parameters<typeof createPluginEventAutomationSetupResultV1JsonSchema>[1];
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
                confirmation: {
                    title: { key: 'automation.historyGapReset.title', fallback: 'Start a new baseline' },
                    body: { key: 'automation.historyGapReset.body', fallback: 'Events in the history gap are not replayed.' },
                },
                hostAccess: ['source-account'],
                inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
            }, {
                id: 'setup-source',
                title: 'Set up source',
                scopes: ['global'],
                surfaces: ['plugin'],
                execution: { target: 'daemon' },
                dangerLevel: 'safe',
                inputSchema: { type: 'object', additionalProperties: false },
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
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
                        sourceConfigSchema,
                        setupActionRef: {
                            pluginId: 'acme.alpha',
                            localId: 'setup-source',
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
    const unavailable = async (): Promise<never> => {
        throw new Error('Action form fixture does not read or materialize Account state');
    };
    const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: unavailable, update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable,
        resolveTarget: unavailable,
        materializeAccount: unavailable,
        projectTargetAccounts: unavailable,
        assertTargetAccountMaterializable: unavailable,
    });
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
        activatePurposeBindings: vi.fn(purposeBindingOwner.activatePurposeBindings),
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
    const activation = activationTarget(pluginManifest, params.trustPolicy);
    const loadedPlugin = {
        pluginId: activation.pluginId,
        pluginRootPath: '/tmp',
        manifestPath: activation.manifestPath,
        daemonEntryPath: activation.daemonEntryPath,
        devDaemonEntryPath: null,
        sourceSpec: activation.sourceSpec,
        manifest: pluginManifest,
    } satisfies LoadedPlugin;
    const normalized = buildPluginContributionRegistry({
        loadedPlugins: [loadedPlugin],
    });
    const normalizedAction = normalized.actions[0];
    if (!normalizedAction) throw new Error('Expected normalized Action fixture');
    const resolvedAction: ResolvedActionContribution = {
        provenance: 'external',
        source: { kind: 'path' },
        ...normalizedAction,
    };
    const resolved = createResolvedContributionRegistry({
        actions: [resolvedAction],
        inputTypes: normalized.inputTypes.map(type => ({ provenance: 'external' as const, source: { kind: 'path' as const }, ...type,
            identity: createPluginContributionIdentity({ pluginId: type.pluginId, localId: type.definition.id }), manifestPath: activation.manifestPath })),
        resources: normalized.resources.map(resource => ({ provenance: 'external' as const, source: { kind: 'path' as const }, ...resource })),
        occurrenceIdsByPluginId: { 'acme.alpha': '7' as PluginRuntimeOccurrenceId },
        materializationIdsByPluginId: {
            'acme.alpha': 'materialization-alpha-current',
        },
        activationTargets: [activation],
    });
    const localId = pluginManifest.contributes.actions[0]?.id;
    if (!localId) throw new Error('Expected one manifest Action fixture');
    const actionRegistryKey = buildQualifiedPluginContributionKey(
        createPluginContributionIdentity({ pluginId: 'acme.alpha', localId }),
    );
    if (!resolved.actionsById?.has(actionRegistryKey)) {
        throw new Error(`Expected normalized Action '${actionRegistryKey}'`);
    }
    return resolved;
}

function authorizationFacts(overrides: Readonly<{
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    resourceSelections?: TargetActionAuthorizationFacts['resourceSelections'];
}> = {}): TargetActionAuthorizationFacts {
    return Object.freeze({
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
    const pluginManifest = manifest({
        hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } }], optional: [] },
        actionHostAccess: ['api'],
    });
    return registry({ pluginManifest });
}

function fact(overrides: Partial<PluginTargetActivationFact> = {}): PluginTargetActivationFact {
    return {
        pluginId: 'acme.alpha', pluginVersion: '1.2.3', source: 'localPath', occurrenceId: '7',
        host: 'daemon', platform: 'darwin', occurredAtMs: 1, status: 'active',
        required: [{ family: 'actions', localId: 'run' }],
        bound: [{ family: 'actions', localId: 'run' }], diagnostics: [], ...overrides,
    };
}

describe('buildTargetActionInvocationRegistry', () => {
    it.each(['actions/read-v1', 'actions/administer-v1'])('discovers the actual Triage %s declaration cold while retaining Account storage policy', async (localId) => {
        const triageManifest = normalizePluginManifestV2(TRIAGE_MANIFEST);
        const declaration = triageManifest.contributes.actions.find(action => action.id === localId);
        if (!declaration) throw new Error(`Missing Triage declaration ${localId}`);
        const pluginManifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'acme.alpha',
            hostAccess: triageManifest.hostAccess, contributes: { actions: [declaration] } }));
        const contributes = registry({ pluginManifest });
        let accountAvailable = true;
        const resolveHostPolicy = createTargetActionHostPolicyResolver({
            createServiceBinding: (generation, id) => withPluginInvocationAccountStorageAvailability(
                createLoggerAvailablePluginInvocationServiceBinding(generation, id), accountAvailable ? 'available' : 'unavailable'),
        });
        // Triage authors its data Actions as Account-target, so discovery is the Account realm's.
        const target = buildRegistry({ contributes, targetRegistrations: [], targetActivationFacts: [], resolveHostPolicy,
            executionRealm: 'account',
            resolveAuthorizationFacts: (_action, purpose) => resolvePluginFinalPolicyAuthorizationFacts({
                pluginId: 'acme.alpha',
                current: { occurrenceId: '7' as PluginRuntimeOccurrenceId, desiredOccurrenceId: '7' as PluginRuntimeOccurrenceId,
                    appliedOccurrenceId: null, applied: false, selectedAccess: [],
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } },
                ...(purpose ? { purpose } : {}),
            }),
        });
        expect(target.has('acme.alpha', localId)).toBe(false);
        expect(target.evaluateCatalogPolicy('acme.alpha', localId)).toMatchObject({ outcome: 'visible' });
        accountAvailable = false;
        expect(target.evaluateCatalogPolicy('acme.alpha', localId)).toMatchObject({
            outcome: 'unavailable', code: 'plugin_host_access_service_unavailable',
        });
    });

    it.each([false, true])('admits portable Account code and refuses only demanded unavailable Account storage (storage demanded: %s)', async (demandStorage) => {
        const portable = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } });
        const invoke = vi.fn<PluginAccountActionHandler>(async (_input, context) => {
            if (demandStorage) await context.services.storage.account.kv.get('key');
            return { ok: true };
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest: portable }), executionRealm: 'account',
            targetActivationFacts: [fact()],
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run', value: invoke } }],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toMatchObject(demandStorage
                ? { status: 'failed', code: 'plugin_account_storage_unavailable' }
                : { status: 'executed', value: { ok: true } });
        expect(invoke).toHaveBeenCalledOnce();
    });

    it.each(['client', 'daemon'] as const)('keeps a current %s Action discoverable before daemon activation', async (executionTarget) => {
        const contributes = registry({ pluginManifest: manifest({
            surfaces: ['agent', 'mcp', 'cli'],
            execution: executionTarget === 'daemon' ? { target: 'daemon' } : {
                target: 'client',
                client: { artifactId: 'client-action', exportName: 'activate' },
                platforms: ['web'],
            },
        }) });
        let admitted = true;
        const occurrenceId = '7' as PluginRuntimeOccurrenceId;
        const sourceCustody = { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } as const;
        let currentSourceCustody: typeof sourceCustody | null = sourceCustody;
        const target = buildRegistry({
            contributes,
            targetRegistrations: [],
            targetActivationFacts: [],
            readCurrentPluginOccurrenceId: () => occurrenceId,
            readCurrentPluginSourceCustody: () => currentSourceCustody,
            resolveAuthorizationFacts: (_action, purpose) => resolvePluginFinalPolicyAuthorizationFacts({
                pluginId: 'acme.alpha',
                current: { occurrenceId, sourceCustody, desiredOccurrenceId: admitted ? occurrenceId : null,
                    appliedOccurrenceId: null, applied: false, selectedAccess: [] },
                ...(purpose ? { purpose } : {}),
            }),
        });
        // These surfaces came through the real manifest and registry normalizers.
        expect(contributes.actions[0]?.definition).toMatchObject({
            execution: { target: executionTarget },
            surfaces: { agent: true, mcp: true, cli: true },
        });
        expect(target.has('acme.alpha', 'run')).toBe(false);
        const runtime: ResolvedExecutablePluginRuntimeRegistry = {
            ...await resolveExecutablePluginRuntimeRegistry({ contributes, pluginIds: [] }),
            claimReleaseLessDeclarations: async () => undefined,
            contributes, targetActionInvocations: target,
            hookHandlersByHookId: new Map(), agentRuntimesByAgentId: new Map(), scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set(),
            readPluginOccurrenceId: () => occurrenceId,
            readPluginSourceCustody: () => sourceCustody,
            activateContributionsOnDemand: async () => { throw new Error('Discovery must not activate a daemon handler'); },
            resolveCaptureSource: unexpectedCaptureSourceResolution,
            resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
            resolvePromptAssetBlocks: async () => [],
            addRuntimeDisposable: (_pluginId, disposable) => disposable,
            createAgentInvocationServices: async () => createUnavailablePluginServices(),
            retireConsumers: () => {}, dispose: async () => {},
        };
        const controller = createPluginReloadController();
        await controller.adoptPreparedRuntimeRegistry({
            registry: runtime, changedPluginIds: ['acme.alpha'], durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
        });
        const listContributedActionDefinitions = createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller }),
        });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions,
            readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions) });
        const id = formatQualifiedPluginActionId({ pluginId: 'acme.alpha', localId: 'run' });
        try {
            expect(listContributedActionDefinitions().map((definition) => definition.id)).toEqual([id]);
            for (const surface of ['agent', 'mcp', 'cli', 'api'] as const) {
                const search = await executor.execute('action.spec.search', { query: id }, { surface });
                expect(search).toMatchObject({
                    ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({
                        id,
                        surfaces: expect.objectContaining({ agent: true, mcp: true, cli: true }),
                    })]) },
                });
                if (!search.ok) throw new Error('Expected contributed discovery');
                const searchSchema = getActionSpec('action.spec.search').outputSchema;
                if (!searchSchema) throw new Error('Expected Action search output schema');
                expect(searchSchema.safeParse(search.result).success).toBe(true);
                const get = await executor.execute('action.spec.get', { id }, { surface });
                expect(get).toMatchObject({ ok: true, result: { actionSpec: { id } } });
                if (!get.ok) throw new Error('Expected contributed schema');
                const getSchema = getActionSpec('action.spec.get').outputSchema;
                if (!getSchema) throw new Error('Expected Action get output schema');
                expect(getSchema.safeParse(get.result).success).toBe(true);
            }
            expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
                outcome: 'visible', requiresCurrentIntent: false,
            });
            admitted = false;
            expect(listContributedActionDefinitions()).toEqual([]);
            expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
                outcome: 'unavailable', code: 'plugin_action_generation_retired',
            });
            admitted = true;
            currentSourceCustody = null;
            expect(listContributedActionDefinitions()).toEqual([]);
            expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
                outcome: 'unavailable', code: 'plugin_action_handler_missing',
            });
        } finally {
            await controller.shutdown();
        }
    });

    it('keeps client Action catalog visibility behind declared HostAccess policy', () => {
        const pluginManifest = manifest({
            hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } }], optional: [] },
            actionHostAccess: ['api'],
            surfaces: ['agent', 'mcp', 'cli'],
            execution: { target: 'client', client: { artifactId: 'client-action', exportName: 'activate' }, platforms: ['web'] },
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [],
            targetActivationFacts: [],
        });
        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'unavailable', code: 'plugin_host_access_service_unavailable',
        });
    });

    it('delegates daemon Action present-user policy to the runtime final-policy owner', () => {
        const policy = Object.freeze({
            qualifiedId: 'acme.alpha/actions/run',
            occurrenceId: '7',
            dangerLevel: 'safe' as const,
            scopes: Object.freeze(['global']),
            surfaces: Object.freeze(['cli']),
            authorization: Object.freeze({
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
                occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: handler },
            }],
            targetActivationFacts: [fact()],
            resolvePresentUserGatePolicy,
        });

        expect(target.resolvePresentUserGatePolicy?.('acme.alpha', 'run')).toBe(policy);
        expect(resolvePresentUserGatePolicy).toHaveBeenCalledWith('acme.alpha', 'run');
    });

    it('keeps a retained Action registration backed by its own active occurrence', async () => {
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                occurrenceId: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact({ occurrenceId: '7' })],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
    });

    it('carries tracked operation metadata through the resolved registry to the target handler', async () => {
        const update = vi.fn();
        const target = buildRegistry({
            contributes: registry({
                pluginManifest: manifest({
                    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                }),
            }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                occurrenceId: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: async (_input: JsonValue, context: PluginInvocationContext) => {
                        context.operation?.update({ label: 'Working' });
                        return { ok: true };
                    },
                },
            }],
            targetActivationFacts: [fact()],
        });

        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
            operationProgress: {
                update,
            },
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
        expect(update).toHaveBeenCalledWith({ label: 'Working' });
    });

    it('provides a declared Connected Accounts service to the Action handler', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        const actionFormConnectedAccounts = currentActionFormConnectedAccounts();
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                occurrenceId: '7',
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
        const recordOperationCredentialUse = vi.fn();
        const materializeAccount = vi.fn(async ({ account }: Parameters<ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount']>[0]) => {
            expect(account).toEqual(sourceAccount);
            expect(account).not.toEqual(durableSelectedAccount);
            return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer source-a' } };
        });
        const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'materialization-owner',
            store: {
                read: async () => ({ v: 1, bindings: [] }),
                update: async () => { throw new Error('History-gap recovery must not persist a selection'); },
                subscribe: () => ({ dispose() {} }),
            },
            selectTarget: async () => { throw new Error('History-gap recovery must not request a selection'); },
            resolveTarget: async target => target.kind === 'account'
                ? { displayName: 'Source Account', account: target.account } : null,
            materializeAccount,
            projectTargetAccounts: async () => { throw new Error('History-gap recovery must not list Accounts'); },
            assertTargetAccountMaterializable: async () => { throw new Error('History-gap recovery must not materialize a listed Account'); },
        });
        const actionFormConnectedAccounts = {
            resolveBindingIntent: vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(
                purposeBindingOwner.resolveBindingIntent,
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
                    const lease = purposeBindingOwner.activatePurposeBindings(input);
                    return lease;
                },
            ),
        };
        const services = {
            createServices: createPluginInvocationServicesFactory({
                loggerSink: { write() {} },
                connectedAccounts: createStablePluginConnectedAccountsHost(purposeBindingOwner),
            }),
            resolveHostBinding: createTargetActionHostBindingResolver({
                createServiceBinding: (generation, id) => (
                    addConnectedAccountsAvailablePluginInvocationServiceBinding(
                        createLoggerAvailablePluginInvocationServiceBinding(generation, id),
                    )
                ),
            }),
        };
        const contributes = registry({ pluginManifest });
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
                occurrenceId: '7',
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
                triggerId: '11111111-1111-4111-8111-111111111111',
                triggerRevision: 3,
                sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            surface: 'plugin',
            approvalContext: { recordOperationCredentialUse },
        })).resolves.toEqual({ status: 'executed', value: { kind: 'baselined' } });
        expect(resolveAutomationEventHistoryGapSource).toHaveBeenCalledOnce();
        expect(actionFormConnectedAccounts.resolveBindingIntent).toHaveBeenCalledWith(expect.objectContaining({
            target: { kind: 'account', account: sourceAccount },
        }));
        expect(actionFormConnectedAccounts.activatePurposeBindings).toHaveBeenCalledOnce();
        expect(materializeAccount).toHaveBeenCalledOnce();
        expect(recordOperationCredentialUse.mock.calls).toEqual([[{
            v: 1, kind: 'connected_account', label: 'Source Account',
            owner: { kind: 'account', accountId: 'materialization-owner' }, service: sourceAccount.service,
            why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.alpha', localId: 'reset-history' }, purpose: 'source-account' }, target: 'account' },
            currentness: { kind: 'current_at_materialization' },
        }]]);
        expect(handler).toHaveBeenCalledOnce();
    });

    it.each([false, true])('records credential use for the actual Session binding without an Action-form operation lease (occurrence retires: %s)', async retireDuringMaterialization => {
        const pluginManifest = connectedAccountActionManifest({ useDefaultBinding: true });
        const service = { pluginId: 'acme.alpha', localId: 'account' };
        const purpose = { consumer: { pluginId: 'acme.alpha', localId: 'run' }, purpose: 'action-account' };
        const account = { service, accountId: 'actual-session-account' };
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: account, status: 'connected', authenticationModeId: 'manual', configurationReady: true,
            configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            displayName: 'Actual Session actor',
        });
        const recordOperationCredentialUse = vi.fn();
        let current = true;
        const unavailable = async (): Promise<never> => { throw new Error('No selection or inventory is needed'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'credential-owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable,
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: profile.displayName!, observation: { profiles: [profile] } } : null,
            materializeAccount: async () => {
                if (retireDuringMaterialization) current = false;
                return { kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } };
            },
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: async () => undefined,
        });
        const lease = owner.activateSessionPurposeBindings({ sessionId: 'session-1', purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account } }] });
        const handler: ActionHandler = async (_input, context) => {
            await context.services.connectedAccounts.materialize('action-account', { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] });
            await context.services.connectedAccounts.materializeListedAccount({ purpose: 'action-account', account,
                materialization: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } });
            return { ok: true };
        };
        const target = buildRegistry({ contributes: registry({ pluginManifest }), targetActivationFacts: [fact()],
            readCurrentPluginOccurrenceId: () => current ? ('7' as PluginRuntimeOccurrenceId) : null,
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run', value: handler } }],
            createServices: createPluginInvocationServicesFactory({ loggerSink: { write() {} }, connectedAccounts: createStablePluginConnectedAccountsHost(owner) }),
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (generation, id) => addConnectedAccountsAvailablePluginInvocationServiceBinding(createLoggerAvailablePluginInvocationServiceBinding(generation, id)) }),
        });
        const result = await target.invoke({ pluginId: 'acme.alpha', localId: 'run', surface: 'ui', sessionId: 'session-1',
            input: { credentialRef: { service, accountId: 'ignored-authored-account' } }, approvalContext: { recordOperationCredentialUse },
        });
        if (retireDuringMaterialization) {
            expect(result).toMatchObject({ status: 'failed' });
            expect(recordOperationCredentialUse).not.toHaveBeenCalled();
        } else {
            expect(result).toEqual({ status: 'executed', value: { ok: true } });
            expect(recordOperationCredentialUse.mock.calls).toEqual(['account', 'listed_account'].map(selectedTarget => [{
                v: 1, kind: 'connected_account', label: 'Actual Session actor', owner: { kind: 'account', accountId: 'credential-owner' }, service,
                why: { kind: 'purpose_binding', purpose, target: selectedTarget }, currentness: { kind: 'current_at_materialization' },
            }]));
        }
        lease.dispose();
    });

    it('does not dispatch a Connected Accounts Action after its occurrence retires', async () => {
        const pluginManifest = connectedAccountActionManifest();
        const services = connectedAccountActionServices();
        let occurrenceCurrent = true;
        const target = buildRegistry({
            contributes: registry({ pluginManifest }),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async () => ({ ok: true }) },
            }],
            targetActivationFacts: [fact()],
            ...services,
            readCurrentPluginOccurrenceId: () => occurrenceCurrent
                ? ('7' as PluginRuntimeOccurrenceId)
                : null,
        });
        occurrenceCurrent = false;

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
                occurrenceId: '7',
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
                occurrenceId: '7',
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
                occurrenceId: '7',
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

    it('validates a headless host usage input without inventing a plugin contribution', async () => {
        const pluginManifest = manifest({
            inputSchema: { type: 'object', properties: { query: { type: 'object', additionalProperties: true } }, required: ['query'], additionalProperties: false },
            inputHints: { fields: [{ path: 'query', title: 'Usage', widget: 'json', inputType: { hostType: 'usageQuery' } }] },
        });
        const target = buildRegistry({ contributes: registry({ pluginManifest }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async () => ({ accepted: true }) } }],
            targetActivationFacts: [fact()],
        });
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { query: { agents: ['codex'] } }, surface: 'cli' }))
            .toMatchObject({ status: 'executed', value: { accepted: true } });
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { query: { accountId: 'forged' } }, surface: 'cli' }))
            .toMatchObject({ status: 'invalid', code: 'input_type_value_invalid' });
    });

    it('[blocked: authored typed static choices] refuses a headless submitted plugin-type value before the target handler without discarding it', async () => {
        const inputType = { pluginId: 'acme.alpha', localId: 'repository' };
        const pluginManifest = manifest({
            inputSchema: { type: 'object', properties: { repository: { type: 'object', additionalProperties: true } }, required: ['repository'], additionalProperties: false },
            inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select', inputType,
                options: [{ value: { repositoryId: 'one' }, label: 'One' }] }] },
            inputTypes: [{ id: 'repository', title: 'Repository', semantic: 'repository',
                valueSchema: { type: 'object', properties: { repositoryId: { type: 'string', minLength: 1 } },
                    required: ['repositoryId'], additionalProperties: false } }],
        });
        let invoked = 0;
        const target = buildRegistry({ contributes: registry({ pluginManifest }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async () => { invoked++; return { accepted: true }; } } }],
            targetActivationFacts: [fact()],
        });
        const input = { repository: { repositoryId: 'one', machineId: 'not-authority' } };
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input, surface: 'cli' }))
            .toMatchObject({ status: 'invalid', code: 'input_type_value_invalid' });
        expect(invoked).toBe(0);
        expect(input.repository).toEqual({ repositoryId: 'one', machineId: 'not-authority' });
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run',
            input: { repository: { repositoryId: 'one' } }, surface: 'cli' }))
            .toMatchObject({ status: 'executed', value: { accepted: true } });
        expect(invoked).toBe(1);
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run',
            input: { repository: { repositoryId: 'excluded' } }, surface: 'cli' }))
            .toMatchObject({ status: 'invalid', code: 'input_type_option_invalid' });
        expect(invoked).toBe(1);
    });

    it('intersects headless authored choices with the serving type Resource before the handler', async () => {
        const inputType = { pluginId: 'acme.alpha', localId: 'repository' };
        const pluginManifest = manifest({
            inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, required: ['repository'], additionalProperties: false },
            inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select', inputType,
                options: [{ value: 'one', label: 'One' }, { value: 'outside-resource', label: 'Outside' }] }] },
            inputTypes: [{ id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' },
                options: { resource: 'repositories' } }],
            resources: [{ id: 'repositories', source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global' }],
        });
        const contributes = registry({ pluginManifest });
        let invoked = 0;
        let options = [{ value: 'one', label: 'One' }];
        const target = buildRegistry({ contributes,
            readRuntimeRegistry: () => ({ contributes, readUiResource: async () => ({ kind: 'config', digest: 'resource-fixture', contentType: 'application/json',
                bytes: new TextEncoder().encode(JSON.stringify(options)) }) }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async () => { invoked++; return { accepted: true }; } } }],
            targetActivationFacts: [fact()],
        });
        const refused = { repository: 'outside-resource' };
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: refused, surface: 'cli' }))
            .toMatchObject({ status: 'invalid', code: 'input_type_option_invalid' });
        expect(refused).toEqual({ repository: 'outside-resource' });
        expect(invoked).toBe(0);
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { repository: 'one' }, surface: 'cli' }))
            .toMatchObject({ status: 'executed', value: { accepted: true } });
        options = [];
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { repository: 'one' }, surface: 'cli' }))
            .toMatchObject({ status: 'invalid', code: 'input_type_option_invalid' });
        expect(invoked).toBe(1);
    });

    it('narrows headless host multiselections without widening their type schema', async () => {
        const pluginManifest = manifest({
            inputSchema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['queries'], additionalProperties: false },
            inputHints: { fields: [{ path: 'queries', title: 'Usage', widget: 'multiselect', inputType: { hostType: 'usageQuery' },
                options: [{ value: { metric: 'cost' }, label: 'Cost' },
                    { value: { metric: 'tokens' }, label: 'Tokens', disabled: true },
                    { value: { metric: 'forged' }, label: 'Invalid schema' }] }] },
        });
        let invoked = 0;
        const target = buildRegistry({ contributes: registry({ pluginManifest }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async () => { invoked++; return { accepted: true }; } } }],
            targetActivationFacts: [fact()],
        });
        for (const [metric, code] of [['tokens', 'input_type_option_invalid'], ['forged', 'input_type_value_invalid']] as const) {
            expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run',
                input: { queries: [{ metric: 'cost' }, { metric }] }, surface: 'cli' }))
                .toMatchObject({ status: 'invalid', code });
        }
        expect(invoked).toBe(0);
        expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run',
            input: { queries: [{ metric: 'cost' }] }, surface: 'cli' }))
            .toMatchObject({ status: 'executed', value: { accepted: true } });
        expect(invoked).toBe(1);
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
                occurrenceId: '7',
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
                occurrenceId: '7',
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
                occurrenceId: '7',
                registration: {
                    family: 'actions',
                    localId: 'run',
                    value: handler,
                },
            }],
            targetActivationFacts: [fact()],
            ...services,
            actionFormConnectedAccounts: { resolveBindingIntent },
            readCurrentPluginOccurrenceId: () => current
                ? ('7' as PluginRuntimeOccurrenceId)
                : null,
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
                occurrenceId: '7',
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
                occurrenceId: '7',
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

    it('uses exact occurrence currentness instead of the discovery source trust string', async () => {
        const committedHandler = vi.fn(handler);
        const committed = buildRegistry({
            contributes: registry({ trustPolicy: 'prompt' }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: uncommittedHandler },
            }],
            targetActivationFacts: [fact()],
            resolveAuthorizationFacts: () => authorizationFacts({ desiredGeneration: null }),
        });
        await expect(uncommitted.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
        })).resolves.toMatchObject({
            status: 'unavailable', code: 'plugin_action_generation_retired',
        });
        expect(uncommittedHandler).not.toHaveBeenCalled();
    });

    it('discloses the exact external CLI Action operands through its persisted approval', async () => {
        let stored: TargetActionApprovalRequestV1 | undefined;
        let applied: JsonValue | undefined;
        const input = { rowId: 'release-guide', completed: true };
        const inputSchema = defineProtocolObject({
            rowId: defineProtocolString({ minLength: 1 }),
            completed: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
        }, { policy: 'closed' });
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({
                dangerLevel: 'writesLocal',
                inputSchema: inputSchema.jsonSchema,
            }) }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async (value: JsonValue) => { applied = value; return { done: true }; } } }],
            targetActivationFacts: [fact()],
        });
        const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
            create: async request => {
                stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                return { artifactId: 'approval-external-cli-operands' };
            },
            read: async () => stored ? { ...stored, status: 'approved', decision: { kind: 'approve', decidedAtMs: Date.now() } } : null,
        });
        try {
            await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input, surface: 'cli', requestCurrentIntent }))
                .resolves.toEqual({ status: 'deferred', artifactId: 'approval-external-cli-operands' });
            expect(applied).toBeUndefined();
            expect(stored?.secretInputPaths).toEqual([]);
            if (!stored) throw new Error('Expected the contributed Action approval');
            expect(resolveApprovalRequestApproveAdmission(stored)).toMatchObject({ status: 'available', presentation: {
                unrepresentable: null,
                rows: expect.arrayContaining([
                    expect.objectContaining({ path: 'input.rowId', value: JSON.stringify(input.rowId) }),
                    expect.objectContaining({ path: 'input.completed', value: 'true' }),
                ]),
            } });
            // A pre-disclosure development Artifact cannot establish that its
            // admitted values were checked against the secret declarations.
            const { secretInputPaths: _secretInputPaths, ...legacy } = stored;
            expect(resolveApprovalRequestApproveAdmission(legacy))
                .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
            const approved = stored;
            await expect(target.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: approved.input, surface: 'cli', requireCurrentIntent: true,
                requestCurrentIntent: async request => targetActionApprovalMatchesCurrentIntent(approved, request)
                    ? { status: 'approved', fingerprint: request.fingerprint, artifactId: 'approval-external-cli-operands' }
                    : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' },
            })).resolves.toMatchObject({ status: 'executed' });
            expect(applied).toEqual(input);
        } finally { target.dispose(); }
    });

    it('carries the declared secret title into live-only approval while preserving public operands', async () => {
        let stored: TargetActionApprovalRequestV1 | undefined;
        let applied: unknown;
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
        const target = buildRegistry({
            ...owners,
            contributes: registry({ pluginManifest: manifest({
                dangerLevel: 'writesRemote',
                surfaces: ['agent', 'mcp', 'cli'],
                inputSchema: { type: 'object', properties: { releaseTag: { type: 'string' }, value: { type: 'string' } },
                    required: ['releaseTag', 'value'], additionalProperties: false },
                inputHints: { fields: [{ path: 'releaseTag', title: 'Release', widget: 'secret' }] },
            }) }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async (input: JsonValue, context: PluginInvocationContext) => {
                    applied = input;
                    context.services.logger.info(`Publishing ${JSON.stringify(input)}`);
                    return { done: true };
                } } }],
            targetActivationFacts: [fact()],
        });
        const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
            create: async request => {
                stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                return { artifactId: 'approval-external-declared-secret' };
            },
            read: async () => stored?.status === 'open'
                ? { ...stored, status: 'approved', decision: { kind: 'approve', decidedAtMs: Date.now() } } : stored ?? null,
            update: async ({ request }) => {
                stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                return { ok: true };
            },
        });
        try {
            await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run',
                input: { releaseTag: 'private-release-effect', value: 'unrelated-readable' }, surface: 'cli', requestCurrentIntent,
            })).resolves.toMatchObject({ status: 'executed' });
            expect(applied).toEqual({ releaseTag: 'private-release-effect', value: 'unrelated-readable' });
            expect(stored).toMatchObject({ status: 'executed', approvalInputCustody: 'live_only', secretInputLabels: { releaseTag: 'Release' } });
            expect(JSON.stringify(stored)).not.toContain('private-release-effect');
            expect(records).toHaveLength(1);
            expect(JSON.stringify(records)).not.toContain('private-release-effect');
            expect(JSON.stringify(records)).toContain('unrelated-readable');
            expect(resolveApprovalRequestApproveAdmission(stored!)).toMatchObject({ status: 'available', presentation: {
                rows: expect.arrayContaining([
                    { kind: 'value', path: 'input.releaseTag', title: 'Release', value: '', valueFormat: 'confidential' },
                    { kind: 'value', path: 'input.value', title: 'Value', value: '"unrelated-readable"' },
                ]),
            } });
        } finally { target.dispose(); }
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
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                occurrenceId: 'acme-caller-occurrence-1',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'acme-caller-generation-1',
                    installSource: 'archive',
                },
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
                    occurrenceId: 'acme-caller-occurrence-1',
                    sourceCustody: {
                        kind: 'managed',
                        immutableGenerationId: 'acme-caller-generation-1',
                        installSource: 'archive',
                    },
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
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                occurrenceId: 'acme-mounted-occurrence-1',
                sourceCustody: {
                    kind: 'managed' as const,
                    immutableGenerationId: 'acme-mounted-generation-1',
                    installSource: 'archive' as const,
                },
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
    ] as const)('rechecks %s after present intent before calling the handler', async (_label, changedFacts) => {
        let facts = authorizationFacts();
        const actionHandler = vi.fn(handler);
        const target = buildRegistry({
            contributes: registry({ pluginManifest: manifest({ dangerLevel: 'writesRemote' }) }),
            targetRegistrations: [{
                pluginId: 'acme.alpha', occurrenceId: '7',
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
                pluginId: 'acme.alpha', occurrenceId: '7',
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
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '8', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        })).toThrow(/lacks host-stamped occurrence or source custody/i);

        expect(() => buildRegistry({
            contributes: registry(),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'extra', value: handler } }],
            targetActivationFacts: [fact({ required: [], bound: [{ family: 'actions', localId: 'extra' }] })],
        })).toThrow(/no matching manifest action/i);
    });

    it.each(['dormant', 'unavailable'] as const)(
        'omits retained registrations when the plugin occurrence is %s',
        (status) => {
            const target = buildRegistry({
                contributes: registry(),
                targetRegistrations: [{
                    pluginId: 'acme.alpha',
                    occurrenceId: '7',
                    registration: { family: 'actions', localId: 'run', value: handler },
                }],
                targetActivationFacts: [fact({ status })],
            });

            expect(target.has('acme.alpha', 'run')).toBe(false);
            expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
                outcome: 'unavailable',
                code: 'plugin_action_handler_missing',
            });
        },
    );

    it('refreshes a lazily published Action against the current activation facts', async () => {
        const targetRegistrations: Array<{
            pluginId: string;
            occurrenceId: string;
            registration: { family: 'actions'; localId: string; value: typeof handler };
        }> = [];
        let targetActivationFacts: readonly PluginTargetActivationFact[] = [];
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations,
            readTargetActivationFacts: () => targetActivationFacts,
        });

        targetRegistrations.push({
            pluginId: 'acme.alpha',
            occurrenceId: '7',
            registration: { family: 'actions', localId: 'run', value: handler },
        });
        targetActivationFacts = [fact()];

        expect(() => target.refresh()).not.toThrow();
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { ok: true } });
    });

    it('uses host-owned activation metadata and exact qualified identity', async () => {
        let contextVersion: string | undefined;
        const target = buildRegistry({
            contributes: registry(),
            targetRegistrations: [{
                pluginId: 'acme.alpha', occurrenceId: '7',
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
            occurrenceId: string;
            registration: { family: 'actions'; localId: string; value: typeof handler };
        }> = [];
        const targetActivationFacts: PluginTargetActivationFact[] = [];
        const target = buildRegistry({
            contributes: registry(), targetRegistrations, targetActivationFacts,
        });
        expect(target.has('acme.alpha', 'run')).toBe(false);

        targetRegistrations.push({
            pluginId: 'acme.alpha', occurrenceId: '7',
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
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run', value: handler } }],
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
                occurrenceId: '7',
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
                occurrenceId: '7',
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
