import { withTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { runDeploymentRuntimeProbe } from '../../../../../../packages/plugin-sdk/examples/public-authoring/daemon.js';
import fastify from 'fastify';
import { createDeploymentTargetRoleAdmissionHost } from '@/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { registerAccountArtifactRoutes, registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
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
    accountSettingsParse,
    DeploymentDeployInputV1Schema,
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
import { createPluginInvocationServiceBinding, createPluginInvocationServicesFactory, createUnavailablePluginServicesFactory } from './services/factory';
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
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps, listRuntimeContributedActionDefinitions } from './actions/createCommittedContributedActionDeps';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailablePluginServices } from './services/unavailable';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest.js';

import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import { DeploymentTargetRoleInputSchemasV1, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import { createDeploymentTargetRoleAdmissionFixture } from '@/deployments/targets/deploymentTargetRoleAdmission.testkit';
import type { PluginInvocationLogRecord } from './services/logger';
import { createStablePluginHttpHost } from '../fetch/service';
import { createConnectedAccountPluginHttpPurposeHost } from '../fetch/connectedAccountPurpose';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as supabaseEntry from '../../../../../../packages/plugins/deployment-supabase/src/index.js';
import * as neonEntry from '../../../../../../packages/plugins/deployment-neon/src/index.js';
import * as vercelEntry from '../../../../../../packages/plugins/deploy-vercel/src/index.js';
import * as cloudflareEntry from '../../../../../../packages/plugins/deploy-cloudflare/src/index.js';
import { PLUGIN_MANIFEST as VERCEL_ACCOUNT_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest.js';
import { createStablePluginResourcesOwner } from './services/resources';
import { createDynamicResourceActionBinding } from './services/resourceActions';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import axios from 'axios';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineConnectorSecretGrantInputV1Schema, machineSecretGrantSubjectKey,
    computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/deployment-protocol';
import * as installationStore from '@/daemon/identity/store';
import { writeMachineConnectorSecretGrantForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { openMachineSecretGrant, sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createExternalActionMachineRpcExecution, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { projectDeploymentChildRoutingV1 } from '@happier-dev/protocol/deployments/deploymentChildRoutingV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { logger } from '@/ui/logger';
import type { WorkspaceSyncSourceExecutionV1 } from '@happier-dev/protocol/socketRpc';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

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
    omitInputHints?: boolean;
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
                ...(params.useDefaultBinding || params.omitInputHints ? {} : { inputHints: {
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
                createPluginInvocationServiceBinding(generation, id)
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
        pluginId: pluginManifest.id,
        manifestPath: '/tmp/plugin.json',
        daemonEntryPath: '/tmp/plugin.js',
        sourceSpec: { kind: 'path' as const, locator: '/tmp', trustPolicy, installPolicy: 'link' as const },
        manifest: pluginManifest,
    };
}

function registry(params: Readonly<{
    pluginManifest?: ReturnType<typeof manifest>;
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
    referenceManifests?: readonly ReturnType<typeof manifest>[];
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
        referencePlugins: params.referenceManifests?.map(reference => ({ ...loadedPlugin,
            pluginId: reference.id, manifest: reference })),
    });
    if (normalized.actions.length === 0) throw new Error('Expected normalized Action fixture');
    const resolvedActions: readonly ResolvedActionContribution[] = normalized.actions.map(action => ({
        provenance: 'external',
        source: { kind: 'path' },
        ...action,
    }));
    const resolved = createResolvedContributionRegistry({
        actions: resolvedActions,
        inputTypes: normalized.inputTypes.map(type => ({ provenance: 'external' as const, source: { kind: 'path' as const }, ...type,
            identity: createPluginContributionIdentity({ pluginId: type.pluginId, localId: type.definition.id }), manifestPath: activation.manifestPath })),
        resources: normalized.resources.map(resource => ({ provenance: 'external' as const, source: { kind: 'path' as const }, ...resource })),
        occurrenceIdsByPluginId: { [pluginManifest.id]: '7' as PluginRuntimeOccurrenceId },
        materializationIdsByPluginId: {
            [pluginManifest.id]: 'materialization-alpha-current',
        },
        activationTargets: [activation],
    });
    const localId = pluginManifest.contributes.actions[0]?.id;
    if (!localId) throw new Error('Expected one manifest Action fixture');
    const actionRegistryKey = buildQualifiedPluginContributionKey(
        createPluginContributionIdentity({ pluginId: pluginManifest.id, localId }),
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
    it('executes an ordinary Action when the optional Machine provisioner family is absent', async () => {
        const { machineProvisioners: _provisioners, ...contributes } = registry();
        const target = buildRegistry({ contributes, targetActivationFacts: [fact()],
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: {
                family: 'actions', localId: 'run', value: async () => ({ ordinary: true }),
            } }],
        });
        try {
            expect(await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
                .toMatchObject({ status: 'executed', value: { ordinary: true } });
        } finally { target.dispose(); }
    });
    it.each(['vercel', 'workers', 'pages'] as const)('resolves actual %s target options for an agent through Resource custody', async provider => {
        const entry = provider === 'vercel' ? vercelEntry : cloudflareEntry;
        const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
        let target: ReturnType<typeof buildRegistry> | undefined;
        let resourceOwner: Awaited<ReturnType<typeof createStablePluginResourcesOwner>> | undefined;
        const lifetime = new AbortController();
        const previousSnapshot = getActiveAccountSettingsSnapshot();
        try {
            const pluginManifest = normalizePluginManifestV2(entry.manifest);
            const pluginId = pluginManifest.id;
            const accountManifest = provider === 'vercel' ? normalizePluginManifestV2(VERCEL_ACCOUNT_MANIFEST) : pluginManifest;
            const descriptor = accountManifest.contributes.connectedAccountDescriptors[0]!;
            const service = { pluginId: accountManifest.id, localId: descriptor.id };
            const account = { service, accountId: 'selected-options-account' };
            const revision = 'csr_abcdefghijklmnopqrstuv';
            const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
                authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
                configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
                displayName: 'Selected options Account', scopes: [] });
            const unexpected = async (): Promise<never> => { throw new Error('Options do not select or persist credentials'); };
            let acquisitions = 0;
            const custody = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'custody-account',
                store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
                selectTarget: unexpected,
                resolveTarget: createPurposeTargetResolver({ available: true,
                    resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
                resolveCredentialRevision: async () => revision,
                materializeAccount: async ({ credentialRevisionBasis }) => {
                    acquisitions++; credentialRevisionBasis?.captureCredentialRevision(revision);
                    return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer options-fixture-secret' } };
                }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
            });
            const requests: string[] = [];
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                connectedAccounts: createStablePluginConnectedAccountsHost(custody),
                http: createStablePluginHttpHost({
                    purposeHost: createConnectedAccountPluginHttpPurposeHost(custody, { registerRawForRedaction() {} }),
                    adapter: { async request(request) {
                        expect(request.method).toBe('GET');
                        expect(request.headers?.authorization === 'Bearer options-fixture-secret').toBe(true);
                        requests.push(request.url);
                        const rows = provider === 'vercel' ? { projects: [{ id: 'prj-selected', name: 'Selected project', accountId: 'team-selected' }],
                            pagination: { count: 1, next: null, prev: null } }
                            : { success: true, result: [provider === 'pages' ? { id: 'project-selected', name: 'Selected project' }
                                : { id: 'selected-script', tag: 'b'.repeat(32) }], result_info: { page: 1, total_pages: 1 } };
                        return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(rows)) };
                    }, async openWebSocket() { throw new Error('No WebSocket in finite options reads'); } },
                }),
            });
            const contributes = registry({ pluginManifest, ...(provider === 'vercel' ? { referenceManifests: [accountManifest] } : {}) });
            const localIds = ['targets-inspect-v1', 'target-options-read'];
            const stored = createDeploymentTargetRoleAdmissionFixture('inspect');
            target = buildRegistry({ ...owners, contributes, executionRealm: 'account', actionFormConnectedAccounts: custody,
                readDeploymentTargetRoleAdmissionHost: async () => stored.host,
                targetActivationFacts: [fact({ pluginId, pluginVersion: pluginManifest.version,
                    required: localIds.map(localId => ({ family: 'actions' as const, localId })),
                    bound: localIds.map(localId => ({ family: 'actions' as const, localId })) })],
                targetRegistrations: localIds.map(localId => {
                    const value = kit.registration('actions', localId);
                    if (!value) throw new Error(`Actual options Action did not activate: ${localId}`);
                    return { pluginId, occurrenceId: '7', registration: { family: 'actions' as const, localId, value } };
                }),
            });
            const admittedTarget = target;
            const recordedPrincipal = { kind: 'account' as const, accountId: 'custody-account',
                purpose: { consumer: { pluginId, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                target: { kind: 'account' as const, account } };
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: 'home:custody-account' });
            resourceOwner = await createStablePluginResourcesOwner({ registry: { resources: contributes.resources }, generations: new Map(),
                dynamicOccurrenceIdsByPluginId: new Map([[pluginId, '7']]),
                dynamicProducers: contributes.resources.map(resource => {
                    const runtime = kit.registration('resources', resource.definition.id);
                    if (!runtime) throw new Error('Actual target-options Resource did not activate');
                    return { pluginId, localId: resource.definition.id, runtime, prepareRuntime: async () => {} };
                }),
                bindDynamicResourceActions: binding => createDynamicResourceActionBinding({ binding,
                    readCaller: () => ({ kind: 'plugin', pluginId, occurrenceId: binding.occurrenceId,
                        contribution: { id: binding.resourceId, qualifiedId: `${pluginId}/resources/${binding.resourceId}` },
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } }),
                    invoke: async ({ action, ...invocation }) => {
                        const result = await admittedTarget.invoke({ ...invocation, pluginId: action.pluginId, localId: action.localId });
                        if (result.status === 'deferred') throw new Error('Safe options read cannot defer');
                        return result;
                    },
                }),
            });
            const activeResourceOwner = resourceOwner;
            // Real runtime activation prepares global Resource descriptors
            // before the first UI options query arrives.
            await activeResourceOwner.preparePlugin(pluginId);
            const runtime = { contributes, targetActionInvocations: target,
                readUiResource: async (request: Parameters<NonNullable<ResolvedExecutablePluginRuntimeRegistry['readUiResource']>>[0]) => {
                    const resources = await activeResourceOwner.bindForResource({ pluginId: request.callerPluginId,
                        resourceId: request.resourceId, query: request.query, signal: request.signal ?? lifetime.signal,
                        isOccurrenceCurrent: () => true, ...(request.context ? { context: request.context } : {}) });
                    return resources.read(request.resourceId, { signal: request.signal });
                } };
            const definitions = (selection?: Parameters<NonNullable<ReturnType<typeof createUnavailableActionTransportDeps>['listContributedActionDefinitions']>>[0]) =>
                listRuntimeContributedActionDefinitions(runtime, selection);
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createRegistryInputTypeDeps(runtime),
                listContributedActionDefinitions: definitions, readContributedActionSchemas: createCommittedContributedActionSchemaReader(definitions) });
            const draftInput = { credentialRef: account, credentialPrincipal: { kind: 'account', accountId: 'custody-account',
                purpose: { consumer: { pluginId, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                target: { kind: 'account', account } }, ...(provider === 'vercel' ? {} : { product: provider }),
                providerIdentity: { providerAccountId: provider === 'vercel' ? 'team-selected' : 'a'.repeat(32) } };
            // SEC-REVIEW-1103A N2: refuse the actual options draft before custody or HTTP.
            for (const foreignDraft of [
                { ...draftInput, credentialPrincipal: { ...recordedPrincipal, accountId: 'foreign-owner' } },
                { ...draftInput, credentialRef: { ...account, accountId: 'foreign-ref' } },
            ]) {
                expect(await executor.execute('action.options.resolve', {
                    actionId: `${pluginId}/actions/targets-inspect-v1`,
                    fieldPath: 'providerIdentity.providerResourceId', draftInput: foreignDraft, query: 'selected',
                }, { surface: 'agent', runtimeAccountId: 'custody-account', signal: lifetime.signal }))
                    .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                expect(acquisitions).toBe(0);
                expect(requests).toEqual([]);
            }
            const result = await executor.execute('action.options.resolve', { actionId: `${pluginId}/actions/targets-inspect-v1`,
                fieldPath: 'providerIdentity.providerResourceId', draftInput, query: 'selected' },
                { surface: 'agent', runtimeAccountId: 'custody-account', signal: lifetime.signal });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: [{
                value: provider === 'vercel' ? 'prj-selected' : provider === 'pages' ? 'project-selected' : 'b'.repeat(32),
            }] } });
            expect(requests).toHaveLength(1);
            expect(acquisitions).toBe(1);
            expect(JSON.stringify(result).includes('options-fixture-secret')).toBe(false);
        } finally {
            lifetime.abort(); resourceOwner?.retirePlugin(entry.manifest.id); target?.dispose(); await kit.dispose();
            if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot); else resetActiveAccountSettingsSnapshotForTests();
        }
    });
    it.each([['vercel', false], ['vercel', true], ['cloudflare', false], ['workers', false], ['preview', false],
        ['vercel', false, true], ['workers', false, true]] as const)('composes the actual %s Account Action through purpose HTTP (portable Home: %s, installed child: %s)', async (provider, homeRegression, installedChild) => {
        // QA-VERCEL-1102 #42: exact public input; the local profile is a different identity.
        const qaInput = {
            "v": 1,
            "serverId": "srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN",
            "environmentId": "cmvx1tgtc002fmc8mtjxkne1x",
            "expectedRevision": 24,
            "credentialRef": {
                        "service": {
                                    "pluginId": "happier.machine.vercel",
                                    "localId": "vercel-account"
                        },
                        "accountId": "e200efeb-bcd4-417b-bad1-9c600b4fb89f"
            },
            "credentialPrincipal": {
                        "kind": "account",
                        "accountId": "5e3a0581-6f3d-4e73-bf40-383db0be6c3e",
                        "purpose": {
                                    "consumer": {
                                                "pluginId": "happier.deploy.vercel",
                                                "localId": "targets-inspect-v1"
                                    },
                                    "purpose": "deploy.manage"
                        },
                        "target": {
                                    "kind": "account",
                                    "account": {
                                                "service": {
                                                            "pluginId": "happier.machine.vercel",
                                                            "localId": "vercel-account"
                                                },
                                                "accountId": "e200efeb-bcd4-417b-bad1-9c600b4fb89f"
                                    }
                        }
            },
            "providerIdentity": {
                        "providerAccountId": "team_IfWoDydKwqFwMDLSXA80FDAW",
                        "providerResourceId": "prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj",
                        "providerEnvironment": "production"
            },
            "providerEnvironment": {
                        "kind": "production"
            },
            "repository": {
                        "kind": "github",
                        "deployment": "https://github.com",
                        "repository": "happier-dev/triage-qa-sandbox"
            }
};
        const custodyAccountId = homeRegression ? qaInput.credentialPrincipal.accountId : 'custody-account';
        const home = fastify();
        let restoreHttp: (() => void) | undefined;
        let disposeRequester: (() => Promise<void>) | undefined;
        let requesterChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
        let restoreInstallation: (() => void) | undefined;
        const entry = provider === 'vercel' ? vercelEntry : cloudflareEntry;
        const worker = provider === 'workers' || provider === 'preview';
        const signedContinuation = !homeRegression && (provider === 'vercel' || provider === 'workers');
        const previewId = 'c'.repeat(32);
        const previewName = 'review/one';
        const gitBranch = 'feature/source';
        const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
        let target: ReturnType<typeof buildRegistry> | undefined;
        let resourceOwner: Awaited<ReturnType<typeof createStablePluginResourcesOwner>> | undefined;
        let runtime: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'readUiResource'> | null = null;
        const lifetime = new AbortController();
        const previousSnapshot = getActiveAccountSettingsSnapshot();
        try {
            const pluginManifest = normalizePluginManifestV2(entry.manifest);
            const pluginId = pluginManifest.id;
            const localId = provider === 'vercel' ? 'targets-inspect-v1' : worker ? 'targets-inspect-v1' : 'cloudflare-named/disable';
            const stored = createDeploymentTargetRoleAdmissionFixture('deploy');
            const actionIds = provider === 'vercel' ? [localId, 'project-link', 'deploy', 'observe', 'target-options-read'] : worker
                ? [localId, 'workers-deploy', 'workers-observe', 'target-options-read'] : [localId, 'cloudflare-named/zone-read', 'cloudflare-named/configure'];
            const accountManifest = provider === 'vercel' ? normalizePluginManifestV2(VERCEL_ACCOUNT_MANIFEST) : pluginManifest;
            const descriptor = accountManifest.contributes.connectedAccountDescriptors[0]!;
            const service = { pluginId: accountManifest.id, localId: descriptor.id };
            const account = homeRegression ? qaInput.credentialRef : { service, accountId: 'selected-account' };
            const providerAccountId = homeRegression ? qaInput.providerIdentity.providerAccountId : 'team-selected';
            const projectId = homeRegression ? qaInput.providerIdentity.providerResourceId : 'prj-selected';
            const [repositoryOwner, repositoryName] = (homeRegression ? qaInput.repository.repository : 'example/project').split('/');
            const purpose = provider !== 'cloudflare' ? 'deploy.manage' : 'tunnel.manage';
            const revision = 'csr_abcdefghijklmnopqrstuv';
            const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
                authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
                configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
                displayName: 'Selected platform Account', scopes: [] });
            const unexpected = async (): Promise<never> => { throw new Error('No credential selection or persistence in this Action'); };
            let acquisitions = 0;
            const owner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: custodyAccountId,
                store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
                selectTarget: unexpected,
                resolveTarget: createPurposeTargetResolver({ available: true,
                    resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
                resolveCredentialRevision: async () => revision,
                materializeAccount: async ({ credentialRevisionBasis }) => {
                    acquisitions++;
                    credentialRevisionBasis?.captureCredentialRevision(revision);
                    return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer platform-fixture-credential' } };
                }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
            });
            const requests: { method: string; path: string }[] = [];
            const submittedCommits: unknown[] = [];
            let providerDenied = false;
            let ingress: unknown[] = [{ hostname: 'owned.example', service: 'http://localhost:3000' },
                { hostname: 'foreign.example', service: 'http://localhost:4000' }, { service: 'http_status:404' }];
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                connectedAccounts: createStablePluginConnectedAccountsHost(owner),
                http: createStablePluginHttpHost({
                    purposeHost: createConnectedAccountPluginHttpPurposeHost(owner, { registerRawForRedaction() {} }),
                    adapter: {
                        async request(request) {
                            const url = new URL(request.url);
                            requests.push({ method: request.method, path: url.pathname });
                            // Compare as a boolean so assertion output cannot disclose the credential.
                            expect(request.headers?.authorization === 'Bearer platform-fixture-credential').toBe(true);
                            let value: unknown;
                            if (worker && url.pathname === '/client/v4/accounts') {
                                value = { success: true, result: [{ id: 'a'.repeat(32), name: 'Selected Account' }],
                                    result_info: { page: 1, total_pages: 1 } };
                            } else if (worker && url.pathname.endsWith('/workers/scripts')) {
                                value = { success: true, result: [{ id: 'app', tag: 'b'.repeat(32) }] };
                            } else if (worker && url.pathname.endsWith('/workers/workers/app/previews')) {
                                value = { success: true, result: [{ id: previewId, name: previewName }] };
                            } else if (worker) {
                                if (request.method === 'POST') submittedCommits.push(JSON.parse(new TextDecoder().decode(request.body)));
                                const previewPreparation = provider === 'preview' && request.method === 'GET'
                                    && !url.pathname.includes('/builds/builds/');
                                value = { success: true, result: previewPreparation
                                    ? url.pathname.includes('/workers/workers/') ? { id: previewId, name: previewName }
                                        : url.pathname.includes('/previews/') ? { preview_id: previewId, branch: gitBranch }
                                            : { script_tag: 'b'.repeat(32), previews_enabled: true,
                                                git_repository: { provider_type: 'github', provider_account_name: 'example', repo_name: 'project', repo_id: '42' } }
                                    : url.pathname.endsWith('/triggers')
                                    ? [{ trigger_uuid: 'trigger-selected', external_script_id: 'b'.repeat(32),
                                        repo_connection: { provider_type: 'github', provider_account_name: 'example', repo_name: 'project', repo_id: '42' } }]
                                    : { build_uuid: 'build-selected', status: 'running' } };
                            } else if (provider === 'vercel') {
                                value = url.pathname === '/v2/user' ? { user: { id: 'user-selected', username: 'Selected user' } }
                                    : url.pathname === '/v2/teams' ? { teams: [{ id: providerAccountId, name: 'Selected Team' }], pagination: { next: null } }
                                    : url.pathname === '/v10/projects' ? { projects: [{ id: projectId, name: 'Selected project', accountId: providerAccountId }], pagination: { next: null } }
                                    : url.pathname.endsWith('/custom-environments') ? { environments: [] }
                                    : url.pathname.startsWith('/v13/deployments')
                                    ? { id: 'dpl-selected', projectId: 'prj-selected', readyState: request.method === 'POST' ? 'BUILDING' : 'READY' }
                                    : url.pathname.startsWith('/v9/projects/')
                                    ? { id: projectId, accountId: providerAccountId, name: 'Selected project',
                                        link: { type: 'github', org: repositoryOwner, repo: repositoryName, repoId: '42' } }
                                    : { repos: [{ id: 42, provider: 'github', namespace: repositoryOwner, slug: repositoryName }] };
                            } else if (url.pathname === '/client/v4/zones/zone-selected') {
                                value = { success: true, result: { id: 'zone-selected', name: 'example.test',
                                    account: { id: 'account-selected' }, status: 'active', paused: false, type: 'full' } };
                            } else if (url.pathname.endsWith('/dns_records')) {
                                value = { success: true, result: [], result_info: { page: 1, total_pages: 1 } };
                            } else if (url.pathname.endsWith('/token')) {
                                value = { success: true, result: 'synthetic-connector-token' };
                            } else if (url.pathname.endsWith('/configurations')) {
                                if (request.method === 'PUT') ingress = JSON.parse(new TextDecoder().decode(request.body)).config.ingress;
                                value = { success: true, result: { version: 1, config: { ingress } } };
                            } else value = { success: true, result: { id: 'tunnel-selected', account_tag: 'account-selected',
                                name: 'selected-tunnel', remote_config: true, deleted_at: null } };
                            return { status: providerDenied ? 403 : 200, finalUrl: request.url, headers: {},
                                body: new TextEncoder().encode(JSON.stringify(value)) };
                        }, async openWebSocket() { throw new Error('No WebSocket requested'); },
                    },
                }),
            });
            const contributes = registry({ pluginManifest,
                ...(provider === 'vercel' ? { referenceManifests: [accountManifest] } : {}) });
            if (homeRegression) {
                const header = stored.state.environment.environment;
                Object.assign(header, { id: qaInput.environmentId, serverId: qaInput.serverId, revision: qaInput.expectedRevision,
                    owner: { kind: 'account', accountId: custodyAccountId }, controllerMachineId: 'eadc2422-b42b-478d-97b1-af9b530d5f08' });
                registerAccountHomeHttp(home, { accountId: custodyAccountId, serverId: qaInput.serverId });
                const artifacts = registerAccountArtifactRoutes(home, custodyAccountId, { encryptionMode: 'plain' });
                artifacts.seed(header.contentArtifactId,
                    encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'QA Environment' }),
                    encodePlainArtifactStoredContent({ body: JSON.stringify(stored.state.environment.content) }));
                home.get('/v1/deployments/environments/:environmentId', async () => ({ ok: true,
                    environment: header, targetLinks: [] }));
                restoreHttp = installAxiosFastifyAdapter({ app: home, origin: 'https://home.test' });
            }
            target = buildRegistry({ ...owners, contributes, executionRealm: 'account', readRuntimeRegistry: () => runtime,
                targetActivationFacts: [fact({ pluginId, pluginVersion: pluginManifest.version,
                    required: actionIds.map(localId => ({ family: 'actions' as const, localId })),
                    bound: actionIds.map(localId => ({ family: 'actions' as const, localId })) })],
                targetRegistrations: actionIds.map(localId => {
                    const value = kit.registration('actions', localId);
                    if (!value) throw new Error('Actual platform lifecycle Action did not activate');
                    return { pluginId, occurrenceId: '7', registration: { family: 'actions' as const, localId, value } };
                }),
                actionFormConnectedAccounts: owner,
                ...(provider !== 'cloudflare' ? { readDeploymentTargetRoleAdmissionHost: homeRegression
                    ? context => createDeploymentTargetRoleAdmissionHost(context, {
                        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                        accountExecution: { credentials: { token: `fixture.${Buffer.from(JSON.stringify({ sub: custodyAccountId })).toString('base64url')}.signature`, encryption: null },
                            serverUrl: 'https://home.test', serverId: 'qa-local-profile', serverIdentityId: qaInput.serverId,
                            isCurrent: async () => true },
                        readCurrentMachineId: () => 'eadc2422-b42b-478d-97b1-af9b530d5f08',
                    }) : async context => context.externalActionExecutionAuthorization
                        ? createDeploymentTargetRoleAdmissionHost(context, {
                            resolveRequesterIdentity: stored.host.resolveRequesterIdentity,
                            readCurrentMachineId: () => 'controller',
                        }) : stored.host } : {}),
            });
            if (provider !== 'cloudflare') {
                const admittedTarget = target;
                setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                    loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: `home:${custodyAccountId}` });
                // This Account activation owns dynamic Resources; packaged brand assets belong to a separate immutable generation.
                const accountResources = contributes.resources.filter(resource => kit.registration('resources', resource.definition.id));
                resourceOwner = await createStablePluginResourcesOwner({ registry: { resources: accountResources }, generations: new Map(),
                    dynamicOccurrenceIdsByPluginId: new Map([[pluginId, '7']]),
                    dynamicProducers: accountResources.flatMap(resource => {
                        const runtime = kit.registration('resources', resource.definition.id);
                        // Daemon-only Resources are declared but are not activated in this Account runtime.
                        if (!runtime) return [];
                        // The real plugin testkit has already activated this runtime.
                        return [{ pluginId, localId: resource.definition.id, runtime, prepareRuntime: async () => {} }];
                    }),
                    bindDynamicResourceActions: binding => createDynamicResourceActionBinding({ binding,
                        readCaller: () => ({ kind: 'plugin', pluginId, occurrenceId: binding.occurrenceId,
                            contribution: { id: binding.resourceId, qualifiedId: `${pluginId}/resources/${binding.resourceId}` },
                            sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } }),
                        invoke: async ({ action, ...invocation }) => {
                            const result = await admittedTarget.invoke({ ...invocation, pluginId: action.pluginId, localId: action.localId });
                            if (result.status === 'deferred') throw new Error('Safe options read cannot defer');
                            return result;
                        },
                    }),
                });
                const activeResourceOwner = resourceOwner;
                runtime = { contributes,
                    readUiResource: async request => {
                        const resources = await activeResourceOwner.bindForResource({ pluginId: request.callerPluginId,
                            resourceId: request.resourceId, query: request.query, signal: request.signal ?? lifetime.signal,
                            isOccurrenceCurrent: () => true, ...(request.context ? { context: request.context } : {}) });
                        return resources.read(request.resourceId, { signal: request.signal });
                    } };
            }
            const input: Readonly<Record<string, JsonValue>> = homeRegression ? qaInput : provider !== 'cloudflare' ? {
                v: 1, serverId: 'home', environmentId: stored.input.environmentId, expectedRevision: 1, credentialRef: account,
                credentialPrincipal: { kind: 'account', accountId: 'custody-account',
                    purpose: { consumer: { pluginId, localId }, purpose }, target: { kind: 'account', account } },
                providerIdentity: provider === 'vercel'
                    ? { providerAccountId: 'team-selected', providerResourceId: 'prj-selected', providerEnvironment: 'production' }
                    : { providerAccountId: 'a'.repeat(32), providerResourceId: 'b'.repeat(32),
                        providerEnvironment: provider === 'preview' ? `preview:${JSON.stringify(['app', previewName])}` : 'script:app' },
                providerEnvironment: provider === 'vercel' ? { kind: 'production' } : provider === 'preview'
                    ? { kind: 'preview', scriptName: 'app', previewName } : { kind: 'script', scriptName: 'app' },
                repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/project' },
                ...(worker ? { product: 'workers' } : {}),
                ...(provider === 'workers' ? { triggerUuid: 'trigger-selected' } : {}),
            } : { credentialRef: account, accountId: 'account-selected', zoneId: 'zone-selected', tunnelId: 'tunnel-selected',
                owned: [{ hostname: 'owned.example', expectedService: 'http://localhost:3000' }], dnsOwnership: [] };
            const invoke = (value: JsonValue) => target!.invoke({ pluginId, localId, input: value, surface: homeRegression ? 'cli' : 'plugin',
                ...(homeRegression ? { approvalContext: { surface: 'cli' as const, runtimeAccountId: custodyAccountId,
                    serverId: 'qa-local-profile', serverIdentityId: qaInput.serverId } } : {}),
                caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                    contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
            const result = await invoke(input);
            expect(result, JSON.stringify({ status: result.status, code: 'code' in result ? result.code : null,
                requests })).toMatchObject({ status: 'executed', value: provider !== 'cloudflare'
                ? { credentialPrincipal: input.credentialPrincipal,
                    preparedNative: provider === 'vercel' ? { projectName: 'Selected project', gitSource: { type: 'github', repoId: '42' } }
                        : provider === 'preview' ? { projectName: 'app', previewId, gitBranch, workerTag: 'b'.repeat(32), scriptName: 'app' }
                            : { projectName: 'app', triggerUuid: 'trigger-selected' },
                    repositoryAccess: { status: 'ready' } }
                : { kind: 'verified', tunnelId: 'tunnel-selected', dnsOwnership: [] } });
            expect(acquisitions).toBeGreaterThan(0);
            expect(requests).toEqual(provider === 'vercel'
                ? [{ method: 'GET', path: `/v9/projects/${projectId}/custom-environments` },
                    { method: 'GET', path: `/v9/projects/${projectId}` }, { method: 'GET', path: '/v1/integrations/search-repo' }]
                : provider === 'preview' ? [
                    { method: 'GET', path: '/client/v4/accounts' },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/workers/scripts` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/workers/workers/app/previews` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/workers/workers/app/previews/${encodeURIComponent(previewName)}` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/workers/${'b'.repeat(32)}/previews/${previewId}` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/workers/${'b'.repeat(32)}` }]
                : provider === 'workers' ? [{ method: 'GET', path: '/client/v4/accounts' },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/workers/scripts` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/workers/workers/app/previews` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/workers/${'b'.repeat(32)}/triggers` },
                    { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/workers/${'b'.repeat(32)}/triggers` }]
                : [{ method: 'GET', path: '/client/v4/accounts/account-selected/cfd_tunnel/tunnel-selected' },
                    { method: 'GET', path: '/client/v4/accounts/account-selected/cfd_tunnel/tunnel-selected/configurations' },
                    { method: 'GET', path: '/client/v4/zones/zone-selected/dns_records' },
                    { method: 'PUT', path: '/client/v4/accounts/account-selected/cfd_tunnel/tunnel-selected/configurations' }]);
            if (provider === 'cloudflare') expect(ingress).toEqual([
                { hostname: 'foreign.example', service: 'http://localhost:4000' }, { service: 'http_status:404' }]);
            expect(JSON.stringify(result).includes('platform-fixture-credential')).toBe(false);
            if (homeRegression) {
                requests.length = 0;
                const acquired = acquisitions;
                expect(await invoke({ ...qaInput, serverId: 'srv_another_home' }))
                    .toMatchObject({ status: 'unavailable', code: 'server_scope_mismatch' });
                expect(requests).toEqual([]);
                expect(acquisitions).toBe(acquired);
                return;
            }
            if (provider !== 'cloudflare') {
                if (result.status !== 'executed' || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
                    throw new Error('Expected the real preparation result');
                }
                const { repository: _repository, ...preparedLinkScope } = input;
                const linked = provider === 'vercel' ? await target!.invoke({ pluginId, localId: 'project-link',
                    input: { ...preparedLinkScope, ...result.value,
                        credentialPrincipal: { ...DeploymentTargetRoleInputSchemasV1.link.shape.credentialPrincipal.parse(input.credentialPrincipal),
                        purpose: { consumer: { pluginId, localId: 'project-link' }, purpose } } },
                    surface: 'plugin', approvalContext: stored.request.context,
                    caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                        contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } }) : result;
                expect(linked).toMatchObject({ status: 'executed' });
                if (linked.status !== 'executed' || !linked.value || typeof linked.value !== 'object' || Array.isArray(linked.value)) {
                    throw new Error('Expected the actual Link preparation');
                }
                const deployInput = DeploymentTargetRoleInputSchemasV1.deploy.parse({ ...stored.input,
                    ...linked.value, credentialRef: account });
                if (deployInput.credentialPrincipal.kind !== 'account') throw new Error('Expected the fixture Account credential');
                const selected = stored.state.environment.targetLinks[0]!;
                selected.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: provider === 'vercel' ? 'runtime' : 'workers' } };
                selected.targetLink.targetKind = provider === 'vercel' ? 'vercel' : 'cloudflare-workers';
                selected.content = { credentialPrincipal: deployInput.credentialPrincipal,
                    providerIdentity: deployInput.providerIdentity, providerEnvironment: deployInput.providerEnvironment,
                    repositoryAccess: deployInput.repositoryAccess, preparedNative: deployInput.preparedNative };
                const platform = stored.state.receipt.content.platform;
                if (!platform) throw new Error('Expected canonical platform receipt');
                Object.assign(platform, selected.content);
                const invokeRole = (role: 'deploy' | 'observe', value: unknown) => target!.invoke({ pluginId,
                    localId: provider === 'vercel' ? role : `workers-${role}`,
                    input: value, surface: 'plugin', operationAcceptance: stored.request.context.operationAcceptance,
                    approvalContext: stored.request.context,
                    caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                        contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
                requests.length = 0;
                const acquisitionsBeforeMismatch = acquisitions;
                if (provider === 'vercel') {
                    const optionsRefusal = await target!.invoke({ pluginId, localId: 'target-options-read',
                        input: { credentialRef: account, credentialPrincipal: { ...deployInput.credentialPrincipal,
                            accountId: 'foreign-owner' }, fieldPath: 'projectId', providerAccountId }, surface: 'plugin',
                        caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                            contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                            sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
                    expect(optionsRefusal).toMatchObject({ status: 'failed', code: 'deployment_access_denied',
                        data: { failureCause: { phase: 'deployment.target.admission.credential_principal',
                            errorClass: 'Error', errorCode: null, httpStatus: null } }, actionHandlerInvocation: 'notStarted' });
                    expect(requests).toEqual([]);
                    expect(acquisitions).toBe(acquisitionsBeforeMismatch);
                }
                const mismatched = await invokeRole('deploy', { ...deployInput,
                    providerIdentity: { ...deployInput.providerIdentity, providerResourceId: 'private-substituted-resource' } });
                expect(mismatched).toMatchObject({ status: 'failed', code: 'deployment_access_denied',
                    data: { failureCause: { phase: 'deployment.target.admission.link.provider_identity',
                        errorClass: 'Error', errorCode: null, httpStatus: null } }, actionHandlerInvocation: 'notStarted' });
                expect(requests).toEqual([]);
                expect(acquisitions).toBe(acquisitionsBeforeMismatch);
                expect(JSON.stringify(mismatched)).not.toContain('private-substituted-resource');
                stored.state.environment.environment.owner = { kind: 'team', teamId: 'shared-team' };
                selected.targetLink.createdByAccountId = 'another-team-manager';
                const beforeForeignAuthor = acquisitions;
                expect(await invokeRole('deploy', deployInput))
                    .toMatchObject({ status: 'failed', code: 'deployment_access_denied' });
                expect(requests).toEqual([]);
                expect(acquisitions).toBe(beforeForeignAuthor);
                selected.targetLink.createdByAccountId = deployInput.credentialPrincipal.accountId;
                if (provider === 'preview') {
                    const beforeSubstitution = acquisitions;
                    expect(await invokeRole('deploy', { ...deployInput,
                        preparedNative: { ...deployInput.preparedNative, previewId: 'd'.repeat(32) } }))
                        .toMatchObject({ status: 'failed', code: 'deployment_access_denied' });
                    expect(requests).toEqual([]);
                    expect(acquisitions).toBe(beforeSubstitution);
                }
                // Accepted receipt reads deliberately project read-only capabilities.
                // Only the host's exact admitted child can continue this deployment.
                const capabilities = stored.state.environment.environment.capabilities;
                stored.state.environment.environment.capabilities = { role: 'reader', read: true, deploy: false,
                    manage: false, manageBindings: false, manageTargets: false, delete: false };
                let deployed = await invokeRole('deploy', deployInput);
                expect(deployed).toMatchObject({ status: 'failed', code: 'deployment_access_denied' });
                const action = { pluginId, localId: provider === 'vercel' ? 'deploy' : 'workers-deploy' };
                const roleInput = normalizeStrictJsonValue(deployInput);
                let childRootContext = stored.request.context;
                let denyEnvironmentRead: false | 'classified' | 'unclassified' = false;
                const signedReads: { path: string; effectActionId: string; reviewedChild: unknown }[] = [];
                let forwardedPacket: WorkspaceSyncSourceExecutionV1 | undefined;
                if (signedContinuation) {
                    // Real requester custody and signing; Home HTTP/socket and vendor HTTP are boundaries.
                    requesterChannel = await createRequesterCurrentnessSocketHarness();
                    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
                    const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
                        version: 1, createdAt: 1, installationId: 'installation-controller',
                        publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url'),
                    });
                    restoreInstallation = () => installation.mockRestore();
                    const machineTarget = { kind: 'machine' as const, machineId: 'controller' };
                    const rootInput = installedChild ? DeploymentDeployInputV1Schema.parse({
                        serverId: deployInput.serverId, environmentId: deployInput.environmentId,
                        expectedRevision: deployInput.expectedRevision, targetLinkId: deployInput.targetLinkId,
                        expectedTargetLinkRevision: deployInput.expectedTargetLinkRevision, requestKey: 'installed-deploy',
                        contentArtifactId: stored.state.receipt.deployment.contentArtifactId,
                        contentHeaderVersion: stored.state.receipt.deployment.contentHeaderVersion,
                        contentBodyVersion: stored.state.receipt.deployment.contentBodyVersion,
                    }) : { serverId: deployInput.serverId,
                        environmentId: deployInput.environmentId, targetLinkId: deployInput.targetLinkId };
                    const envelope = { v: 1 as const, requestId: `signed-${provider}-deploy`, target: machineTarget, input: rootInput };
                    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `signed-${provider}-home-proof`, binding: {
                        accountId: custodyAccountId, authentication: { kind: 'account', tokenEpoch: 7 },
                        serverIdentityId: 'home', machineId: machineTarget.machineId, custodianAccountId: custodyAccountId,
                        installationId: 'installation-controller', actionId: 'deployments.deploy', requestId: envelope.requestId,
                        target: machineTarget, accountEncryptionMode: 'plain', deploymentChildRoot: true,
                        environmentId: deployInput.environmentId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    } });
                    const tokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
                    const credentials = { token: `${tokenPart({ alg: 'none' })}.${tokenPart({ sub: custodyAccountId,
                        tokenEpoch: 7, provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`, encryption: null };
                    registerAccountHomeHttp(home, { accountId: custodyAccountId, serverId: 'home' });
                    const artifacts = registerAccountArtifactRoutes(home, custodyAccountId, { encryptionMode: 'plain' });
                    for (const [reference, content, kind] of [
                        [stored.state.environment.environment, stored.state.environment.content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1],
                        [selected.targetLink, selected.content, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1],
                        [stored.state.receipt.deployment, stored.state.receipt.content, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1],
                    ] as const) artifacts.seed(reference.contentArtifactId,
                        encodePlainArtifactStoredContent({ kind, title: 'Selected deployment record' }),
                        encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
                    home.get('/v1/deployments/environments/:environmentId', async (_request, reply) => denyEnvironmentRead
                        ? reply.code(401).send({ error: 'invalid_token',
                            ...(denyEnvironmentRead === 'classified' ? { authorizationRefusal: 'effect_family' } : {}) })
                        : { ok: true, environment: stored.state.environment.environment,
                            targetLinks: stored.state.environment.targetLinks.map(row => row.targetLink) });
                    home.get('/v1/deployments/receipts/:deploymentId', async () => ({
                        ok: true, deployment: stored.state.receipt.deployment,
                    }));
                    home.addHook('preHandler', async request => {
                        if (!request.url.startsWith('/v1/deployments/') && !request.url.startsWith('/v1/artifacts/')) return;
                        const effectActionId = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
                        const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
                        const encodedChild = request.headers[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER];
                        expect(typeof effectActionId).toBe('string');
                        expect(typeof signature).toBe('string');
                        if (typeof effectActionId !== 'string' || typeof signature !== 'string') throw new Error('Missing signed Home request');
                        const reviewedChild = typeof encodedChild === 'string'
                            ? JSON.parse(Buffer.from(encodedChild, 'base64url').toString('utf8')) : undefined;
                        signedReads.push({ path: request.url, effectActionId, reviewedChild });
                        expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token,
                            effectActionId, target: machineTarget, installationId: root.binding.installationId,
                            requestId: root.binding.requestId, method: request.method, path: request.url,
                            ...(request.body === undefined ? {} : { body: request.body }),
                            ...(forwardedPacket ? { deploymentChildExecution: forwardedPacket } : {}),
                            ...(reviewedChild ? { reviewedChild } : {}), signature, publicKey: keys.publicKey })).toBe(true);
                    });
                    restoreHttp = installAxiosFastifyAdapter({ app: home, origin: 'https://home.test' });
                    const child = installedChild ? DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review',
                        actionId: 'deployments.deploy', input: rootInput,
                        machineId: machineTarget.machineId, installationId: root.binding.installationId }) : undefined;
                    const requester = await admitRequesterAccountActionContext({ authorization: root, credentials,
                        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
                        ...(child ? { deploymentChild: child } : {}),
                        isCurrent: async () => true, isCustodyCurrent: async () => true, signal: lifetime.signal });
                    if (!requester) throw new Error('Expected genuine requester Account custody');
                    disposeRequester = requester.dispose;
                    if (child) {
                        const method = `${machineTarget.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
                        const requestId = `installed-${provider}-review`;
                        const execution = createExternalActionMachineRpcExecution({
                            context: { surface: 'cli', externalActionExecutionAuthorization: requester.authorization,
                                externalActionTarget: machineTarget }, effectActionId: child.actionId,
                            installationId: root.binding.installationId, method, requestId, params: child,
                            deploymentChildRouting: projectDeploymentChildRoutingV1(child), privateKey: keys.secretKey });
                        if (!execution) throw new Error('Expected the real native child issuer to sign the review');
                        forwardedPacket = { method, requestId, params: child,
                            originalActionEnvelope: envelope, externalActionExecution: execution };
                    }
                    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                        target: machineTarget, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
                        installationId: root.binding.installationId, privateKey: keys.secretKey, isCurrent: requester.isCurrent,
                        ...(child ? { forwardedDeploymentChild: child, deploymentChildExecution: forwardedPacket,
                            forwardedMove: { credentials, isCurrent: requester.isCurrent } } : {}) });
                    if (!authorization) throw new Error('Expected signed requester HTTP projection');
                    childRootContext = { ...stored.request.context, runtimeAccountId: custodyAccountId,
                        externalActionTarget: machineTarget, externalActionExecutionAuthorization: authorization };
                }
                const port = createHostReviewedChildPortV1({ actionId: 'deployments.deploy',
                    input: { serverId: deployInput.serverId, environmentId: deployInput.environmentId,
                        targetLinkId: deployInput.targetLinkId }, context: childRootContext, reviewAdmitted: true,
                    plan: { children: [{ action, role: 'deploy', input: roleInput }] },
                    policies: [{ action, role: 'deploy', surface: 'plugin' }],
                    async execute(_input, context) {
                        deployed = await target!.invoke({ ...action, input: roleInput, surface: 'plugin',
                            operationAcceptance: context.operationAcceptance, approvalContext: context,
                            caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                                contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                                sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
                        return { ok: true, result: null };
                    } });
                await port.invoke({ action, role: 'deploy', input: roleInput });
                expect(deployed, JSON.stringify({ status: deployed.status,
                    code: 'code' in deployed ? deployed.code : null })).toMatchObject({ status: 'executed',
                    value: { state: 'running', providerDeploymentId: provider === 'vercel' ? 'dpl-selected' : 'build-selected' } });
                if (signedContinuation) {
                    expect.soft(signedReads.some(read => read.path.startsWith('/v1/deployments/environments/'))).toBe(true);
                    expect.soft(signedReads.some(read => read.path.startsWith('/v1/artifacts/'))).toBe(true);
                    expect.soft(signedReads.some(read => read.path.includes('/receipts/'))).toBe(true);
                    expect.soft(signedReads.every(read => read.effectActionId === 'deployments.deploy' && read.reviewedChild === undefined)).toBe(true);
                    const vendorCalls = requests.length;
                    const credentialAcquisitions = acquisitions;
                    for (const [refusal, phase] of [['classified', 'home.authorization.effect_family'],
                        ['unclassified', 'home.authorization.signed_request']] as const) {
                        denyEnvironmentRead = refusal;
                        await port.invoke({ action, role: 'deploy', input: roleInput });
                        expect(deployed).toMatchObject({ status: 'failed', code: 'action_forbidden',
                            actionHandlerInvocation: 'notStarted', data: { failureCause: { phase, httpStatus: 401 } } });
                        expect(requests).toHaveLength(vendorCalls);
                        expect(acquisitions).toBe(credentialAcquisitions);
                    }
                    denyEnvironmentRead = false;
                }
                stored.state.environment.environment.capabilities = capabilities;
                const providerDeploymentId = provider === 'vercel' ? 'dpl-selected' : 'build-selected';
                platform.observation.providerDeploymentId = providerDeploymentId;
                const { sourceIntent: _sourceIntent, sourceMethod: _sourceMethod, ...observationInput } = deployInput;
                const observeInput = DeploymentTargetRoleInputSchemasV1.observe.parse({ ...observationInput,
                    providerDeploymentId });
                expect(await invokeRole('observe', observeInput)).toMatchObject({ status: 'executed',
                    value: { state: provider === 'vercel' ? 'succeeded' : 'running', providerDeploymentId } });
                expect(await invokeRole('deploy', { ...deployInput, providerDeploymentId }))
                    .toMatchObject({ status: 'executed', value: { state: provider === 'vercel' ? 'succeeded' : 'running', providerDeploymentId } });
                expect(requests).toEqual(provider === 'vercel' ? [{ method: 'POST', path: '/v13/deployments' },
                    { method: 'GET', path: '/v13/deployments/dpl-selected' },
                    { method: 'GET', path: '/v13/deployments/dpl-selected' }]
                    : [{ method: 'POST', path: provider === 'preview'
                        ? `/client/v4/accounts/${'a'.repeat(32)}/builds/workers/${'b'.repeat(32)}/previews/${previewId}/builds`
                        : `/client/v4/accounts/${'a'.repeat(32)}/builds/triggers/trigger-selected/builds` },
                        { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/builds/build-selected` },
                        { method: 'GET', path: `/client/v4/accounts/${'a'.repeat(32)}/builds/builds/build-selected` }]);
                if (worker) {
                    if (deployInput.sourceIntent.kind !== 'repository') throw new Error('Expected canonical repository source');
                    expect(submittedCommits).toEqual([{ commit_hash: deployInput.sourceIntent.sha,
                        ...(provider === 'preview' ? { branch: gitBranch } : {}) }]);
                    expect(platform.credentialPrincipal).toEqual(input.credentialPrincipal);
                    expect(platform.preparedNative).toMatchObject(provider === 'preview'
                        ? { previewId, gitBranch, workerTag: 'b'.repeat(32), scriptName: 'app' }
                        : { triggerUuid: 'trigger-selected' });
                }
            } else {
                requests.length = 0;
                const zoneInput = { credentialRef: account, accountId: 'account-selected', zoneId: 'zone-selected' };
                const invokeZone = (value: JsonValue) => target!.invoke({ pluginId, localId: 'cloudflare-named/zone-read',
                    input: value, surface: 'cli' });
                expect(await invokeZone(zoneInput)).toMatchObject({ status: 'executed', value: { kind: 'ready',
                    zones: [{ accountId: 'account-selected', zoneId: 'zone-selected', name: 'example.test' }], defaultZoneId: 'zone-selected' } });
                expect(requests).toEqual([{ method: 'GET', path: '/client/v4/zones/zone-selected' }]);
                requests.length = 0;
                const beforeMissingZone = acquisitions;
                expect(await invokeZone({ ...zoneInput, credentialRef: { service, accountId: 'foreign-account' } }))
                    .toMatchObject({ status: 'failed', code: 'plugin_action_form_connected_account_options_unavailable' });
                expect(requests).toEqual([]);
                expect(acquisitions).toBe(beforeMissingZone);
                const configureInput = { ...zoneInput, tunnel: { kind: 'adopt', tunnelId: 'tunnel-selected', name: 'selected-tunnel' },
                    owned: [], desired: [], dnsOwnership: [] };
                const invokeConfigure = (withConnectorAdmission: boolean) => target!.invoke({ pluginId,
                    localId: 'cloudflare-named/configure', input: configureInput, surface: 'plugin',
                    ...(withConnectorAdmission ? {
                        // External receiver transport stands in for the Domain-owned sealed-grant writer.
                        machineConnectorSecrets: { write: async ({ token }) => {
                            expect(new TextDecoder().decode(token) === 'synthetic-connector-token').toBe(true);
                            return { grants: [{ machineId: 'domain-member', installationId: 'domain-installation', grantRef: 'sealed-domain-grant' }] };
                        } },
                    } : {}),
                    caller: { kind: 'plugin', pluginId, occurrenceId: '7',
                        contribution: { id: localId, qualifiedId: `${pluginId}/actions/${localId}` },
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
                expect(await invokeConfigure(false)).toMatchObject({ status: 'failed', code: 'controller_services_unavailable' });
                expect(requests).toEqual([]);
                expect(await invokeConfigure(true)).toMatchObject({ status: 'executed', value: { kind: 'prepared',
                    tunnelId: 'tunnel-selected', grants: [{ machineId: 'domain-member', installationId: 'domain-installation', grantRef: 'sealed-domain-grant' }] } });
                expect(requests.some(request => request.path.endsWith('/token'))).toBe(true);
            }
            requests.length = 0;
            const beforeMissing = acquisitions;
            expect(await invoke({ ...input, credentialRef: { service, accountId: 'foreign-account' } }))
                .toMatchObject(provider !== 'cloudflare' ? { status: 'failed', code: 'deployment_access_denied' }
                    : { status: 'failed', code: 'plugin_action_form_connected_account_options_unavailable' });
            expect(requests).toEqual([]);
            expect(acquisitions).toBe(beforeMissing);
            providerDenied = true;
            const denied = await invoke(input);
            expect(denied).toMatchObject(provider !== 'cloudflare'
                ? { status: 'unavailable', code: 'deployment_access_denied' }
                : { status: 'executed', value: { kind: 'refused', code: 'denied' } });
            expect(JSON.stringify(denied).includes('platform-fixture-credential')).toBe(false);
            expect(requests).toHaveLength(1);
            expect(requests.every(request => request.method === 'GET')).toBe(true);
        } finally {
            await disposeRequester?.();
            await requesterChannel?.close();
            restoreInstallation?.();
            restoreHttp?.(); await home.close();
            lifetime.abort(); resourceOwner?.retirePlugin(entry.manifest.id); target?.dispose(); await kit.dispose();
            if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot); else resetActiveAccountSettingsSnapshotForTests();
        }
    });
    it.each([
        ...(['owner', 'principal', 'controller', 'native', 'source', 'mutation', 'author'] as const)
            .map(variant => ['Supabase', variant] as const),
        ...(['owner', 'principal', 'controller', 'native', 'source', 'author'] as const)
            .map(variant => ['Neon', variant] as const),
    ])('composes the activated %s data Action through target admission and purpose HTTP (%s)', async (provider, variant) => {
            const entry = provider === 'Neon' ? neonEntry : supabaseEntry;
            const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
            let target: ReturnType<typeof buildRegistry> | undefined;
            let resourceOwner: Awaited<ReturnType<typeof createStablePluginResourcesOwner>> | undefined;
            const resourceLifetime = new AbortController();
            const previousAccountSnapshot = getActiveAccountSettingsSnapshot();
            try {
                const pluginManifest = normalizePluginManifestV2(entry.manifest);
                const pluginId = pluginManifest.id;
                const localId = variant === 'mutation' ? 'branches-create' : provider === 'Neon' ? 'branches-list-read' : 'branches-list';
                const handler = kit.registration('actions', localId);
                if (!handler) throw new Error('Data plugin did not activate its declared branch Action');
                const stored = createDeploymentTargetRoleAdmissionFixture(variant === 'mutation' ? 'branches.create' : 'branches.list', { preview: true });
                const service = { pluginId, localId: provider === 'Neon' ? 'neon' : 'supabase' };
                const account = { service, accountId: 'selected-account' };
                const principal = { kind: 'account' as const, accountId: 'custody-account',
                    purpose: { consumer: { pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' },
                    target: { kind: 'account' as const, account } };
                const providerIdentity = { providerAccountId: 'org-example', providerResourceId: 'parent-ref', providerEnvironment: 'preview-ref' };
                const providerEnvironment = { kind: 'custom' as const, id: 'preview-ref' };
                const selected = stored.state.environment.targetLinks[0]!;
                selected.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: 'database' } };
                selected.targetLink.targetKind = provider === 'Neon' ? 'neon' : 'supabase';
                selected.content = { credentialPrincipal: principal, providerIdentity, providerEnvironment };
                if (variant === 'controller') stored.state.environment.environment.controllerMachineId = 'other-controller';
                if (variant === 'source') selected.targetLink.source.contribution.localId = 'other-database';
                if (variant === 'author') {
                    stored.state.environment.environment.owner = { kind: 'team', teamId: 'shared-team' };
                    selected.targetLink.createdByAccountId = 'another-team-manager';
                }
                const input = { ...stored.input, credentialRef: account,
                    credentialPrincipal: variant === 'principal' ? { ...principal, accountId: 'other-account' } : principal,
                    providerIdentity: variant === 'native' ? { ...providerIdentity, providerResourceId: 'foreign-project' } : providerIdentity,
                    providerEnvironment, ...(variant === 'mutation' ? { name: 'Preview', withData: false } : {}) };
                const revision = 'csr_abcdefghijklmnopqrstuv';
                const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
                    authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
                    configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
                    displayName: 'Selected data Account', scopes: [] });
                const descriptor = pluginManifest.contributes.connectedAccountDescriptors.find(entry => entry.id === service.localId);
                if (!descriptor) throw new Error('Missing actual data Connected Account descriptor');
                const unexpected = async (): Promise<never> => { throw new Error('This admitted read does not select or write credentials'); };
                let acquisitions = 0;
                const owner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'custody-account',
                    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
                    selectTarget: unexpected,
                    resolveTarget: createPurposeTargetResolver({ available: true,
                        resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
                    resolveCredentialRevision: async () => revision,
                    materializeAccount: async ({ credentialRevisionBasis }) => {
                        acquisitions++;
                        credentialRevisionBasis?.captureCredentialRevision(revision);
                        return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer fixture-provider-credential' } };
                    }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
                });
                const requests: string[] = [];
                let branchName = 'Preview';
                const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                    connectedAccounts: createStablePluginConnectedAccountsHost(owner),
                    http: createStablePluginHttpHost({
                        purposeHost: createConnectedAccountPluginHttpPurposeHost(owner, { registerRawForRedaction() {} }),
                        adapter: {
                            async request(request) {
                                requests.push(request.url);
                                expect(request.headers?.authorization === 'Bearer fixture-provider-credential').toBe(true);
                                const branch = {
                                    id: 'branch-native', project_ref: 'preview-ref', parent_project_ref: 'parent-ref', name: branchName, persistent: false,
                                };
                                return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(
                                    provider === 'Neon' ? { branches: [{ id: 'branch-native', project_id: 'parent-ref', name: branchName,
                                        current_state: 'ready', default: false, protected: false }], operations: [] }
                                        : request.method === 'POST' ? branch : [branch])) };
                            }, async openWebSocket() { throw new Error('No WebSocket requested'); },
                        },
                    }),
                });
                const contributes = registry({ pluginManifest });
                target = buildRegistry({ ...owners, contributes, executionRealm: 'account',
                    targetActivationFacts: [fact({ pluginId, pluginVersion: pluginManifest.version,
                        required: [{ family: 'actions', localId }], bound: [{ family: 'actions', localId }] })],
                    targetRegistrations: [{ pluginId, occurrenceId: '7', registration: { family: 'actions', localId, value: handler } }],
                    actionFormConnectedAccounts: owner, readDeploymentTargetRoleAdmissionHost: async () => stored.host,
                });
                const result = await target.invoke({ pluginId, localId, input, surface: variant === 'mutation' ? 'plugin' : 'cli',
                    ...(variant === 'mutation' ? { caller: { kind: 'plugin' as const, pluginId, occurrenceId: '7',
                        contribution: { id: 'projects-link', qualifiedId: `${pluginId}/actions/projects-link` },
                        sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'immutable-alpha', installSource: 'archive' as const } } } : {}) });
                if (variant === 'owner' || variant === 'mutation') {
                    expect(result, JSON.stringify(result)).toMatchObject({ status: 'executed', value: variant === 'mutation'
                        ? { status: 'provisioned', branchId: 'branch-native', providerEnvironment: { kind: 'custom', id: 'preview-ref' } }
                        : { branches: [{ branchId: 'branch-native', ...(provider === 'Neon'
                            ? { providerProjectId: 'parent-ref' } : { projectRef: 'preview-ref' }) }] } });
                    expect(requests).toEqual([provider === 'Neon' ? 'https://console.neon.tech/api/v2/projects/parent-ref/branches'
                        : 'https://api.supabase.com/v1/projects/parent-ref/branches']);
                    expect(acquisitions).toBe(1);
                    if (variant === 'mutation') return;
                } else {
                    expect(result).toMatchObject({ status: 'unavailable', code: variant === 'controller' ? 'machine_unavailable'
                        : variant === 'source' ? 'target_mismatch' : 'deployment_access_denied' });
                    expect(requests).toEqual([]);
                    expect(acquisitions).toBe(0);
                }
                const resourceId = 'branches-list-resource';
                const admittedTarget = target;
                setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                    loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: 'home:custody-account' });
                resourceOwner = await createStablePluginResourcesOwner({ registry: { resources: contributes.resources }, generations: new Map(),
                    dynamicOccurrenceIdsByPluginId: new Map([[pluginId, '7']]),
                    dynamicProducers: contributes.resources.map(resource => {
                        const runtime = kit.registration('resources', resource.definition.id);
                        if (!runtime) throw new Error('Data plugin did not activate its declared Resource');
                        return { pluginId, localId: resource.definition.id, runtime };
                    }),
                    bindDynamicResourceActions: binding => createDynamicResourceActionBinding({ binding,
                        readCaller: () => ({ kind: 'plugin', pluginId, occurrenceId: binding.occurrenceId,
                            contribution: { id: binding.resourceId, qualifiedId: `${pluginId}/resources/${binding.resourceId}` },
                            sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } }),
                        invoke: async ({ action, ...invocation }) => {
                            const result = await admittedTarget.invoke({ ...invocation, pluginId: action.pluginId, localId: action.localId });
                            if (result.status === 'deferred') throw new Error('Read-only Resource Actions must settle without deferred approval');
                            return result;
                        },
                    }),
                });
                const resources = await resourceOwner.bindForResource({ pluginId, resourceId, signal: resourceLifetime.signal,
                    isOccurrenceCurrent: () => true, context: { kind: 'surface', mountInstanceKey: 'selected-data', launchInput: input } });
                if (variant === 'owner') {
                    // A manual snapshot stays demanded while an explicit read refreshes its bytes.
                    const observation = await resources.watch(resourceId, () => {});
                    try {
                        expect(JSON.parse(new TextDecoder().decode((await resources.read(resourceId)).bytes)))
                            .toMatchObject({ branches: [{ name: 'Preview' }] });
                        const beforeRefresh = requests.length;
                        branchName = 'Renamed preview';
                        expect(JSON.parse(new TextDecoder().decode((await resources.read(resourceId)).bytes)))
                            .toMatchObject({ branches: [{ name: 'Renamed preview' }] });
                        expect(requests.length).toBe(beforeRefresh + 1);
                    } finally { await observation.dispose(); }
                } else {
                    await expect(resources.read(resourceId)).rejects.toMatchObject({ code: variant === 'controller' ? 'machine_unavailable'
                        : variant === 'source' ? 'target_mismatch' : 'deployment_access_denied' });
                    expect(requests).toEqual([]);
                    expect(acquisitions).toBe(0);
                }
            } finally {
                resourceLifetime.abort(); resourceOwner?.retirePlugin(entry.manifest.id);
                if (previousAccountSnapshot) setActiveAccountSettingsSnapshot(previousAccountSnapshot);
                else resetActiveAccountSettingsSnapshotForTests();
                target?.dispose(); await kit.dispose();
            }
        });
    it.each(['current', 'principal', 'target-machine', 'scope', 'group', 'group-mismatch', 'group-change'] as const)('admits only the stored deployment role custody before purpose materialization (%s)', async variant => {
        const group = variant.startsWith('group');
        const stored = createDeploymentTargetRoleAdmissionFixture('inspect', group ? { target: {
            kind: 'group', service: { pluginId: 'acme.alpha', localId: 'account' }, groupId: 'fallbacks',
        } } : {});
        const resolvedAccount = structuredClone(stored.input.credentialRef);
        let groupGeneration = 1;
        const selectedLink = stored.state.environment.targetLinks[0]!.targetLink;
        selectedLink.machineId = 'controller'; selectedLink.installationId = 'installation-controller';
        if (variant === 'principal') stored.input.credentialPrincipal.accountId = 'other';
        if (variant === 'target-machine') selectedLink.machineId = 'other';
        if (variant === 'scope') stored.input.providerEnvironment = { kind: 'preview', gitBranch: 'other' };
        if (variant === 'group-mismatch') stored.input.credentialRef.accountId = 'not-the-selected-member';
        const base = connectedAccountActionManifest();
        const action = base.contributes.actions[0]!;
        const pluginManifest = normalizePluginManifestV2({ ...base,
            hostAccess: { ...base.hostAccess, required: base.hostAccess.required.map(request => request.capability === 'connectedAccounts'
                ? { ...request, scope: { ...request.scope, materializationKinds: ['httpHeaders'] } } : request) },
            contributes: { ...base.contributes,
                actions: (['inspect', 'link', 'deploy', 'observe'] as const).map(role => ({ ...action,
                    id: role === 'inspect' ? 'run' : role, surfaces: ['plugin'],
                    dangerLevel: role === 'inspect' || role === 'observe' ? 'safe' : 'writesLocal',
                    readOnly: role === 'inspect' || role === 'observe',
                    inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema,
                    resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
                })),
                deploymentTargets: [{ id: 'platform', title: 'Platform', icon: 'server-outline', targetKind: 'platform', role: 'runtime',
                    targetSchema: { type: 'object', additionalProperties: false }, linkSchema: { type: 'object', additionalProperties: false },
                    actions: { inspect: 'run', link: 'link', deploy: 'deploy', observe: 'observe' } }],
            },
        });
        const resolveTarget = vi.fn(async () => ({ displayName: 'Selected Account', account: resolvedAccount,
            ...(group ? { group: { groupId: 'fallbacks', generation: groupGeneration } } : {}) }));
        const materializeAccount = vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer protected' } }));
        const owner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'custody-account', store: { read: async () => ({ v: 1, bindings: [] }),
                update: async () => { throw new Error('No selection write'); }, subscribe: () => ({ dispose() {} }) },
            selectTarget: async () => { throw new Error('No interactive selection'); }, resolveTarget, materializeAccount,
            projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined,
        });
        const target = buildRegistry({ contributes: registry({ pluginManifest }),
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run',
                value: async (_input: JsonValue, context: PluginInvocationContext) => {
                    if (variant === 'group-change') groupGeneration++;
                    await context.services.connectedAccounts.materialize('action-account', { kind: 'httpHeaders',
                        origin: 'https://api.github.com', headerNames: ['authorization'] }, { expectedAccount: stored.input.credentialRef });
                    return { v: 1, state: 'queued', observedAtMs: 1000 };
                } } }], targetActivationFacts: [fact()],
            readDeploymentTargetRoleAdmissionHost: async () => stored.host,
            actionFormConnectedAccounts: owner,
            createServices: createPluginInvocationServicesFactory({ loggerSink: { write() {} }, connectedAccounts: createStablePluginConnectedAccountsHost(owner) }),
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (generation, id) =>
                createPluginInvocationServiceBinding(generation, id) }),
        });
        const result = await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: stored.input, surface: 'plugin' });
        const succeeds = variant === 'current' || variant === 'group';
        expect(result.status).toBe(succeeds ? 'executed' : variant === 'group-change' ? 'failed' : 'unavailable');
        if (succeeds) expect(materializeAccount).toHaveBeenCalledOnce();
        else {
            if (!group) expect(resolveTarget).not.toHaveBeenCalled();
            expect(materializeAccount).not.toHaveBeenCalled();
        }
    });
    it('binds portable Account settings reads and change observation to the existing record owner and invocation lifetime', async () => {
        const base = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } });
        const portable = normalizePluginManifestV2({ ...base, contributes: { ...base.contributes, settings: [{
            id: 'preferences', version: 1, title: 'Preferences', target: { kind: 'plugin' }, scope: 'account',
            fields: [
                { id: 'limit', title: 'Limit', schema: { type: 'integer' }, default: 3 },
                { id: 'fallback', title: 'Fallback', schema: { type: 'integer' }, default: 7 },
                { id: 'credential', title: 'Credential', schema: { type: 'string' }, secret: true },
            ], presentation: { sections: [], subagentSections: [] },
        }] } });
        let revision = 1;
        let storedLimit = 5;
        let wake: (() => void) | undefined;
        let unsubscriptions = 0;
        let reads = 0;
        let ready!: () => void;
        const observing = new Promise<void>(resolve => { ready = resolve; });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            settingsDeclarations: portable.contributes.settings.map(contribution => ({ pluginId: portable.id, contribution })),
            // The physical Account-record transport is the only substituted boundary.
            accountSettingsRecordAdapter: {
                async bindOperation() { return {
                    async readRecord() {
                        const record = { status: 'present' as const, revision, values: { limit: storedLimit, retired: 'opaque' } };
                        if (++reads === 3) ready();
                        return record;
                    },
                    async writeRecord() { throw new Error('Read-only Account settings must not write'); },
                }; },
                watchRecord(_model, listener) { wake = () => listener({ revision }); return () => { unsubscriptions += 1; wake = undefined; }; },
            },
        });
        const invoke: PluginAccountActionHandler = async (_input, context) => {
            const settings = context.services.settings.forScope({ kind: 'account' });
            expect(Object.keys(settings).sort()).toEqual(['describe', 'get', 'snapshot', 'watch']);
            expect(() => Reflect.apply(context.services.settings.forScope, undefined, [{ kind: 'daemon' }]))
                .toThrow(expect.objectContaining({ code: 'plugin_settings_scope_unavailable' }));
            await expect(settings.get('credential')).rejects.toMatchObject({ code: 'plugin_settings_secret_materialization_required' });
            const snapshot = await settings.snapshot();
            const fallback = await settings.get('fallback');
            const changed = new Promise<import('@happier-dev/plugin-sdk/settings').SettingsChange>(resolve => settings.watch(resolve));
            const change = await changed;
            return { snapshot, fallback, change };
        };
        const target = buildRegistry({ ...owners,
            contributes: registry({ pluginManifest: portable }), executionRealm: 'account', targetActivationFacts: [fact()],
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run', value: invoke } }],
        });
        try {
            const result = target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' });
            await Promise.race([observing, result.then(value => { throw new Error(`Settings invocation ended before observation: ${JSON.stringify(value)}`); })]);
            revision = 2;
            storedLimit = 9;
            wake?.();
            await expect(result).resolves.toMatchObject({ status: 'executed', value: {
                snapshot: { scope: { kind: 'account' }, revision: '1', values: { limit: 5 } }, fallback: 7,
                change: { scope: { kind: 'account' }, revision: '2', changedIds: ['limit'], values: { limit: 9 } },
            } });
            expect(unsubscriptions).toBe(1);
            expect(wake).toBeUndefined();
        } finally { target.dispose(); }
    });

    it.each(['actions/read-v1', 'actions/administer-v1'])('discovers the actual Triage %s declaration cold without predicting Account storage availability', async (localId) => {
        const triageManifest = normalizePluginManifestV2(TRIAGE_MANIFEST);
        const declaration = triageManifest.contributes.actions.find(action => action.id === localId);
        if (!declaration) throw new Error(`Missing Triage declaration ${localId}`);
        const pluginManifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'acme.alpha',
            hostAccess: triageManifest.hostAccess, contributes: { actions: [declaration] } }));
        const contributes = registry({ pluginManifest });
        const resolveHostPolicy = createTargetActionHostPolicyResolver({
            createServiceBinding: (generation, id) => createPluginInvocationServiceBinding(generation, id),
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
        // HostAccess is declaration metadata; Account storage availability is
        // decided when the handler demands storage, not during discovery.
        expect(target.evaluateCatalogPolicy('acme.alpha', localId)).toMatchObject({
            outcome: 'visible', code: 'plugin_action_available',
        });
    });

    it('seals a minted connector token through the admitted Account invocation for its distinct target installation', async () => {
        const portable = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } });
        const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const receiver = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
        const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, createdAt: 1, installationId: 'controller-installation',
            publicKey: encodeBase64(controller.publicKey, 'base64url'), privateKey: encodeBase64(controller.secretKey, 'base64url'),
        });
        const token = 'minted-connector-token-withheld-from-result';
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'target-machine',
            installationId: 'target-installation', provider: { pluginId: 'acme.alpha', localId: 'network' }, connectorId: 'connector-id' };
        const observed: unknown[] = [];
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            const input = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
            expect(config.url).toBe('https://admitted-home.test/v1/deployments/machines/target-machine/connector-secret-grant');
            expect(input.operation).toBe('set');
            if (input.operation !== 'set') throw new Error('Expected the sole connector writer');
            const { proof, ...body } = input;
            expect(body).toMatchObject({ hostMachineId: 'controller-machine', hostInstallationId: 'controller-installation' });
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'controller-machine',
                installationId: 'controller-installation', deploymentSecretLaunch: {
                    requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: controller.publicKey })).toBe(true);
            expect(openMachineSecretGrant({ grant: input.grant, machineId: subject.machineId,
                installationId: subject.installationId, installationPrivateSeed: receiver.secretKey.subarray(0, 32) }))
                .toEqual({ kind: 'connectorToken', token });
            expect(openMachineSecretGrant({ grant: input.grant, machineId: subject.machineId,
                installationId: subject.installationId, installationPrivateSeed: controller.secretKey.subarray(0, 32) })).toBeNull();
            expect(JSON.stringify(config.data)).not.toContain(token);
            observed.push(input.subject);
            return { status: 200, statusText: 'OK', headers: {},
                config: { ...config, headers: new axios.AxiosHeaders(Object.fromEntries(
                    Object.entries(config.headers ?? {}).filter((entry): entry is [string, Exclude<typeof entry[1], undefined>] => entry[1] !== undefined),
                )) },
                data: { ok: true, grant: input.grant } };
        });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const invoke: PluginAccountActionHandler = async (_input, context) => {
            // Reflect keeps the initial missing-service RED runtime-only in the shared compiled package.
            const service: unknown = Reflect.get(context.services, 'machineConnectorSecrets');
            if (!service || typeof service !== 'object' || !('write' in service) || typeof service.write !== 'function') {
                throw new PluginError({ code: 'controller_services_unavailable' });
            }
            const bytes = new TextEncoder().encode(token);
            try {
                const result: unknown = await service.write({ token: bytes,
                    subject: { provider: subject.provider, connectorId: subject.connectorId } });
                if (!result || typeof result !== 'object' || !('grants' in result) || !Array.isArray(result.grants)) {
                    throw new Error('Expected opaque installation connector grants');
                }
                return { grants: result.grants };
            } finally { bytes.fill(0); }
        };
        const target = buildRegistry({ ...owners, contributes: registry({ pluginManifest: portable }), executionRealm: 'account',
            targetActivationFacts: [fact()], targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: invoke } }],
        });
        const invocation = { pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' as const,
            // Real writer below; only its installed identity and network are substituted.
            machineConnectorSecrets: { write: async (input: Readonly<{ token: Uint8Array;
                subject: Pick<Parameters<typeof writeMachineConnectorSecretGrantForHost>[0]['subject'], 'provider' | 'connectorId'> }>) =>
                ({ grants: [{ machineId: subject.machineId, installationId: subject.installationId,
                    ...await writeMachineConnectorSecretGrantForHost({ credentials: {
                    token: `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature` },
                    context: { operationAcceptance: { operationId: 'admitted-operation' } },
                    signal: new AbortController().signal, serverId: 'admitted-home', serverHttpBaseUrl: 'https://admitted-home.test',
                    hostMachineId: 'controller-machine', hostInstallationId: 'controller-installation',
                    installationPublicKey: receiver.publicKey, assertCurrent: async () => {},
                    subject: { ...subject, provider: input.subject.provider, connectorId: input.subject.connectorId }, token: input.token }) }] }) },
        };
        try {
            await expect(target.invoke(invocation)).resolves.toMatchObject({ status: 'executed', value: {
                grants: [{ machineId: subject.machineId, installationId: subject.installationId,
                    grantRef: machineSecretGrantSubjectKey(subject) }] } });
            expect(observed).toEqual([subject]);
            expect(boundary).toHaveBeenCalledTimes(1);
        } finally { target.dispose(); boundary.mockRestore(); identity.mockRestore(); }
    });

    it.each([false, true])('preserves admitted managed byte custody and its typed failure in Account Actions (refused=%s)', async refused => {
        const portable = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const bytes = new TextEncoder().encode('private-guest-host-key');
        const nativeCause = { httpStatusClass: '4xx', code: 'invalid_input', fields: ['image'] };
        const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const invoke: PluginAccountActionHandler = async (_input, context) => {
            const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
            if (lease.kind !== 'bytes') throw new Error('Expected a byte credential');
            try { return { keyPresent: lease.bytes.byteLength > 0 }; }
            finally { await lease.dispose(); }
        };
        const target = buildRegistry({ ...owners, contributes: registry({ pluginManifest: portable }), executionRealm: 'account',
            targetActivationFacts: [fact()], targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: invoke } }],
        });
        try {
            const result = await target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
                managedBootstrapCredential: { role: 'acquire', isCurrent: () => true,
                    readBootstrapCredential: async () => {
                        if (refused) throw new PluginError({ code: 'native_request_failed', details: { nativeCause } });
                        return bytes;
                    },
                },
            });
            if (refused) {
                expect(result).toMatchObject({ status: 'failed', code: 'native_request_failed', data: { details: { nativeCause } } });
                expect(warn.mock.calls).toEqual([['Plugin Action failed', { pluginId: 'acme.alpha', localId: 'run', code: 'native_request_failed' }]]);
                expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
            } else {
                expect(result).toEqual({ status: 'executed', value: { keyPresent: true } });
                expect(bytes.every(byte => byte === 0)).toBe(true);
                expect(warn).not.toHaveBeenCalled();
            }
        } finally { target.dispose(); warn.mockRestore(); }
    });

    it('projects admitted CLI HTTP into the Account handler without native services', async () => {
        const portable = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } },
            hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'Send an Account request',
                scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://account.example.test' }], methods: ['GET'] } }], optional: [] },
            actionHostAccess: ['api'],
        });
        const requests: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
            http: createStablePluginHttpHost({ adapter: {
                async request(input) {
                    requests.push(input.url);
                    return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('Account response') };
                },
                async openWebSocket() { throw new Error('No WebSocket requested'); },
            } }),
        });
        const invoke: PluginAccountActionHandler = async (_input, context) => {
            if (!context.services.http) throw new PluginError({ code: 'controller_services_unavailable' });
            const response = await context.services.http.request({ url: 'https://account.example.test/resource', method: 'GET', redirect: 'follow' });
            return { status: response.status, body: new TextDecoder().decode(response.body),
                nativeServices: ['exec', 'fs'].filter(name => name in context.services) };
        };
        const target = buildRegistry({ ...owners, contributes: registry({ pluginManifest: portable }), executionRealm: 'account',
            targetActivationFacts: [fact()], targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: invoke } }],
        });
        try {
            await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
                .resolves.toMatchObject({ status: 'executed', value: { status: 200, body: 'Account response', nativeServices: [] } });
            expect(requests).toEqual(['https://account.example.test/resource']);
        } finally { target.dispose(); }
    });

    it.each([false, true])('admits portable Account code and refuses only demanded unavailable Account storage (storage demanded: %s)', async (demandStorage) => {
        const portable = manifest({ execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } });
        const invoke = vi.fn<PluginAccountActionHandler>(async (_input, context) => {
            expect(context.accountScope).toEqual({ serverId: 'captured-home', accountId: 'captured-account' });
            expect(context.ui).toBeUndefined();
            if (demandStorage) await context.services.storage.account.kv.get('key');
            return { ok: true };
        });
        const target = buildRegistry({
            contributes: registry({ pluginManifest: portable }), executionRealm: 'account',
            readAccountScope: async signal => signal.aborted ? undefined
                : { serverId: 'captured-home', accountId: 'captured-account' },
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
        const primaryManifest = manifest({
            surfaces: ['agent', 'mcp', 'cli'],
            execution: executionTarget === 'daemon' ? { target: 'daemon' } : {
                target: 'client',
                client: { artifactId: 'client-action', exportName: 'activate' },
                platforms: ['web'],
            },
        });
        const primaryAction = primaryManifest.contributes.actions[0]!;
        const contributes = registry({ pluginManifest: normalizePluginManifestV2({
            ...primaryManifest,
            contributes: { ...primaryManifest.contributes,
                actions: [{ ...primaryAction, id: 'unrelated' }, primaryAction] },
        }) });
        let admitted = true;
        let manifestDeclarationReads = 0;
        const bindings: string[] = [];
        const authorityReads: string[] = [];
        const occurrenceId = '7' as PluginRuntimeOccurrenceId;
        const sourceCustody = { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } as const;
        let currentSourceCustody: typeof sourceCustody | null = sourceCustody;
        const target = buildRegistry({
            // Pass through the actual admitted rows/maps and observe only a
            // full manifest declaration-array request after admission.
            contributes: { ...contributes, activationTargets: contributes.activationTargets.map(activation => ({
                ...activation,
                manifest: { ...activation.manifest, contributes: new Proxy({ ...activation.manifest.contributes }, {
                    get(object, key, receiver) {
                        if (key === 'actions') manifestDeclarationReads += 1;
                        return Reflect.get(object, key, receiver);
                    },
                }) },
            })) },
            targetRegistrations: [],
            targetActivationFacts: [],
            resolveHostPolicy: createTargetActionHostPolicyResolver({
                createServiceBinding: (occurrenceId, id) => {
                    bindings.push(id);
                    return createPluginInvocationServiceBinding(occurrenceId, id);
                },
            }),
            readCurrentPluginOccurrenceId: () => occurrenceId,
            readCurrentPluginSourceCustody: () => currentSourceCustody,
            resolveAuthorizationFacts: (action, purpose) => {
                authorityReads.push(action.qualifiedId);
                return resolvePluginFinalPolicyAuthorizationFacts({
                pluginId: 'acme.alpha',
                current: { occurrenceId, sourceCustody, desiredOccurrenceId: admitted ? occurrenceId : null,
                    appliedOccurrenceId: null, applied: false, selectedAccess: [] },
                ...(purpose ? { purpose } : {}),
                });
            },
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
            expect(listContributedActionDefinitions().map((definition) => definition.id)).toEqual(expect.arrayContaining([
                id, formatQualifiedPluginActionId({ pluginId: 'acme.alpha', localId: 'unrelated' }),
            ]));
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
                bindings.length = 0;
                authorityReads.length = 0;
                manifestDeclarationReads = 0;
                const get = await executor.execute('action.spec.get', { id }, { surface });
                expect(get).toMatchObject({ ok: true, result: { actionSpec: { id } } });
                // Observe the real policy/binding factory: an exact read must
                // neither authorize nor construct bindings for another Action.
                expect(bindings.length).toBeGreaterThan(0);
                expect.soft(bindings.filter(value => value !== 'acme.alpha/actions/run:binding')).toEqual([]);
                expect(authorityReads.length).toBeGreaterThan(0);
                expect.soft(authorityReads.filter(value => value !== 'acme.alpha/actions/run')).toEqual([]);
                expect.soft(manifestDeclarationReads).toBe(0);
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

    it('keeps a client Action discoverable without constructing its declared HTTP service', () => {
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
            outcome: 'visible', code: 'plugin_action_available',
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

    it('refuses a deployment role without stored host admission before resolving or materializing its Account', async () => {
        const source = registry({ pluginManifest: connectedAccountActionManifest() });
        const contributes = createResolvedContributionRegistry({
            ...source,
            actions: source.actions.map(action => ({ ...action, admittedTarget: action.admittedTarget && {
                ...action.admittedTarget,
                deploymentTargetRoles: [{ targetLocalId: 'platform', targetKind: 'platform', role: 'deploy' as const }],
            } })),
        });
        const account = { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'account-1' };
        // Account resolution/materialization are the credential-storage boundary;
        // the actual purpose owner and invocation pipeline remain composed.
        const resolveTarget = vi.fn(async () => ({ displayName: 'Account', account }));
        const materializeAccount = vi.fn(async () => ({ kind: 'httpHeaders' as const,
            headers: { authorization: 'Bearer protected' } }));
        const owner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'custody-account',
            store: { read: async () => ({ v: 1, bindings: [] }), update: async () => {
                throw new Error('Invocation must not persist Account selection');
            }, subscribe: () => ({ dispose() {} }) },
            selectTarget: async () => { throw new Error('Invocation must not ask for Account selection'); },
            resolveTarget, materializeAccount,
            projectTargetAccounts: async () => [],
            assertTargetAccountMaterializable: async () => undefined,
        });
        const target = buildRegistry({
            contributes,
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: {
                family: 'actions', localId: 'run', value: async (_input: JsonValue, context: PluginInvocationContext) => {
                    await context.services.connectedAccounts.materialize('action-account', {
                        kind: 'httpHeaders', origin: 'https://api.github.com', headerNames: ['authorization'],
                    }, { expectedAccount: account });
                    return { sent: true };
                },
            } }],
            targetActivationFacts: [fact()],
            actionFormConnectedAccounts: owner,
            createServices: createPluginInvocationServicesFactory({ loggerSink: { write() {} },
                connectedAccounts: createStablePluginConnectedAccountsHost(owner) }),
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (generation, id) =>
                createPluginInvocationServiceBinding(generation, id) }),
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { credentialRef: account },
            surface: 'ui' })).resolves.toMatchObject({ status: 'unavailable', code: 'deployment_target_role_unavailable' });
        expect(resolveTarget).not.toHaveBeenCalled();
        expect(materializeAccount).not.toHaveBeenCalled();
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
        let sourceInventoryFailure: PluginError | undefined;
        const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'materialization-owner',
            store: {
                read: async () => ({ v: 1, bindings: [] }),
                update: async () => { throw new Error('History-gap recovery must not persist a selection'); },
                subscribe: () => ({ dispose() {} }),
            },
            selectTarget: async () => { throw new Error('History-gap recovery must not request a selection'); },
            resolveTarget: async target => {
                if (sourceInventoryFailure) throw sourceInventoryFailure;
                return target.kind === 'account' ? { displayName: 'Source Account', account: target.account } : null;
            },
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
                    createPluginInvocationServiceBinding(generation, id)
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
        sourceInventoryFailure = new PluginError({ code: 'connected_account_service_unavailable', retryable: true });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'reset-history', surface: 'plugin', input: {
            automationId: 'automation-1', triggerId: '11111111-1111-4111-8111-111111111111',
            triggerRevision: 3, sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
        } })).resolves.toMatchObject({ status: 'failed', code: 'connected_account_service_unavailable',
            retryable: true, actionHandlerInvocation: 'notStarted' });
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
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (generation, id) => createPluginInvocationServiceBinding(generation, id) }),
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

    it.each([false, true])('preserves Account inventory failure causes before dispatch (dynamic form: %s)', async dynamicForm => {
        const account = { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'selected' };
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: account, status: 'needs_reauth', authenticationModeId: 'manual', configurationReady: true,
            configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        });
        let inventoryFailure: Error | undefined;
        const resolveTarget = createPurposeTargetResolver({
            available: true,
            resolveService: async service => ({ service, authentication: {
                defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
            } }),
            // Only the external inventory read is substituted; resolution, binding,
            // form admission and invocation use their real owners.
            listAccounts: async () => {
                if (inventoryFailure) throw inventoryFailure;
                return [profile, { ...profile, ref: { ...account, accountId: 'another-connected-account' }, status: 'connected' }];
            },
        });
        const unavailable = async (): Promise<never> => { throw new Error('No credential acquisition or selection expected'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable, resolveTarget, materializeAccount: unavailable,
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
        });
        const pluginManifest = connectedAccountActionManifest({ omitInputHints: !dynamicForm });
        const handler = vi.fn(async () => ({ dispatched: true }));
        const target = buildRegistry({ contributes: registry({ pluginManifest }), targetActivationFacts: [fact()],
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: handler } }],
            ...connectedAccountActionServices(), actionFormConnectedAccounts: owner,
        });
        const invoke = () => target.invoke({ pluginId: 'acme.alpha', localId: 'run',
            input: { credentialRef: account }, surface: 'ui' });
        await expect(invoke()).resolves.toMatchObject({ status: 'failed',
            code: 'connected_service_credential_reconnect_required', retryable: false,
            actionHandlerInvocation: 'notStarted' });
        inventoryFailure = new PluginError({ code: 'connected_account_service_unavailable', retryable: true,
            failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'P2028', httpStatus: null } });
        await expect(invoke()).resolves.toMatchObject({ status: 'failed',
            code: 'connected_account_service_unavailable', retryable: true,
            data: { failureCause: { errorCode: 'P2028' } }, actionHandlerInvocation: 'notStarted' });
        inventoryFailure = Object.assign(new Error('private inventory response'), { code: 'ECONNRESET' });
        const result = await invoke();
        expect(result).toMatchObject({ status: 'failed', code: 'plugin_action_pre_dispatch_unavailable',
            data: { failureCause: { errorCode: 'ECONNRESET' } }, actionHandlerInvocation: 'notStarted' });
        expect(JSON.stringify(result)).not.toContain('private inventory response');
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
            await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input, surface: 'cli',
                isApprovalRequiredByActionSettings: () => true, requestCurrentIntent }))
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
            const context = { surface: 'cli' as const, authority: 'account_automation' as const };
            await expect(target.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: approved.input, surface: 'cli', requireCurrentIntent: true,
                approvalContext: { ...context, hostReviewedChild: createHostReviewedChildPortV1({
                    actionId: 'action.invoke', input: { action: { pluginId: 'acme.alpha', localId: 'run' }, input: approved.input },
                    context, reviewAdmitted: true,
                }) },
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
                // Artifact state is observation, not authenticated decision delivery.
                setImmediate(() => { void getSharedBlockingApprovalCoordinator().resolveBlockingDecision({
                    artifactId: 'approval-external-declared-secret', request: { ...request, status: 'approved',
                        decision: { kind: 'approve', decidedAtMs: Date.now() } },
                    decision: 'approve', decisionAuthority: 'present_user',
                }); });
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
        })).toThrow();
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
        const resolveHostBinding = vi.fn(createTargetActionHostBindingResolver());
        const target = buildRegistry({
            contributes: registryWithHostAccess(),
            resolveHostBinding,
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: 'run', value: handler } }],
            targetActivationFacts: [fact()],
        });
        await expect(target.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toEqual({ status: 'executed', value: { ok: true } });
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

    it('keeps discovery available and reports unavailable HTTP only when the handler demands it', async () => {
        const target = buildRegistry({
            contributes: registryWithHostAccess(),
            targetRegistrations: [{
                pluginId: 'acme.alpha',
                occurrenceId: '7',
                registration: { family: 'actions', localId: 'run', value: async (_input: JsonValue, context: PluginInvocationContext) => {
                    await context.services.http.request({ url: 'https://example.test/resource', method: 'GET', redirect: 'follow' });
                    return { ok: true };
                } },
            }],
            targetActivationFacts: [fact()],
        });

        expect(target.evaluateCatalogPolicy('acme.alpha', 'run')).toMatchObject({
            outcome: 'visible',
            code: 'plugin_action_available',
        });
        await expect(target.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: {},
            surface: 'cli',
        })).resolves.toMatchObject({
            status: 'failed',
            code: 'plugin_service_unavailable',
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
    it.each(['deploy', 'observe'] as const)('executes an ordinary daemon %s role with invocation-owned runtime source and opaque environment custody', async role => {
        await withTempDir('deployment-runtime-role-', async homeDir => {
            const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
            envScope.patch({ HAPPIER_HOME_DIR: homeDir });
            reloadConfiguration();
            try {
                await seedTestServerProfile({ id: 'home', homeId: 'srv_runtime_fixture_home', serverUrl: 'https://home.test' });
        const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: homeDir,
            controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const stored = createDeploymentTargetRoleAdmissionFixture(role);
        const definition = await normalizeStoredComposeDefinitionInput({ from: 'image', image: 'nginx:alpine', port: 80 });
        stored.state.environment.content.definition = definition;
        stored.state.receipt.content.sourceIntent = definition;
        const input = { ...stored.input, ...(role === 'deploy' ? { sourceIntent: definition } : {}) };
        const keys = nacl.sign.keyPair();
        const link = stored.state.environment.targetLinks[0]!.targetLink;
        link.machineId = 'runtime'; link.installationId = 'runtime-installation';
        const host = { ...stored.host, machineId: 'runtime', installationId: 'runtime-installation',
            credentials: { ...stored.host.credentials, token: `fixture.${Buffer.from(JSON.stringify({ sub: 'custody-account' })).toString('base64url')}.signature` } };
        const secret = 'opaque-runtime-role-secret';
        const resourceId = 'runtime-role-resource';
        stored.state.environment.content.bindings = [{ purpose: 'variable', phase: 'runtime', name: 'ROLE_SECRET',
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }];
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: stored.input.environmentId,
            machineId: host.machineId, installationId: host.installationId, resourceId, resourceRevision: 1 },
            installationPublicKey: keys.publicKey, content: { kind: 'secret', value: secret } });
        // Installed identity, signed Home transport and executable resolution are
        // genuine system boundaries; the role, source, facade and Exec owners stay real.
        const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: host.installationId, createdAt: 1, publicKey: encodeBase64(keys.publicKey, 'base64url'),
            privateKey: encodeBase64(keys.secretKey, 'base64url') });
        const requests: unknown[] = [];
        const http = vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (!config.url?.endsWith('/secret-launch-admission')) throw new Error('Unexpected Home request');
            requests.push(config.data);
            return { status: 200, data: { ok: true, grants: [grant] } };
        });
        const base = connectedAccountActionManifest();
        const action = base.contributes.actions[0]!;
        const pluginManifest = normalizePluginManifestV2({ ...base, contributes: { ...base.contributes,
            actions: (['inspect', 'link', 'deploy', 'observe'] as const).map(role => ({ ...action,
                id: role, surfaces: ['plugin'], dangerLevel: role === 'inspect' || role === 'observe' ? 'safe' : 'writesLocal',
                readOnly: role === 'inspect' || role === 'observe',
                inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema,
                resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
            })),
            deploymentTargets: [{ id: 'platform', title: 'Runtime', icon: 'server-outline', targetKind: 'platform', role: 'runtime',
                targetSchema: { type: 'object', additionalProperties: false }, linkSchema: { type: 'object', additionalProperties: false },
                actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' } }],
        } });
        let observed: Awaited<ReturnType<PluginInvocationContext['services']['exec']['run']>> | undefined;
        const accountOwner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'custody-account', store: { read: async () => ({ v: 1, bindings: [] }),
                update: async () => { throw new Error('No selection write'); }, subscribe: () => ({ dispose() {} }) },
            selectTarget: async () => { throw new Error('No interactive selection'); },
            resolveTarget: async () => ({ displayName: 'Selected Account', account: stored.input.credentialRef }),
            materializeAccount: async () => { throw new Error('No provider credential requested'); },
            projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined,
        });
        const target = buildRegistry({ contributes: registry({ pluginManifest }), actionFormConnectedAccounts: accountOwner,
            targetRegistrations: [{ pluginId: 'acme.alpha', occurrenceId: '7', registration: { family: 'actions', localId: role,
                value: async (_input: JsonValue, context: PluginInvocationContext) => {
                    if (role === 'observe') {
                        expect(context.services.availability('deploymentExecEnv')).toMatchObject({ status: 'unavailable' });
                        return { v: 1, state: 'queued', observedAtMs: 1000 };
                    }
                    const source = await context.services.deploymentSource.materialize({ environmentId: stored.input.environmentId,
                        deploymentId: stored.state.receipt.deployment.id });
                    try {
                        await expect(context.services.deploymentExecEnv.prepare({ source, phase: 'build' }))
                            .rejects.toMatchObject({ data: { code: 'unavailable' } });
                        await expect(context.services.deploymentExecEnv.prepare({ source: { ...source }, phase: 'runtime' }))
                            .rejects.toMatchObject({ data: { code: 'unavailable' } });
                        observed = await runDeploymentRuntimeProbe({ source, execEnv: context.services.deploymentExecEnv,
                            exec: context.services.exec, executable: { kind: 'systemTool', id: 'fixture.node' },
                            args: ['-e', 'process.stdout.write(process.env.ROLE_SECRET + " runtime-ok")'], signal: context.signal });
                        return { v: 1, state: 'queued', observedAtMs: 1000 };
                    } finally { await source.abort(); }
                } } }], targetActivationFacts: [fact({ required: [{ family: 'actions', localId: role }], bound: [{ family: 'actions', localId: role }] })],
            readDeploymentTargetRoleAdmissionHost: async () => host,
            createServices: createPluginInvocationServicesFactory({ loggerSink: { write() {} }, exec: {
                async resolveExecutable() { return { command: process.execPath }; },
                async resolvePath() { throw new Error('No filesystem path selector'); },
            } }),
            resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: (generation, id) =>
                createPluginInvocationServiceBinding(generation, id) }),
        });
        try {
            const result = await target.invoke({ pluginId: 'acme.alpha', localId: role, input, surface: 'plugin',
                approvalContext: stored.request.context, operationAcceptance: stored.request.context.operationAcceptance,
                caller: { kind: 'plugin', pluginId: 'acme.alpha', occurrenceId: '7',
                    contribution: { id: role, qualifiedId: `acme.alpha/actions/${role}` },
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-alpha', installSource: 'archive' } } });
            expect(result.status, JSON.stringify(result)).toBe('executed');
            if (role === 'observe') { expect(observed).toBeUndefined(); expect(requests).toHaveLength(0); return; }
            expect(observed?.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            const output = new TextDecoder().decode(observed?.stdout);
            expect(output).toContain('runtime-ok');
            expect(output).not.toContain(secret);
            expect(requests).toHaveLength(1);
        } finally { target.dispose(); http.mockRestore(); installation.mockRestore(); await mounted.dispose(); }
            } finally { envScope.restore(); reloadConfiguration(); }
        });
    });
});
