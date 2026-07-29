import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginSettingsGetRequestSchema,
    DaemonPluginSettingsGetResponseSchema,
    DaemonPluginSettingsSetRequestSchema,
    DaemonPluginSettingsSetResponseSchema,
    DaemonPluginStructuredMessageResolveRequestSchema,
    DaemonPluginStructuredMessageResolveResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    type DaemonPluginSettingsSnapshot,
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    DaemonPluginReactNativeCrashReportRequestV1Schema,
    DaemonPluginReactNativeCrashReportResponseV1Schema,
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    type FeatureDecision,
    type DaemonReactNativeHostRuntimeIdentityV1,
    type DaemonReactNativeWebLoaderCapabilityV1,
    type DaemonPluginReactNativeBundleCacheIdentityV1,
    type DaemonContributionRegistryProjectionDescribeRequest,
    type DaemonContributionRegistryProjectionDescribeResponse,
    type PluginSettingFieldV2,
    type DaemonPluginUiArtifactBytesReadResponse,
    type DaemonPluginReactNativeCrashReportResponseV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginSettingsService } from '@happier-dev/plugin-sdk/runtime';
import {
    computePluginUiArtifactSha256DigestV1,
    PluginUiChannelV1Schema,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import type { ResolvedContributionRegistry, ResolvedUiArtifactContribution } from '@/plugins/projection/registry/types';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { adaptTargetActivationFacts } from '@/plugins/projection/introspection/targetActivationFacts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import {
    resolvePluginUiProjectionHostRuntime,
} from '@/plugins/projection/registry/ui/hostRuntime';
import {
    findGeneratedReactNativeArtifactEntry,
    findResolvedGeneratedReactNativeArtifactOwner,
    type ResolvedGeneratedReactNativeArtifactOwner,
} from '@/plugins/projection/registry/ui/generatedUiArtifactOwners';
import { resolveDeclarativeProjectionModels } from '@/plugins/projection/registry/ui/declarativeModels';
import type {
    ReactNativeHostRuntimeReadinessIdentity,
} from '@/plugins/projection/registry/ui/hostRuntime';
import type {
    StablePluginDeclarativeNode,
    StablePluginQualifiedReference,
} from '@/plugins/runtime/invocation/services/declarativeModel';
import type {
    StablePluginStructuredMessageResolution,
} from '@/plugins/runtime/invocation/services/structuredMessageConsumer';
import {
    createReactNativeCrashDisableStateStore,
    createReactNativeCrashDisableContributionKey,
    recordReactNativeCrashDisableReport,
    resolveReactNativeCrashDisabledContributionIdsForProjection,
    type ReactNativeCrashDisableCurrentCacheIdentity,
} from '@/plugins/runtime/ui/reactNativeCrashDisableState';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
    validateInstalledReactNativeBundleArtifact,
    type ReactNativeBundleCacheIdentity,
    type ReactNativeBundleHostRuntime,
} from '@/plugins/install/ui/reactNativeBundles';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import {
    assertPluginSettingFieldValue,
} from '@/plugins/runtime/context/settings';
import { createPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { PluginContextServiceError } from '@/plugins/runtime/context/errors';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    assertLocalSettingsDeclarationsAccessible,
    flattenLocalSettingsFields,
    resolveLocalSettingsDeclarations,
} from '@/plugins/settings/localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import { activateScmRuntimeContributionsOnDemand } from '@/scm/scmBackendCatalog';

export type DaemonContributionRegistryProjectionRegistrationOptions = Readonly<{
    resolveRegistry?: () => Promise<ResolvedContributionRegistry>;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    resolveInstalledPackages?: () => Promise<readonly PluginCatalogEntry[]>;
    resolveGeneration?: () => Promise<number>;
    resolveHostedWebFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveReactNativeBundlesFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveReactNativeDevHotReloadFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveStructuredMessagesFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    // G-RC4: the SAME async server-features provider shape as the inventory/quotas/browser gates.
    // Threaded so the four plugin-UI-tier fallback decisions resolve against the live server
    // snapshot — a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the
    // projection (master §3.5 "server disables X → daemon refuses").
    resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
    resolveReactNativeCrashDisabledContributionIds?: (
        input: Readonly<{
            registry: ResolvedContributionRegistry;
            generation: number;
            pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
        }>,
    ) => Promise<readonly string[]> | readonly string[];
    processEnv?: NodeJS.ProcessEnv;
    installedReactNativeArtifactLoaderAvailable?: boolean;
    reactNativeScriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
}>;

let cachedProjection: DaemonContributionRegistryProjectionDescribeResponse | null = null;
let cachedAtMs = 0;
let cachedProjectionKey: string | null = null;
const CACHE_TTL_MS = 10_000;

export function invalidateDaemonContributionRegistryProjectionCache(): void {
    cachedProjection = null;
    cachedAtMs = 0;
    cachedProjectionKey = null;
}

async function defaultResolveRegistry(): Promise<ResolvedContributionRegistry> {
    return await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
}

async function defaultResolveInstalledPackages(): Promise<readonly PluginCatalogEntry[]> {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    return await readCurrentDaemonPluginCatalog({
        happyHomeDir: configuration.happyHomeDir,
        reloadController: pluginReloadController,
    });
}

async function defaultResolveGeneration(): Promise<number> {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    return pluginReloadController.getState().generation;
}

async function resolveProjectionServerFeaturesSnapshot(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
): Promise<CliServerFeaturesSnapshot | undefined> {
    if (!opts?.resolveServerFeaturesSnapshot) return undefined;
    try {
        return await opts.resolveServerFeaturesSnapshot();
    } catch {
        // Best-effort: a failed provider leaves the tiers fail-closed (snapshot-less decision).
        return undefined;
    }
}

async function resolveReactNativeBundlesFeatureDecision(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
): Promise<FeatureDecision> {
    return await (opts?.resolveReactNativeBundlesFeatureDecision?.()
        ?? resolveCliFeatureDecision({
            featureId: 'plugins.ui.reactNativeBundles',
            env: opts?.processEnv ?? process.env,
            ...(serverSnapshot ? { serverSnapshot } : {}),
        }));
}

async function resolveReactNativeDevHotReloadFeatureDecision(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
): Promise<FeatureDecision> {
    return await (opts?.resolveReactNativeDevHotReloadFeatureDecision?.()
        ?? resolveCliFeatureDecision({
            featureId: 'plugins.ui.reactNativeBundles.devHotReload',
            env: opts?.processEnv ?? process.env,
            ...(serverSnapshot ? { serverSnapshot } : {}),
        }));
}

async function resolveHostedWebFeatureDecision(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
): Promise<FeatureDecision> {
    return await (opts?.resolveHostedWebFeatureDecision?.()
        ?? resolveCliFeatureDecision({
            featureId: 'plugins.ui.hostedWeb',
            env: opts?.processEnv ?? process.env,
            ...(serverSnapshot ? { serverSnapshot } : {}),
        }));
}

async function resolveStructuredMessagesFeatureDecision(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    serverSnapshot: CliServerFeaturesSnapshot | undefined,
): Promise<FeatureDecision> {
    return await (opts?.resolveStructuredMessagesFeatureDecision?.()
        ?? resolveCliFeatureDecision({
            featureId: 'plugins.ui.structuredMessages',
            env: opts?.processEnv ?? process.env,
            ...(serverSnapshot ? { serverSnapshot } : {}),
        }));
}

function createProjectionCacheKey(input: Readonly<{
    generation: number;
    registryCacheToken: string;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): string {
    return JSON.stringify({
        generation: input.generation,
        registryCacheToken: input.registryCacheToken,
        pluginUiHostRuntime: input.pluginUiHostRuntime,
    });
}

async function resolveProjectionHostRuntime(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    params?: Readonly<{
        reactNativeCrashDisabledContributionIds?: readonly string[];
        reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
        reactNativeWebLoaderCapability?: DaemonReactNativeWebLoaderCapabilityV1;
    }>,
): Promise<ReturnType<typeof resolvePluginUiProjectionHostRuntime>> {
    const reactNativeHostRuntime = params?.reactNativeHostRuntimeIdentity
        ? toReactNativeHostRuntimeReadinessIdentity(params.reactNativeHostRuntimeIdentity)
        : opts?.reactNativeHostRuntime;
    // PR-13: when the reported identity carries ScriptManager readiness, the
    // gate inputs originate from that reported capability — never from a daemon
    // assertion or the static registration opts. Absent ⇒ fall back to the
    // static test/override seam, which itself defaults fail-closed.
    const reportedScriptManagerReadiness = reactNativeHostRuntime?.scriptManagerRuntime;
    const installedArtifactLoaderAvailable = reportedScriptManagerReadiness
        ? reportedScriptManagerReadiness.installedArtifactLoaderAvailable
        : opts?.installedReactNativeArtifactLoaderAvailable;
    const scriptManagerRuntimeIntegrated = reportedScriptManagerReadiness
        ? reportedScriptManagerReadiness.integrated
        : opts?.reactNativeScriptManagerRuntimeIntegrated;
    // G-RC4: resolve the server-features snapshot once per host-runtime resolve and thread it into
    // every plugin-UI-tier fallback decision so a server that disables `plugins`/`plugins.ui`
    // cascades the tiers OFF in the projection. A missing/failed provider keeps the tiers
    // fail-closed (the decisions still resolve, just snapshot-less ⇒ client-fail-closed default).
    const serverFeaturesSnapshot = await resolveProjectionServerFeaturesSnapshot(opts);
    return resolvePluginUiProjectionHostRuntime({
        hostAppVersion: configuration.currentCliVersion,
        hostedWebFeatureDecision: await resolveHostedWebFeatureDecision(opts, serverFeaturesSnapshot),
        reactNativeBundlesFeatureDecision: await resolveReactNativeBundlesFeatureDecision(opts, serverFeaturesSnapshot),
        reactNativeDevHotReloadFeatureDecision: await resolveReactNativeDevHotReloadFeatureDecision(opts, serverFeaturesSnapshot),
        structuredMessagesFeatureDecision: await resolveStructuredMessagesFeatureDecision(opts, serverFeaturesSnapshot),
        // Phase 6.2: the UI-reported deployment CSP capability is the source of
        ...(params?.reactNativeCrashDisabledContributionIds
            ? { reactNativeCrashDisabledContributionIds: params.reactNativeCrashDisabledContributionIds }
            : {}),
        ...(installedArtifactLoaderAvailable !== undefined
            ? { installedArtifactLoaderAvailable }
            : {}),
        ...(scriptManagerRuntimeIntegrated !== undefined
            ? { scriptManagerRuntimeIntegrated }
            : {}),
        ...(reactNativeHostRuntime
            ? { reactNativeHostRuntime }
            : {}),
        ...(params?.reactNativeWebLoaderCapability
            ? { reactNativeWebLoaderCapability: params.reactNativeWebLoaderCapability }
            : {}),
    });
}

function toReactNativeHostRuntimeReadinessIdentity(
    identity: DaemonReactNativeHostRuntimeIdentityV1,
): ReactNativeHostRuntimeReadinessIdentity {
    return Object.freeze({
        ...(identity.appVersion ? { hostAppVersion: identity.appVersion } : {}),
        ...(identity.reactVersion ? { reactVersion: identity.reactVersion } : {}),
        ...(identity.reactNativeVersion ? { reactNativeVersion: identity.reactNativeVersion } : {}),
        platform: identity.platform,
        channel: identity.channel,
        ...(identity.expoRuntimeVersion ? { expoRuntimeVersion: identity.expoRuntimeVersion } : {}),
        ...(identity.hermesVersion ? { hermesVersion: identity.hermesVersion } : {}),
        availableNativeCapabilities: Object.freeze([...identity.availableNativeCapabilities]),
        // Consume the readiness the UI native probe reported on the identity
        // (PR-13). Never assert it here.
        ...(identity.scriptManagerRuntime
            ? {
                scriptManagerRuntime: Object.freeze({
                    integrated: identity.scriptManagerRuntime.integrated,
                    installedArtifactLoaderAvailable:
                        identity.scriptManagerRuntime.installedArtifactLoaderAvailable,
                }),
            }
            : {}),
    });
}

function readCurrentReactNativeCacheKeysForCrashDisable(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): Readonly<Record<string, ReactNativeCrashDisableCurrentCacheIdentity>> {
    const projection = buildPluginProjectionV2({
        registry: params.registry,
        generation: params.generation,
        installedPackages: [],
        pluginDiagnosticsByPluginId: {},
        pluginUiHostRuntime: params.pluginUiHostRuntime,
    });
    const entries = projection.familiesById.pluginUi?.entriesById ?? {};
    const currentCacheKeysByContributionId: Record<string, ReactNativeCrashDisableCurrentCacheIdentity> = {};
    for (const entry of Object.values(entries)) {
        const entryRecord = readRecord(entry);
        if (entryRecord?.contributionKind !== 'reactNativeBundle') continue;

        const pluginId = typeof entryRecord.pluginId === 'string' ? entryRecord.pluginId.trim() : '';
        const contributionId = typeof entryRecord.contributionId === 'string' ? entryRecord.contributionId.trim() : '';
        if (!pluginId || !contributionId) continue;

        const runtime = readRecord(entryRecord.runtime);
        const cacheKey = typeof runtime?.cacheKey === 'string' ? runtime.cacheKey.trim() : '';
        if (!cacheKey) continue;

        const cacheIdentity = readRecord(runtime?.cacheIdentity);
        const artifactDigest = typeof cacheIdentity?.artifactDigest === 'string'
            ? cacheIdentity.artifactDigest.trim()
            : '';
        const contributionKey = `${pluginId}:${contributionId}`;
        const currentIdentity: ReactNativeCrashDisableCurrentCacheIdentity = artifactDigest
            ? { cacheKey, artifactDigest }
            : { cacheKey };
        currentCacheKeysByContributionId[contributionKey] = currentIdentity;
        currentCacheKeysByContributionId[contributionId] = currentIdentity;
    }
    return currentCacheKeysByContributionId;
}

function resolveFailClosedReactNativeCrashDisabledContributionIds(
    currentCacheKeysByContributionId: Readonly<Record<string, ReactNativeCrashDisableCurrentCacheIdentity>>,
): readonly string[] {
    return Object.freeze(Object.keys(currentCacheKeysByContributionId)
        .filter((contributionId) => contributionId.includes(':'))
        .sort((left, right) => left.localeCompare(right)));
}

async function defaultResolveReactNativeCrashDisabledContributionIdsForProjection(input: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): Promise<readonly string[]> {
    const currentCacheKeysByContributionId = readCurrentReactNativeCacheKeysForCrashDisable(input);
    try {
        const state = await createReactNativeCrashDisableStateStore({
            happyHomeDir: configuration.happyHomeDir,
        }).read();
        return resolveReactNativeCrashDisabledContributionIdsForProjection({
            state,
            currentCacheKeysByContributionId,
        });
    } catch {
        return resolveFailClosedReactNativeCrashDisabledContributionIds(currentCacheKeysByContributionId);
    }
}

async function resolveReactNativeCrashDisabledContributionIds(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    input: Readonly<{
        registry: ResolvedContributionRegistry;
        generation: number;
        pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    }>,
): Promise<readonly string[]> {
    return await (opts?.resolveReactNativeCrashDisabledContributionIds?.(input)
        ?? defaultResolveReactNativeCrashDisabledContributionIdsForProjection(input));
}

async function resolveProjectionHostRuntimeWithCrashDisableState(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    input: Readonly<{
        registry: ResolvedContributionRegistry;
        generation: number;
        reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
        reactNativeWebLoaderCapability?: DaemonReactNativeWebLoaderCapabilityV1;
    }>,
): Promise<ReturnType<typeof resolvePluginUiProjectionHostRuntime>> {
    const baseHostRuntime = await resolveProjectionHostRuntime(opts, {
        ...(input.reactNativeHostRuntimeIdentity
            ? { reactNativeHostRuntimeIdentity: input.reactNativeHostRuntimeIdentity }
            : {}),
        ...(input.reactNativeWebLoaderCapability
            ? { reactNativeWebLoaderCapability: input.reactNativeWebLoaderCapability }
            : {}),
    });
    const crashDisabledContributionIds = await resolveReactNativeCrashDisabledContributionIds(opts, {
        ...input,
        pluginUiHostRuntime: baseHostRuntime,
    });
    return crashDisabledContributionIds.length === 0
        ? baseHostRuntime
        : await resolveProjectionHostRuntime(opts, {
            ...(input.reactNativeHostRuntimeIdentity
                ? { reactNativeHostRuntimeIdentity: input.reactNativeHostRuntimeIdentity }
                : {}),
            ...(input.reactNativeWebLoaderCapability
                ? { reactNativeWebLoaderCapability: input.reactNativeWebLoaderCapability }
                : {}),
            reactNativeCrashDisabledContributionIds: crashDisabledContributionIds,
        });
}

async function acquireProjectionRuntimeRegistryLease(opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined): Promise<Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    release: () => Promise<void>;
}>> {
    if (opts?.resolveRuntimeRegistry) {
        return {
            registry: await opts.resolveRuntimeRegistry(),
            release: async () => {},
        };
    }

    return await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir,
    });
}

function projectQualifiedReferenceGeneration<T extends StablePluginQualifiedReference>(
    reference: T,
    generation: string,
): T {
    return Object.freeze({ ...reference, generation });
}

function projectDeclarativeNodeGeneration(
    node: StablePluginDeclarativeNode,
    generation: string,
): StablePluginDeclarativeNode {
    switch (node.kind) {
        case 'stack':
        case 'group':
            return Object.freeze({
                ...node,
                children: Object.freeze(node.children.map((child) => (
                    projectDeclarativeNodeGeneration(child, generation)
                ))),
            });
        case 'action':
            return Object.freeze({
                ...node,
                action: projectQualifiedReferenceGeneration(node.action, generation),
            });
        case 'text':
        case 'markdown':
        case 'field':
        case 'status':
            return node;
    }
}

function projectStructuredMessageResolutionGeneration(
    resolution: StablePluginStructuredMessageResolution,
    generation: string,
): StablePluginStructuredMessageResolution {
    return Object.freeze({
        model: Object.freeze({
            ...resolution.model,
            identity: Object.freeze({ ...resolution.model.identity, generation }),
            renderer: projectQualifiedReferenceGeneration(resolution.model.renderer, generation),
            actions: Object.freeze(resolution.model.actions.map((action) => (
                projectQualifiedReferenceGeneration(action, generation)
            ))),
            resources: Object.freeze(resolution.model.resources.map((resource) => (
                projectQualifiedReferenceGeneration(resource, generation)
            ))),
        }),
        renderer: Object.freeze({
            ...resolution.renderer,
            identity: Object.freeze({ ...resolution.renderer.identity, generation }),
            root: projectDeclarativeNodeGeneration(resolution.renderer.root, generation),
            nodes: Object.freeze(resolution.renderer.nodes.map((node) => (
                projectDeclarativeNodeGeneration(node, generation)
            ))),
        }),
        resources: Object.freeze(resolution.resources.map((resource) => Object.freeze({
            ...resource,
            reference: projectQualifiedReferenceGeneration(resource.reference, generation),
        }))),
    });
}

function readPluginSettingsDeclaration(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string,
    machineId: string,
): Readonly<{
    fields: readonly PluginSettingFieldV2[];
    storageScope: DaemonPluginSettingsSnapshot['storageScope'];
}> {
    const declarations = resolveLocalSettingsDeclarations({
        settings: [
            ...(registry.contributes.settings ?? []),
            ...resolveNotificationChannelSettingsContributions(
                registry.contributes.notificationChannels ?? [],
            ),
        ],
        pluginId,
    });
    assertLocalSettingsDeclarationsAccessible({
        declarations,
        facts: resolveInvocationContributionPolicyFacts({
            facts: { 'machine.id': machineId },
        }),
        supportedScopes: new Set(['local', 'synced']),
    });
    const storageScope = declarations[0]?.definition.scope;
    if (!storageScope || declarations.some((entry) => entry.definition.scope !== storageScope)) {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_DECLARATION_INVALID',
            `Plugin settings declarations for '${pluginId}' have no single canonical storage scope`,
        );
    }
    return {
        fields: flattenLocalSettingsFields(declarations),
        storageScope,
    };
}

async function withPluginSettingsService<T>(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    pluginId: string,
    machineId: string,
    run: (params: Readonly<{
        service: PluginSettingsService;
        secrets: ReturnType<typeof createPluginSecretStore>;
        fields: readonly PluginSettingFieldV2[];
        storageScope: DaemonPluginSettingsSnapshot['storageScope'];
    }>) => Promise<T>,
): Promise<T> {
    const lease = await acquireProjectionRuntimeRegistryLease(opts);
    try {
        const { fields, storageScope } = readPluginSettingsDeclaration(lease.registry, pluginId, machineId);
        const paths = resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir });
        const service = lease.registry.createPluginSettingsService?.({ pluginId }) ?? null;
        if (!service) {
            throw new PluginContextServiceError(
                'PLUGIN_SETTINGS_RUNTIME_UNAVAILABLE',
                `Plugin settings for '${pluginId}' have no current canonical runtime owner`,
            );
        }
        const secrets = createPluginSecretStore({ pluginId, paths });
        return await run({
            service,
            secrets,
            fields,
            storageScope,
        });
    } finally {
        await lease.release();
    }
}

async function readPluginSettingsSnapshot(params: Readonly<{
    pluginId: string;
    service: PluginSettingsService;
    secrets: ReturnType<typeof createPluginSecretStore>;
    fields: readonly PluginSettingFieldV2[];
    storageScope: DaemonPluginSettingsSnapshot['storageScope'];
}>): Promise<DaemonPluginSettingsSnapshot> {
    const stableSnapshot = await params.service.snapshot();
    const rawSettings = stableSnapshot.values;
    const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
        ? rawSettings as Readonly<Record<string, unknown>>
        : {};
    const values: Record<string, unknown> = {};
    const persistedSecretNames = new Set((await params.secrets.list()).map((entry) => entry.name));
    const redactedKeys = params.fields
        .filter((field) => field.secret === true && persistedSecretNames.has(field.id))
        .map((field) => field.id);

    for (const field of params.fields) {
        if (field.secret === true) continue;
        if (!Object.prototype.hasOwnProperty.call(settings, field.id)) {
            continue;
        }
        values[field.id] = settings[field.id];
    }

    return DaemonPluginSettingsGetResponseSchema.parse({
        protocolVersion: 1,
        pluginId: params.pluginId,
        storageScope: params.storageScope,
        revision: stableSnapshot.revision,
        values,
        redactedKeys: redactedKeys.sort((left, right) => left.localeCompare(right)),
    });
}

async function acquireProjectionContributionRegistryLease(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    generation: number,
): Promise<Readonly<{
    registry: ResolvedContributionRegistry;
    pluginDiagnosticsByPluginId: ResolvedExecutablePluginRuntimeRegistry['pluginDiagnosticsByPluginId'];
    targetActivationFacts: NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActivationFacts']> | null;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    cacheToken: string;
    release: () => Promise<void>;
}>> {
    if (opts?.resolveRuntimeRegistry) {
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        return {
            registry: lease.registry.contributes,
            pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
            targetActivationFacts: lease.registry.targetActivationFacts ?? null,
            runtimeRegistry: lease.registry,
            cacheToken: `runtime:${generation}`,
            release: lease.release,
        };
    }

    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    if (pluginReloadController.getState().activeRegistry) {
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        return {
            registry: lease.registry.contributes,
            pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
            targetActivationFacts: lease.registry.targetActivationFacts ?? null,
            runtimeRegistry: lease.registry,
            cacheToken: `runtime:${generation}`,
            release: lease.release,
        };
    }

    const registry = await (opts?.resolveRegistry ?? defaultResolveRegistry)();
    if (
        (registry.scmBackends?.length ?? 0) > 0
        || (registry.scmHostingProviders?.length ?? 0) > 0
    ) {
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        return {
            registry: lease.registry.contributes,
            pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
            targetActivationFacts: lease.registry.targetActivationFacts ?? null,
            runtimeRegistry: lease.registry,
            cacheToken: `runtime:${generation}`,
            release: lease.release,
        };
    }
    return {
        registry,
        pluginDiagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
        targetActivationFacts: null,
        runtimeRegistry: null,
        cacheToken: `metadata:${registry.generationId ?? 'unknown'}`,
        release: async () => {},
    };
}

async function resolveProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    request?: DaemonContributionRegistryProjectionDescribeRequest,
): Promise<DaemonContributionRegistryProjectionDescribeResponse> {
    const now = Date.now();
    const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
    const lease = await acquireProjectionContributionRegistryLease(opts, generation);
    try {
        const scmRuntimeAvailability = await (async () => {
            if (!lease.runtimeRegistry) {
                return {
                    backendIds: new Set<string>(),
                    hostingProviderIds: new Set<string>(),
                };
            }
            await activateScmRuntimeContributionsOnDemand(lease.runtimeRegistry);
            return {
                backendIds: new Set(lease.runtimeRegistry.scmBackendsById?.keys() ?? []),
                hostingProviderIds: new Set(lease.runtimeRegistry.scmHostingProvidersById.keys()),
            };
        })();
        const resolvedPluginUiHostRuntime = await resolveProjectionHostRuntimeWithCrashDisableState(opts, {
            registry: lease.registry,
            generation,
            ...(request?.reactNativeHostRuntimeIdentity
                ? { reactNativeHostRuntimeIdentity: request.reactNativeHostRuntimeIdentity }
                : {}),
            ...(request?.reactNativeWebLoaderCapability
                ? { reactNativeWebLoaderCapability: request.reactNativeWebLoaderCapability }
                : {}),
        });
        const modelsByRendererKey = typeof lease.runtimeRegistry?.generation === 'number'
            ? resolveDeclarativeProjectionModels({
                registry: lease.registry,
                generation,
                ...(lease.runtimeRegistry.targetActionInvocations
                    ? { actionRuntime: lease.runtimeRegistry.targetActionInvocations }
                    : {}),
            })
            : Object.freeze({});
        const pluginUiHostRuntime = Object.freeze({
            ...resolvedPluginUiHostRuntime,
            declarative: Object.freeze({ modelsByRendererKey }),
        });
        const cacheKey = createProjectionCacheKey({
            generation,
            registryCacheToken: lease.cacheToken,
            pluginUiHostRuntime,
        });
        if (cachedProjection && cachedProjectionKey === cacheKey && now - cachedAtMs < CACHE_TTL_MS) {
            return cachedProjection;
        }

        const activationIntrospection = lease.targetActivationFacts
            ? adaptTargetActivationFacts({
                generation: lease.runtimeRegistry?.generation ?? generation,
                candidates: lease.registry.introspectionContributions ?? [],
                plugins: lease.registry.activationTargets.map((target) => ({
                    pluginId: target.pluginId,
                    pluginVersion: target.manifest.version,
                    source: mapPluginSourceToDiagnosticSource(target.sourceSpec),
                })),
                targetActivationFacts: lease.targetActivationFacts,
                runtimeState: 'current',
            })
            : undefined;
        const introspectionRuntimeSnapshot = activationIntrospection
            ? Object.freeze({
                ...activationIntrospection,
                // This is a snapshot of the current public projection revision.
                // Individual retained registrations keep their internal activation generation.
                generation,
            })
            : undefined;
        const projection = buildPluginProjectionV2({
            registry: lease.registry,
            generation,
            installedPackages: await (opts?.resolveInstalledPackages ?? defaultResolveInstalledPackages)(),
            pluginDiagnosticsByPluginId: lease.pluginDiagnosticsByPluginId,
            pluginUiHostRuntime,
            scmRuntimeAvailability,
            ...(introspectionRuntimeSnapshot ? { introspectionRuntimeSnapshot } : {}),
        });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1,
            projection,
        });
        cachedProjection = response;
        cachedAtMs = now;
        cachedProjectionKey = cacheKey;
        return response;
    } finally {
        await lease.release();
    }
}

function reactNativeIdentityMatches(
    left: ReactNativeBundleCacheIdentity,
    right: DaemonPluginReactNativeBundleCacheIdentityV1,
): boolean {
    return left.pluginId === right.pluginId
        && left.contributionId === right.contributionId
        && left.artifactDigest === right.artifactDigest
        && left.hostAppVersion === right.hostAppVersion
        && left.hostUiApiVersion === right.hostUiApiVersion
        && left.reactVersion === right.reactVersion
        && left.reactNativeVersion === right.reactNativeVersion
        && (left.expoRuntimeVersion ?? '') === (right.expoRuntimeVersion ?? '')
        && (left.hermesVersion ?? '') === (right.hermesVersion ?? '')
        && left.platform === right.platform
        && left.channel === right.channel
        && left.nativeCapabilitiesDigest === right.nativeCapabilitiesDigest
        && left.projectionGeneration === right.projectionGeneration;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readProjectedReactNativeCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): DaemonPluginReactNativeBundleCacheIdentityV1 | null {
    return readProjectedReactNativeExecutableIdentity(params)?.cacheIdentity ?? null;
}

function readProjectedReactNativeExecutableIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): Readonly<{
    cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1;
    cacheKey: string;
}> | null {
    const projection = buildPluginProjectionV2({
        registry: params.registry,
        generation: params.generation,
        installedPackages: [],
        pluginDiagnosticsByPluginId: {},
        pluginUiHostRuntime: params.pluginUiHostRuntime,
    });
    const entry = projection.familiesById.pluginUi?.entriesById[
        `reactNativeBundle:${params.identity.pluginId}:${params.identity.contributionId}`
    ];
    const runtime = readRecord(entry?.runtime);
    const decision = readRecord(runtime?.decision);
    if (decision?.state !== 'load') {
        return null;
    }
    const loadPolicy = readRecord(runtime?.loadPolicy);
    if (loadPolicy?.source !== 'installedArtifact') {
        return null;
    }
    const cacheKey = typeof runtime?.cacheKey === 'string' ? runtime.cacheKey.trim() : '';
    if (!cacheKey) {
        return null;
    }
    const parsed = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(runtime?.cacheIdentity);
    return parsed.success ? { cacheIdentity: parsed.data, cacheKey } : null;
}

function findReactNativeArtifactForCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
}>): ResolvedUiArtifactContribution | null {
    const channel = PluginUiChannelV1Schema.safeParse(params.identity.channel);
    if (!channel.success) {
        return null;
    }
    return (params.registry.uiArtifacts ?? []).find((artifact) => {
        const definition = artifact.definition;
        return artifact.pluginId === params.identity.pluginId
            && definition.contributionId === params.identity.contributionId
            && definition.contributionFamily === 'reactNativeBundles'
            && definition.artifactKind === 'reactNativeBundle'
            && definition.integrity?.digest === params.identity.artifactDigest
            && definition.platform === params.identity.platform
            && definition.compatibility.supportedChannels?.some(
                (supportedChannel) => supportedChannel === channel.data,
            );
    }) ?? null;
}

function findGeneratedReactNativeArtifactGraph(params: Readonly<{
    owner: ResolvedGeneratedReactNativeArtifactOwner;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
}>): PluginUiArtifactsManifestEntryV1 | null {
    const resolved = findGeneratedReactNativeArtifactEntry({
        owner: params.owner,
        platform: params.identity.platform,
    });
    return resolved.entry?.digest === params.identity.artifactDigest ? resolved.entry : null;
}

function toHostRuntimeFromCacheIdentity(
    identity: DaemonPluginReactNativeBundleCacheIdentityV1,
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>,
): ReactNativeBundleHostRuntime | null {
    const currentRuntime = pluginUiHostRuntime.reactNativeBundles?.hostRuntime;
    if (!currentRuntime) {
        return null;
    }

    const hostAppVersion = currentRuntime.hostAppVersion?.trim();
    const hostUiApiVersion = currentRuntime.hostUiApiVersion?.trim();
    const reactVersion = currentRuntime.reactVersion?.trim();
    const reactNativeVersion = currentRuntime.reactNativeVersion?.trim();
    if (!hostAppVersion || !hostUiApiVersion || !reactVersion || !reactNativeVersion) {
        return null;
    }

    return Object.freeze({
        hostAppVersion,
        hostUiApiVersion,
        reactVersion,
        reactNativeVersion,
        ...(currentRuntime.expoRuntimeVersion ? { expoRuntimeVersion: currentRuntime.expoRuntimeVersion } : {}),
        ...(currentRuntime.hermesVersion ? { hermesVersion: currentRuntime.hermesVersion } : {}),
        platform: identity.platform,
        channel: identity.channel,
        availableNativeCapabilities: Object.freeze([...(currentRuntime.availableNativeCapabilities ?? [])]),
        projectionGeneration: identity.projectionGeneration,
    });
}

function toArtifactManifest(artifact: ResolvedUiArtifactContribution): unknown {
    return Object.freeze({
        ...artifact.definition,
        pluginId: artifact.pluginId,
    });
}

function resolvePluginRootPath(artifact: ResolvedUiArtifactContribution): string | null {
    const explicitRoot = artifact.pluginRootPath?.trim();
    if (explicitRoot) {
        return explicitRoot;
    }

    const manifestPath = artifact.manifestPath?.trim();
    if (manifestPath) {
        const normalized = manifestPath.replace(/\\/gu, '/');
        if (normalized.endsWith('/.happier-plugin/plugin.json')) {
            return dirname(dirname(manifestPath));
        }
        return dirname(manifestPath);
    }

    return artifact.sourceSpec?.kind === 'path' ? artifact.sourceSpec.locator.trim() || null : null;
}

function artifactBytesError(
    code: Extract<DaemonPluginUiArtifactBytesReadResponse, { ok: false }>['code'],
    diagnostics: readonly string[],
): DaemonPluginUiArtifactBytesReadResponse {
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: false,
        code,
        diagnostics,
    });
}

async function readVerifiedReactNativeArtifactFile(params: Readonly<{
    pluginRootPath: string;
    relativePath: string;
    digest: string;
    byteSize?: number;
    pluginId: string;
    contributionId: string;
}>): Promise<
    | Readonly<{ ok: true; bytes: Uint8Array; digest: string; byteSize: number }>
    | Readonly<{ ok: false; response: DaemonPluginUiArtifactBytesReadResponse }>
> {
    const resolved = await resolveContainedPluginResourcePath({
        pluginRootPath: params.pluginRootPath,
        resourcePath: params.relativePath,
    });
    if (!resolved) {
        return {
            ok: false,
            response: artifactBytesError('artifact_unavailable', ['react_native_artifact_path_invalid']),
        };
    }

    let bytes: Uint8Array;
    try {
        bytes = await readFile(resolved.absolutePath);
    } catch {
        return {
            ok: false,
            response: artifactBytesError('artifact_read_failed', ['react_native_artifact_read_failed']),
        };
    }
    if (params.byteSize !== undefined && bytes.byteLength !== params.byteSize) {
        return {
            ok: false,
            response: artifactBytesError('artifact_integrity_failed', ['react_native_artifact_file_size_mismatch']),
        };
    }

    const integrity = verifyPluginUiArtifactBytesIntegrityV1({
        bytes,
        integrity: {
            digest: params.digest,
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            artifactKind: 'reactNativeBundle',
        },
    });
    if (!integrity.ok) {
        return {
            ok: false,
            response: artifactBytesError('artifact_integrity_failed', [integrity.reasonCode]),
        };
    }

    return Object.freeze({
        ok: true,
        bytes,
        digest: integrity.digest,
        byteSize: bytes.byteLength,
    });
}

function reactNativeCrashReportResponse(
    response: DaemonPluginReactNativeCrashReportResponseV1,
): DaemonPluginReactNativeCrashReportResponseV1 {
    return DaemonPluginReactNativeCrashReportResponseV1Schema.parse(response);
}

function reactNativeCrashReportError(
    code: Extract<DaemonPluginReactNativeCrashReportResponseV1, { ok: false }>['code'],
    diagnostics: readonly string[],
): DaemonPluginReactNativeCrashReportResponseV1 {
    return reactNativeCrashReportResponse({
        protocolVersion: 1,
        ok: false,
        code,
        diagnostics: [...diagnostics],
    });
}

async function readGeneratedReactNativeArtifactBytesByCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    owner: ResolvedGeneratedReactNativeArtifactOwner;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    const projected = readProjectedReactNativeExecutableIdentity(params);
    if (!projected || !reactNativeIdentityMatches(projected.cacheIdentity, params.identity)) {
        return artifactBytesError('artifact_not_found', ['react_native_projected_identity_not_found']);
    }
    const graph = findGeneratedReactNativeArtifactGraph(params);
    const expectedBundler = graph?.platform === 'web' ? 'vite' : 'repack';
    if (!graph || graph.builtWith.bundler !== expectedBundler) {
        return artifactBytesError('artifact_not_found', ['generated_react_native_artifact_graph_not_found']);
    }
    const uniqueFiles = new Set(graph.files.map((file) => file.relativePath));
    if (uniqueFiles.size !== graph.files.length || !uniqueFiles.has(graph.entry)) {
        return artifactBytesError('artifact_integrity_failed', ['generated_react_native_artifact_graph_invalid']);
    }

    const pluginRootPath = params.owner.pluginRootPath?.trim();
    if (!pluginRootPath) {
        return artifactBytesError('artifact_unavailable', ['generated_react_native_plugin_root_unavailable']);
    }
    const installedRoot = join(pluginRootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
    const loadedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
    for (const file of graph.files) {
        const relativePath = file.relativePath;
        const resolved = await resolveContainedPluginResourcePath({
            pluginRootPath: installedRoot,
            resourcePath: relativePath,
        });
        if (!resolved) {
            return artifactBytesError('artifact_unavailable', ['react_native_artifact_path_invalid']);
        }
        try {
            const bytes = await readFile(resolved.absolutePath);
            if (bytes.byteLength !== file.byteSize || computePluginUiArtifactSha256DigestV1(bytes) !== file.digest) {
                return artifactBytesError('artifact_integrity_failed', ['react_native_artifact_file_integrity_failed']);
            }
            loadedFiles.push(Object.freeze({
                relativePath,
                bytes,
            }));
        } catch {
            return artifactBytesError('artifact_read_failed', ['react_native_artifact_read_failed']);
        }
    }

    const integrity = verifyPluginUiArtifactFileSetIntegrityV1({
        files: loadedFiles,
        integrity: {
            digest: graph.digest,
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            artifactKind: 'reactNativeBundle',
        },
    });
    if (!integrity.ok) {
        return artifactBytesError('artifact_integrity_failed', [integrity.reasonCode]);
    }
    const entry = loadedFiles.find((file) => file.relativePath === graph.entry);
    if (!entry) {
        return artifactBytesError('artifact_integrity_failed', ['generated_react_native_entry_missing']);
    }
    const files = loadedFiles.map((file) => Object.freeze({
        relativePath: file.relativePath,
        digest: computePluginUiArtifactSha256DigestV1(file.bytes),
        byteSize: file.bytes.byteLength,
        bytesBase64: Buffer.from(file.bytes).toString('base64'),
    }));

    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: true,
        cacheIdentity: projected.cacheIdentity,
        artifact: {
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            artifactKind: 'reactNativeBundle',
            // This is the canonical complete-file-set digest, not an entry-byte digest.
            digest: integrity.digest,
            format: 'plainJs',
            byteSize: entry.bytes.byteLength,
        },
        bytesBase64: Buffer.from(entry.bytes).toString('base64'),
        files,
    });
}

async function readReactNativeArtifactBytesByCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    if (params.pluginUiHostRuntime.reactNativeBundles?.featureEnabled !== true) {
        return artifactBytesError('artifact_unavailable', ['feature_disabled']);
    }
    if (params.identity.projectionGeneration !== params.generation) {
        return artifactBytesError('artifact_not_found', ['react_native_projection_generation_mismatch']);
    }

    const generatedOwner = findResolvedGeneratedReactNativeArtifactOwner({
        registry: params.registry,
        pluginId: params.identity.pluginId,
        contributionId: params.identity.contributionId,
    });
    if (generatedOwner) {
        return await readGeneratedReactNativeArtifactBytesByCacheIdentity({
            ...params,
            owner: generatedOwner,
        });
    }

    const artifact = findReactNativeArtifactForCacheIdentity(params);
    if (!artifact) {
        return artifactBytesError('artifact_not_found', ['react_native_artifact_not_found']);
    }
    const hostRuntime = toHostRuntimeFromCacheIdentity(params.identity, params.pluginUiHostRuntime);
    if (!hostRuntime) {
        return artifactBytesError('artifact_unavailable', ['host_runtime_unavailable']);
    }

    const validation = validateInstalledReactNativeBundleArtifact({
        artifact: toArtifactManifest(artifact),
        expectedPluginId: params.identity.pluginId,
        expectedContributionId: params.identity.contributionId,
        hostRuntime,
    });
    if (!validation.ok) {
        return artifactBytesError(
            validation.code === 'hermes_bytecode_unsupported' ? 'unsupported_artifact_format' : 'artifact_unavailable',
            [validation.code],
        );
    }
    if (!reactNativeIdentityMatches(validation.cacheIdentity, params.identity)) {
        return artifactBytesError('artifact_not_found', ['react_native_cache_identity_mismatch']);
    }
    const projectedIdentity = readProjectedReactNativeCacheIdentity(params);
    if (!projectedIdentity || !reactNativeIdentityMatches(projectedIdentity, params.identity)) {
        return artifactBytesError('artifact_not_found', ['react_native_projected_identity_not_found']);
    }

    const pluginRootPath = resolvePluginRootPath(artifact);
    const assetPath = validation.artifact.assetPath;
    if (!pluginRootPath || !assetPath) {
        return artifactBytesError('artifact_unavailable', ['react_native_artifact_path_invalid']);
    }

    const entry = await readVerifiedReactNativeArtifactFile({
        pluginRootPath,
        relativePath: assetPath,
        digest: validation.artifact.integrity.digest,
        pluginId: params.identity.pluginId,
        contributionId: params.identity.contributionId,
    });
    if (!entry.ok) {
        return entry.response;
    }

    const files: Array<Readonly<{
        relativePath: string;
        digest: string;
        byteSize: number;
        bytesBase64: string;
    }>> = [];
    for (const file of validation.artifact.files ?? []) {
        const served = await readVerifiedReactNativeArtifactFile({
            pluginRootPath,
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
        });
        if (!served.ok) {
            return served.response;
        }
        files.push(Object.freeze({
            relativePath: file.relativePath,
            digest: served.digest,
            byteSize: served.byteSize,
            bytesBase64: Buffer.from(served.bytes).toString('base64'),
        }));
    }

    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: true,
        cacheIdentity: validation.cacheIdentity,
        artifact: {
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            artifactKind: 'reactNativeBundle',
            digest: entry.digest,
            format: 'plainJs',
            byteSize: entry.byteSize,
        },
        bytesBase64: Buffer.from(entry.bytes).toString('base64'),
        ...(files.length > 0 ? { files } : {}),
    });
}

async function recordReactNativeCrashReportFromProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    raw: unknown,
): Promise<DaemonPluginReactNativeCrashReportResponseV1> {
    const request = DaemonPluginReactNativeCrashReportRequestV1Schema.safeParse(raw);
    if (!request.success) {
        return reactNativeCrashReportError('invalid_request', ['react_native_crash_report_request_invalid']);
    }

    const lease = await acquireProjectionRuntimeRegistryLease(opts);
    try {
        const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
        const baseHostRuntime = await resolveProjectionHostRuntime(opts);
        const report = request.data.report;
        const projected = readProjectedReactNativeExecutableIdentity({
            registry: lease.registry.contributes,
            generation,
            identity: report.cacheIdentity,
            pluginUiHostRuntime: baseHostRuntime,
        });
        if (
            report.cacheIdentity.projectionGeneration !== generation
            || !projected
            || !reactNativeIdentityMatches(projected.cacheIdentity, report.cacheIdentity)
        ) {
            return reactNativeCrashReportError(
                'projection_identity_mismatch',
                ['react_native_crash_report_projection_identity_mismatch'],
            );
        }

        const contributionKey = createReactNativeCrashDisableContributionKey({
            pluginId: report.cacheIdentity.pluginId,
            contributionId: report.cacheIdentity.contributionId,
        });
        try {
            await recordReactNativeCrashDisableReport({
                store: createReactNativeCrashDisableStateStore({ happyHomeDir: configuration.happyHomeDir }),
                pluginId: report.cacheIdentity.pluginId,
                contributionId: report.cacheIdentity.contributionId,
                cacheKey: projected.cacheKey,
                artifactDigest: report.cacheIdentity.artifactDigest,
                disabledReason: report.disabledReason,
                crashCount: report.crashCount,
                startupFailureCount: report.startupFailureCount,
                observedAtMs: report.observedAtMs,
            });
        } catch {
            return reactNativeCrashReportError('state_write_failed', ['react_native_crash_report_state_write_failed']);
        }

        invalidateDaemonContributionRegistryProjectionCache();
        return reactNativeCrashReportResponse({
            protocolVersion: 1,
            ok: true,
            contributionKey,
            disabled: true,
        });
    } finally {
        await lease.release();
    }
}

export function registerDaemonContributionRegistryProjectionHandler(
    rpc: RpcHandlerRegistrar,
    opts?: DaemonContributionRegistryProjectionRegistrationOptions,
): void {
    rpc.registerHandler(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async (raw: unknown) => {
        // Parse input for forward compatibility and to avoid accepting accidental session-scoped payloads.
        const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(raw);
        return await resolveProjection(opts, request);
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET, async (raw: unknown) => {
        const request = DaemonPluginSettingsGetRequestSchema.parse(raw);
        return await withPluginSettingsService(opts, request.pluginId, request.machineId, async ({
            service,
            secrets,
            fields,
            storageScope,
        }) =>
            await readPluginSettingsSnapshot({
                pluginId: request.pluginId,
                service,
                secrets,
                fields,
                storageScope,
            }));
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET, async (raw: unknown) => {
        const request = DaemonPluginSettingsSetRequestSchema.parse(raw);
        return await withPluginSettingsService(opts, request.pluginId, request.machineId, async ({
            service,
            secrets,
            fields,
            storageScope,
        }) => {
            const field = fields.find((candidate) => candidate.id === request.fieldId);
            if (!field) {
                throw new PluginContextServiceError(
                    'PLUGIN_SETTINGS_UNKNOWN_KEY',
                    `Plugin setting '${request.fieldId}' is not declared in the manifest`,
                );
            }
            if (field.secret === true) {
                if (request.expectedRevision !== undefined) {
                    throw new PluginContextServiceError(
                        'PLUGIN_SETTINGS_SECRET_CAS_UNAVAILABLE',
                        `Plugin setting '${request.fieldId}' uses the secrets revision owner`,
                    );
                }
                if (typeof request.value !== 'string') {
                    throw new PluginContextServiceError(
                        'PLUGIN_SETTINGS_VALIDATION_FAILED',
                        `Plugin setting '${request.fieldId}' failed schema validation`,
                    );
                }
                if (request.value === '') {
                    await secrets.delete(request.fieldId);
                } else {
                    assertPluginSettingFieldValue({
                        pluginId: request.pluginId,
                        field,
                        value: request.value,
                    });
                    await secrets.set(request.fieldId, request.value);
                }
            } else {
                assertPluginSettingFieldValue({
                    pluginId: request.pluginId,
                    field,
                    value: request.value,
                });
                await service.set(request.fieldId, request.value as JsonValue, {
                    ...(request.expectedRevision === undefined
                        ? {}
                        : { expectedRevision: request.expectedRevision }),
                });
            }
            return DaemonPluginSettingsSetResponseSchema.parse(await readPluginSettingsSnapshot({
                pluginId: request.pluginId,
                service,
                secrets,
                fields,
                storageScope,
            }));
        });
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE, async (raw: unknown) => {
        const request = DaemonPluginStructuredMessageResolveRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginStructuredMessageResolveResponseSchema.parse({
                ok: false,
                code: 'plugin_structured_message_request_invalid',
                reason: 'invalid_payload',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const projectionGeneration = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
            if (String(projectionGeneration) !== request.data.expectedGeneration) {
                return DaemonPluginStructuredMessageResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_structured_message_generation_retired',
                    reason: 'stale_generation',
                });
            }
            if (!lease.registry.resolveStructuredMessage) {
                return DaemonPluginStructuredMessageResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_structured_message_unavailable',
                    reason: 'unavailable',
                });
            }
            if (typeof lease.registry.generation !== 'number') {
                return DaemonPluginStructuredMessageResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_structured_message_unavailable',
                    reason: 'unavailable',
                });
            }
            const resolution = await lease.registry.resolveStructuredMessage({
                expectedGeneration: String(lease.registry.generation),
                kind: request.data.kind,
                payload: request.data.payload,
                ...(request.data.resourceRefs ? { resourceRefs: request.data.resourceRefs } : {}),
                facts: request.data.facts,
            });
            const projectedResolution = projectStructuredMessageResolutionGeneration(
                resolution,
                String(projectionGeneration),
            );
            return DaemonPluginStructuredMessageResolveResponseSchema.parse({
                ok: true,
                model: projectedResolution.model,
                renderer: projectedResolution.renderer,
                resources: projectedResolution.resources.map(({ bytes, ...resource }) => ({
                    ...resource,
                    bytesBase64: Buffer.from(bytes).toString('base64'),
                })),
            });
        } catch (error) {
            const code = error instanceof PluginError ? error.code : 'plugin_structured_message_unavailable';
            const reason = code === 'plugin_structured_message_payload_invalid'
                || code === 'plugin_structured_message_value_invalid'
                ? 'invalid_payload'
                : code === 'plugin_structured_message_generation_retired' || code === 'plugin_generation_stale'
                    ? 'stale_generation'
                    : code === 'plugin_structured_message_unknown_kind'
                        ? 'unknown_kind'
                        : 'unavailable';
            return DaemonPluginStructuredMessageResolveResponseSchema.parse({ ok: false, code, reason });
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, async (raw: unknown, context) => {
        const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                ok: false,
                code: 'plugin_structured_message_action_request_invalid',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const projectionGeneration = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
            if (String(projectionGeneration) !== request.data.expectedGeneration) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                });
            }
            const attempt = await executePluginActionIfAvailable({
                runtimeRegistry: lease.registry,
                actionId: request.data.qualifiedActionId,
                input: request.data.input,
                context: {
                    surface: request.data.executionSurface ?? 'agent',
                    ...(request.data.sessionId ? { defaultSessionId: request.data.sessionId } : {}),
                    ...(context?.signal ? { signal: context.signal } : {}),
                },
            });
            if (!attempt.matched) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_unavailable',
                });
            }
            return attempt.result.ok
                ? DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: true,
                    result: attempt.result.result,
                })
                : DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: attempt.result.errorCode,
                });
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ, async (raw: unknown) => {
        const request = DaemonPluginUiArtifactBytesReadRequestSchema.safeParse(raw);
        if (!request.success) {
            return artifactBytesError('invalid_request', ['plugin_ui_artifact_bytes_request_invalid']);
        }

        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
            const pluginUiHostRuntime = await resolveProjectionHostRuntimeWithCrashDisableState(opts, {
                registry: lease.registry.contributes,
                generation,
                ...(request.data.reactNativeHostRuntimeIdentity
                    ? { reactNativeHostRuntimeIdentity: request.data.reactNativeHostRuntimeIdentity }
                    : {}),
                ...(request.data.reactNativeWebLoaderCapability
                    ? { reactNativeWebLoaderCapability: request.data.reactNativeWebLoaderCapability }
                    : {}),
            });
            return await readReactNativeArtifactBytesByCacheIdentity({
                registry: lease.registry.contributes,
                identity: request.data.cacheIdentity,
                generation,
                pluginUiHostRuntime,
            });
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT, async (raw: unknown) =>
        await recordReactNativeCrashReportFromProjection(opts, raw));
}
