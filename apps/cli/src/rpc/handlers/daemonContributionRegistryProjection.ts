import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginUiTargetedSurfaceMountV1Schema,
    DaemonPluginSettingsGetRequestSchema,
    DaemonPluginSettingsGetResponseSchema,
    DaemonPluginSettingsSetRequestSchema,
    DaemonPluginSettingsSetResponseSchema,
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS,
    DaemonPluginSecretStatusRequestSchema,
    DaemonPluginSecretStatusResponseSchema,
    DaemonPluginSecretSetRequestSchema,
    DaemonPluginSecretSetResponseSchema,
    DaemonPluginSecretDeleteRequestSchema,
    DaemonPluginSecretDeleteResponseSchema,
    DaemonPluginUiResourceReadRequestSchema,
    DaemonPluginUiResourceReadResponseSchema,
    DaemonPluginUiResourceWatchOpenRequestSchema,
    DaemonPluginUiResourceWatchOpenResponseSchema,
    DaemonPluginUiResourceWatchNextRequestSchema,
    DaemonPluginUiResourceWatchNextResponseSchema,
    DaemonPluginUiResourceWatchCloseRequestSchema,
    DaemonPluginUiResourceWatchCloseResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema,
    DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema,
    DaemonPluginComposerReferenceSearchRequestSchema,
    DaemonPluginComposerReferenceSearchResponseSchema,
    type DaemonPluginSettingsSnapshot,
    DaemonPluginUiArtifactBytesReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema,
    DaemonPluginReactNativeCrashReportRequestV1Schema,
    DaemonPluginReactNativeCrashReportResponseV1Schema,
    DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    DaemonPluginHostedWebArtifactCacheIdentityV1Schema,
    isSameDaemonPluginReactNativeBundleCacheIdentityV1,
    isSameDaemonPluginHostedWebArtifactCacheIdentityV1,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type FeatureDecision,
    type DaemonHostedWebFrameCapabilityV1,
    type DaemonReactNativeHostRuntimeIdentityV1,
    type DaemonReactNativeWebLoaderCapabilityV1,
    type DaemonPluginReactNativeBundleCacheIdentityV1,
    type DaemonPluginHostedWebArtifactCacheIdentityV1,
    type ActionOperationDeclarationV1,
    type DaemonContributionRegistryProjectionDescribeRequest,
    type DaemonContributionRegistryProjectionDescribeResponse,
    type PluginSettingFieldV2,
    type DaemonPluginUiArtifactBytesReadResponse,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashReportResponseV1,
    type DaemonPluginUiTargetedSurfaceMountV1,
    type DaemonPluginStructuredMessageActionInvocationV1,
    type MessageActionReferenceV1,
    type MessageActionResolutionV1,
    PluginMachineExecutionOriginV1Schema,
    arePluginMachineMaterializationRefsEqual,
    PluginUiResourceBindingCapabilityV1Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionBrandAssetV2,
    type PluginProjectionV2,
    type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
    buildQualifiedPluginContributionKey,
    readPluginSettingSecretCustody,
    readPluginActionFailureAuthorPayload,
} from '@happier-dev/protocol';
import {
    isPluginError,
    PluginError,
    type JsonValue,
    type PluginInvocationCaller,
} from '@happier-dev/plugin-sdk';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import {
    computePluginUiArtifactSha256DigestV1,
    PluginUiSurfaceBindingV1Schema,
    isPluginUiHermesBytecodeArtifactV1,
    PluginUiTargetedContributionsV1Schema,
    selectPluginUiRendererChainMemberV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactsManifestEntryV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    DaemonPluginSettingsWatchRequestSchema,
    DaemonPluginSettingsWatchResponseSchema,
    RPC_METHODS,
    type DaemonPluginSettingsWatchResponse,
} from '@happier-dev/protocol/rpc';

import {
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import type {
    TargetActionCurrentIntentRequest,
    TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type {
    AdmittedTargetedContributionSnapshot,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import {
    listComposerSurfaceDeclarations,
    projectDaemonEmbeddedPluginUiRenderer,
    readCurrentAutomationEventSetupReactNativeCrashStateBindings,
    projectDaemonComposerSurfaceCatalog,
    readCurrentComposerReactNativeCrashStateBindings,
} from '@/plugins/projection/registry/composer';
import { adaptTargetActivationFacts } from '@/plugins/projection/introspection/targetActivationFacts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import {
    resolvePluginUiProjectionHostRuntime,
} from '@/plugins/projection/registry/ui/hostRuntime';
import {
    projectPluginUiRendererAvailability,
    projectPluginUiRendererCrashState,
    projectPluginUiRendererRef,
    resolvePluginUiRendererProjectionEntry,
} from '@/plugins/projection/registry/ui/projection';
import {
    findGeneratedHostedWebArtifactEntry,
    findResolvedGeneratedHostedWebArtifactOwner,
    findGeneratedReactNativeArtifactEntry,
    findGeneratedReactNativeCollectionMigrationsModule,
    findResolvedGeneratedReactNativeClientContributionArtifactOwner,
    findResolvedGeneratedReactNativeArtifactOwner,
    type ResolvedGeneratedHostedWebArtifactOwner,
    type ResolvedGeneratedReactNativeClientContributionArtifactOwner,
    type ResolvedGeneratedReactNativeArtifactOwner,
} from '@/plugins/projection/registry/ui/generatedUiArtifactOwners';
import { resolveDeclarativeProjectionModels } from '@/plugins/projection/registry/ui/declarativeModels';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { logger } from '@/ui/logger';
import type {
    ReactNativeHostRuntimeReadinessIdentity,
} from '@/plugins/projection/registry/ui/hostRuntime';
import {
    createReactNativeCrashStateBindingKey,
    createReactNativeCrashStateStore,
    reconcileReactNativeCrashStateBindings,
    recordReactNativeCrashFailure,
    resetReactNativeCrashState,
    type ReactNativeCrashStateBinding,
    type ReactNativeCrashStateProjection,
} from '@/plugins/runtime/ui/reactNativeCrashDisableState';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import {
    assertPluginSettingFieldValue,
} from '@/plugins/runtime/context/settings';
import { PluginContextServiceError } from '@/plugins/runtime/context/errors';
import type { DeclaredDaemonPluginSecretAdministrationPort } from '@/plugins/runtime/context/secrets';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import {
    assertLocalSettingsDeclarationsAccessible,
    flattenLocalSettingsFields,
    resolveLocalSettingsDeclarations,
} from '@/plugins/settings/localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import { activateScmRuntimeContributionsOnDemand } from '@/scm/scmBackendCatalog';
import {
    resolveRegistryConnectedAccountActionFormPurposeAuthorization,
} from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type {
    DaemonConnectedAccountPurposeBindingRuntime,
} from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import {
    registerDaemonPluginCollectionCandidatePreparationHandler,
} from './daemonPluginCollectionCandidatePreparation';

export type DaemonContributionRegistryProjectionRegistrationOptions = Readonly<{
    resolveRegistry?: () => Promise<ResolvedContributionRegistry>;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    resolveInstalledPackages?: () => Promise<readonly PluginCatalogEntry[]>;
    resolveGeneration?: () => Promise<number>;
    /** Genuine filesystem boundary used by focused Artifact-read race tests. */
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
    resolveHostedWebFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveReactNativeBundlesFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveReactNativeDevHotReloadFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    /**
     * The connected machine supplies only its live server/machine identity.
     * This handler combines it with the materialization ID captured by the
     * same registry lease; it never infers either fact from a path or catalog.
     */
    resolvePluginProjectionExecutionOriginContext?: () => Promise<Readonly<{
        serverIdentityId: string;
        machineId: string;
    }> | null> | Readonly<{
        serverIdentityId: string;
        machineId: string;
    }> | null;
    /**
     * Machine-owned resolver for the opaque whole-message reference. The
     * handler receives no content reader and cannot create a second Message
     * authority; unavailable/currentness outcomes fail closed before dispatch.
     */
    resolveMessageActionReference?: (params: Readonly<{
        reference: MessageActionReferenceV1;
        signal?: AbortSignal;
    }>) => Promise<MessageActionResolutionV1>;
    /** Existing host-owned approval presenter for target actions. */
    requestCurrentIntent?: (
        request: TargetActionCurrentIntentRequest,
    ) => Promise<TargetActionCurrentIntentResult>;
    // G-RC4: the SAME async server-features provider shape as the inventory/quotas/browser gates.
    // Threaded so the four plugin-UI-tier fallback decisions resolve against the live server
    // snapshot — a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the
    // projection (master §3.5 "server disables X → daemon refuses").
    resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
    processEnv?: NodeJS.ProcessEnv;
    installedReactNativeArtifactLoaderAvailable?: boolean;
    reactNativeScriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
    observePluginExecution?: (request: Readonly<{
        actionId: string;
        title: string;
        operation: ActionOperationDeclarationV1;
        input: unknown;
        requestId?: string;
        sessionId?: string;
        execute: (context: Readonly<{
            signal: AbortSignal;
            operationProgress: Readonly<{ update(progress: Readonly<{
                label?: string; phase?: string; current?: number; total?: number;
            }>): void }>;
        }>) => Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    }>) => Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    /** Current daemon-owned Connected Account purpose runtime for form choices. */
    resolveConnectedAccountPurposeBindingRuntime?: () => Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'listActionFormConnectedAccountOptions'
    > | null;
}>;

let cachedProjection: DaemonContributionRegistryProjectionDescribeResponse | null = null;
let cachedAtMs = 0;
let cachedProjectionKey: string | null = null;
const CACHE_TTL_MS = 10_000;

/**
 * Projections in flight right now, keyed by the describe request they answer.
 *
 * The TTL cache above can only serve a caller that arrives *after* a projection finished, so it
 * is silent in the one regime that matters: several callers arriving while a projection is still
 * running. Each of those used to run its own full projection — the amplification measured as
 * 137,870 ms of concurrent work, 22 s event-loop stalls and 100 % CPU on a single daemon. An
 * entry lives only for the duration of one computation and is removed when it settles, so this
 * shares work without becoming a second cache with its own freshness rules.
 */
const inFlightProjectionsByRequestKey =
    new Map<string, Promise<DaemonContributionRegistryProjectionDescribeResponse>>();

export function invalidateDaemonContributionRegistryProjectionCache(): void {
    cachedProjection = null;
    cachedAtMs = 0;
    cachedProjectionKey = null;
}

/**
 * Identifies the answer a describe request asks for. The request is the parsed schema output, so
 * declared fields serialize in schema order and identical requests produce identical keys. The
 * schema is `.passthrough()`, so two callers could in principle order unknown forward-compatible
 * fields differently; that only costs a missed share, never a shared answer to different
 * questions, which is the direction this must fail in.
 */
function createProjectionRequestKey(
    request: DaemonContributionRegistryProjectionDescribeRequest | undefined,
): string {
    return request === undefined ? '' : JSON.stringify(request);
}

async function resolveProjectionCoalescingConcurrentRequests(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    request?: DaemonContributionRegistryProjectionDescribeRequest,
): Promise<DaemonContributionRegistryProjectionDescribeResponse> {
    const requestKey = createProjectionRequestKey(request);
    const alreadyRunning = inFlightProjectionsByRequestKey.get(requestKey);
    if (alreadyRunning) {
        return await alreadyRunning;
    }

    // A rejected projection is removed like any other, so a failure is never latched onto the
    // callers that arrive after it: the next request starts a fresh computation.
    const tracked = resolveProjection(opts, request).finally(() => {
        if (inFlightProjectionsByRequestKey.get(requestKey) === tracked) {
            inFlightProjectionsByRequestKey.delete(requestKey);
        }
    });
    inFlightProjectionsByRequestKey.set(requestKey, tracked);
    return await tracked;
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

async function isExpectedProjectionGenerationCurrent(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    expectedGeneration: string,
): Promise<boolean> {
    const projectionGeneration = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
    return String(projectionGeneration) === expectedGeneration;
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

function createProjectionCacheKey(input: Readonly<{
    generation: number;
    registryCacheToken: string;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    brandAssetsByPluginId: Readonly<Record<string, PluginProjectionBrandAssetV2>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
    mountedTarget?: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    /**
     * The projected translation bundles depend on it, so two clients with
     * different display locales must not share one cached body.
     */
    requestedLocale?: string;
}>): string {
    return JSON.stringify({
        generation: input.generation,
        registryCacheToken: input.registryCacheToken,
        pluginUiHostRuntime: input.pluginUiHostRuntime,
        brandAssetsByPluginId: input.brandAssetsByPluginId,
        pluginExecutionOriginsByPluginId: input.pluginExecutionOriginsByPluginId,
        pluginFinalPolicyCurrentGenerations: input.pluginFinalPolicyCurrentGenerationsById
            ? [...input.pluginFinalPolicyCurrentGenerationsById.entries()].sort(([left], [right]) => left.localeCompare(right))
            : [],
        mountedTarget: input.mountedTarget ?? null,
        requestedLocale: input.requestedLocale ?? null,
    });
}

type MountedTargetedContributionSnapshot = Readonly<{
    point: Readonly<{
        pointId: string;
        protocol: Readonly<{ id: string; version: number }>;
    }>;
    snapshot: AdmittedTargetedContributionSnapshot;
}>;

/**
 * The one cold-admission read for a mounted target. Its callers project public
 * handles and private mounts from these same immutable snapshot objects; this
 * is deliberately not another manifest scan, registry, or activation path.
 */
function readMountedTargetedContributionSnapshots(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; immutableGenerationId: string }>;
}>): readonly MountedTargetedContributionSnapshot[] {
    const currentImmutableGenerationId = input.runtimeRegistry
        .contributes.immutableGenerationIdsByPluginId?.[input.mountedTarget.pluginId];
    if (currentImmutableGenerationId !== input.mountedTarget.immutableGenerationId) {
        throw new PluginError({
            code: 'plugin_targeted_contributions_target_stale',
            message: 'Mounted target immutable generation is no longer current',
        });
    }
    const points = [...(input.runtimeRegistry.contributes.pluginContributionPoints ?? [])]
        .filter((candidate) => candidate.pluginId === input.mountedTarget.pluginId)
        .sort((left, right) => left.definition.id.localeCompare(right.definition.id));
    // A current contributor with no declared target points has one truthful,
    // empty target snapshot. It needs no runtime reader and must not be treated
    // as unavailable merely because there is nothing to admit.
    if (points.length === 0) return Object.freeze([]);
    const readAdmitted = input.runtimeRegistry.readAdmittedTargetedContributions;
    if (!readAdmitted) {
        throw new PluginError({
            code: 'plugin_targeted_contributions_unavailable',
            message: 'Targeted contribution admission is unavailable in the current runtime registry',
        });
    }
    const snapshots: MountedTargetedContributionSnapshot[] = [];
    for (const point of points) {
        for (const protocol of [...point.definition.protocols]
            .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)) {
            const snapshot = readAdmitted({
                targetPluginId: input.mountedTarget.pluginId,
                pointId: point.definition.id,
                protocol: { id: protocol.id, version: protocol.version },
            });
            if (!snapshot) {
                throw new PluginError({
                    code: 'plugin_targeted_contributions_unavailable',
                    message: 'Targeted contribution point is not admitted in the current runtime registry',
                });
            }
            if (
                snapshot.target.pluginId !== input.mountedTarget.pluginId
                || snapshot.target.pointId !== point.definition.id
                || snapshot.target.immutableGenerationId !== input.mountedTarget.immutableGenerationId
            ) {
                throw new PluginError({
                    code: 'plugin_targeted_contributions_target_stale',
                    message: 'Targeted contribution snapshot does not match the mounted target',
                });
            }
            snapshots.push(Object.freeze({
                point: Object.freeze({
                    pointId: point.definition.id,
                    protocol: Object.freeze({ id: protocol.id, version: protocol.version }),
                }),
                snapshot,
            }));
        }
    }
    return Object.freeze(snapshots);
}

function projectMountedTargetedContributionSnapshots(input: Readonly<{
    mountedTarget: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
}>): PluginUiTargetedContributionsV1 {
    const pointsById = new Map<string, MountedTargetedContributionSnapshot[]>();
    for (const snapshot of input.snapshots) {
        const existing = pointsById.get(snapshot.point.pointId);
        if (existing) existing.push(snapshot);
        else pointsById.set(snapshot.point.pointId, [snapshot]);
    }
    const points = [...pointsById.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pointId, snapshots]) => Object.freeze({
            pointId,
            protocols: Object.freeze(snapshots.map(({ point, snapshot }) => Object.freeze({
                protocol: Object.freeze({ ...point.protocol }),
                contributions: Object.freeze(snapshot.contributions.map((contribution) => Object.freeze({
                    contributor: Object.freeze({ ...contribution.contributor }),
                    protocol: Object.freeze({ ...contribution.protocol }),
                    ...(contribution.descriptor === undefined
                        ? {}
                        : { descriptor: contribution.descriptor }),
                    operations: Object.freeze(contribution.operations.map((operation) => Object.freeze({
                        point: Object.freeze({
                            pointId: point.pointId,
                            protocol: Object.freeze({ ...point.protocol }),
                        }),
                        contributor: Object.freeze({ ...contribution.contributor }),
                        role: operation.role,
                        action: Object.freeze({ ...operation.action }),
                    }))),
                    surfaces: Object.freeze(contribution.surfaces.map((surface) => Object.freeze({
                        point: Object.freeze({
                            pointId: point.pointId,
                            protocol: Object.freeze({ ...point.protocol }),
                        }),
                        contributor: Object.freeze({ ...surface.contributor }),
                        role: surface.role,
                        presentation: surface.presentation,
                    }))),
                }))),
            }))),
        }));
    return PluginUiTargetedContributionsV1Schema.parse({
        target: input.mountedTarget,
        points,
    });
}

/**
 * The one current target-local inventory accepted by the Protocol declarative
 * normalizer. It is derived from the exact cold-admitted snapshots used for
 * this response, so a static target document cannot borrow a global catalog,
 * contributor candidate, or a different immutable generation.
 */
function readMountedPreparedTargetedSurfaceInventories(input: Readonly<{
    mountedTarget: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
}>): Readonly<Record<string, readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[]>> {
    const surfaces: PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[] = [];
    for (const { point, snapshot } of input.snapshots) {
        for (const contribution of snapshot.contributions) {
            for (const surface of contribution.surfaces) {
                surfaces.push(Object.freeze({
                    targetPluginId: input.mountedTarget.pluginId,
                    handle: Object.freeze({
                        point: Object.freeze({
                            pointId: point.pointId,
                            protocol: Object.freeze({ ...point.protocol }),
                        }),
                        contributor: Object.freeze({ ...surface.contributor }),
                        role: surface.role,
                        presentation: surface.presentation,
                    }),
                    inputSchema: surface.inputSchema,
                    inputValidation: surface.inputValidation,
                    inputNormalizer: surface.targetProtocol.inputSchema,
                }));
            }
        }
    }
    return Object.freeze({
        [input.mountedTarget.pluginId]: Object.freeze(surfaces),
    });
}

/**
 * Projects only the runtime registry's already-admitted target snapshots. The
 * request is fenced to the exact mounted immutable generation; declarations
 * supply the bounded point/protocol inventory, while the canonical reader
 * supplies every contribution and never activates a plugin.
 */
function readMountedTargetedContributionsProjection(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    snapshots?: readonly MountedTargetedContributionSnapshot[];
}>): PluginUiTargetedContributionsV1 {
    return projectMountedTargetedContributionSnapshots({
        mountedTarget: input.mountedTarget,
        snapshots: input.snapshots ?? readMountedTargetedContributionSnapshots(input),
    });
}

function readTargetedSurfaceResourceCapability(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string,
) {
    try {
        const parsed = PluginUiResourceBindingCapabilityV1Schema.safeParse(
            runtimeRegistry.getPluginUiResourceCapability?.(pluginId),
        );
        return parsed.success
            ? Object.freeze({ ...parsed.data })
            : Object.freeze({ readable: false, dynamic: false });
    } catch {
        return Object.freeze({ readable: false, dynamic: false });
    }
}

/**
 * Projects only selected private mount facts from the already-admitted target
 * snapshots and the same broad projection response. The consumer receives the
 * producer-selected renderer, never a second renderer lookup or fallback
 * decision path.
 */
function readMountedTargetedSurfaceMountsProjection(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
    projection: ReturnType<typeof buildPluginProjectionV2>;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    modelsByRendererKey: Readonly<Record<string, import('@/plugins/runtime/invocation/services/declarativeModel').StablePluginDeclarativeModel | undefined>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
}>): readonly DaemonPluginUiTargetedSurfaceMountV1[] {
    const entriesById = input.projection.familiesById.pluginUi?.entriesById ?? {};
    const mounts: DaemonPluginUiTargetedSurfaceMountV1[] = [];
    for (const { point, snapshot } of input.snapshots) {
        for (const contribution of snapshot.contributions) {
            const executionOrigin = input.pluginExecutionOriginsByPluginId[contribution.contributor.pluginId];
            if (!executionOrigin) continue;
            const contributorTargetedContributions = readMountedTargetedContributionsProjection({
                runtimeRegistry: input.runtimeRegistry,
                mountedTarget: {
                    pluginId: contribution.contributor.pluginId,
                    immutableGenerationId: contribution.contributor.immutableGenerationId,
                },
            });
            for (const surface of contribution.surfaces) {
                const mount = Object.freeze({
                    kind: 'targetedSurface' as const,
                    target: Object.freeze({ ...input.mountedTarget }),
                    point: Object.freeze({
                        pointId: point.pointId,
                        protocol: Object.freeze({ ...point.protocol }),
                    }),
                    contributor: Object.freeze({ ...surface.contributor }),
                    role: surface.role,
                    presentation: surface.presentation,
                });
                const candidates = surface.rendererChain.map((renderer) => {
                    const declarativeModel = renderer.definition.kind === 'declarative'
                        ? input.modelsByRendererKey[`${renderer.pluginId}\0${renderer.definition.id}`]
                        : undefined;
                    const rendererProjection = projectPluginUiRendererRef(renderer, declarativeModel);
                    const availability = projectPluginUiRendererAvailability({
                        pluginId: contribution.contributor.pluginId,
                        renderer,
                        declarativeModel,
                        registryRendererRef: rendererProjection.registryRendererRef,
                        entriesById,
                    });
                    const crashStateProjection = projectPluginUiRendererCrashState({
                        mount,
                        renderer,
                        availability,
                        hostRuntime: input.pluginUiHostRuntime,
                    });
                    const artifactProjection = resolvePluginUiRendererProjectionEntry({
                        pluginId: contribution.contributor.pluginId,
                        renderer: rendererProjection.registryRendererRef,
                        entriesById,
                    });
                    return Object.freeze({
                        renderer,
                        rendererRef: rendererProjection.rendererRef,
                        availability: crashStateProjection.availability,
                        ...(artifactProjection ? { artifactProjection } : {}),
                        ...(crashStateProjection.crashState
                            ? { crashState: crashStateProjection.crashState }
                            : {}),
                    });
                });
                const selectedIdentity = selectPluginUiRendererChainMemberV1(
                    surface.rendererChain.map((renderer) => renderer.identity),
                    candidates
                        .filter((candidate) => candidate.availability.state === 'available')
                        .map((candidate) => candidate.renderer.definition.id),
                ) ?? surface.rendererChain[0]?.identity;
                const selectedCandidate = selectedIdentity
                    ? candidates.find((candidate) => (
                        candidate.renderer.identity.pluginId === selectedIdentity.pluginId
                        && candidate.renderer.identity.localId === selectedIdentity.localId
                    ))
                    : undefined;
                if (!selectedCandidate) {
                    throw new PluginError({
                        code: 'plugin_targeted_surface_mount_unavailable',
                        message: 'Targeted Surface renderer selection is unavailable',
                    });
                }
                const parsed = DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
                    ...mount,
                    inputSchema: surface.inputSchema,
                    rendererChain: surface.rendererChain.map((renderer) => renderer.identity),
                    selectedRenderer: {
                        identity: selectedCandidate.renderer.identity,
                        renderer: selectedCandidate.rendererRef,
                        availability: selectedCandidate.availability,
                        ...(selectedCandidate.artifactProjection
                            ? { artifactProjection: selectedCandidate.artifactProjection }
                            : {}),
                        ...(selectedCandidate.crashState
                            ? { crashState: selectedCandidate.crashState }
                            : {}),
                    },
                    executionOrigin,
                    resourceCapability: readTargetedSurfaceResourceCapability(
                        input.runtimeRegistry,
                        contribution.contributor.pluginId,
                    ),
                    contributorTargetedContributions,
                });
                if (!parsed.success) {
                    throw new PluginError({
                        code: 'plugin_targeted_surface_mount_unavailable',
                        message: 'Targeted Surface mount facts are unavailable',
                    });
                }
                mounts.push(parsed.data);
            }
        }
    }
    return Object.freeze(mounts);
}

async function resolvePluginExecutionOriginsForProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    registry: ResolvedContributionRegistry,
): Promise<Readonly<Record<string, PluginMachineExecutionOriginV1>>> {
    let context: Readonly<{ serverIdentityId: string; machineId: string }> | null = null;
    try {
        context = await opts?.resolvePluginProjectionExecutionOriginContext?.() ?? null;
    } catch {
        // The context is external/currentness data. A failure must remove the
        // stamp, not manufacture a local or coarse-machine substitute.
        return Object.freeze({});
    }
    if (!context) return Object.freeze({});

    const originsByPluginId: Record<string, PluginMachineExecutionOriginV1> = {};
    for (const [pluginId, materializationId] of Object.entries(registry.materializationIdsByPluginId ?? {})) {
        const parsed = PluginMachineExecutionOriginV1Schema.safeParse({
            serverIdentityId: context.serverIdentityId,
            materializationRef: {
                machineId: context.machineId,
                materializationId,
                pluginId,
            },
        });
        if (parsed.success) originsByPluginId[pluginId] = parsed.data;
    }
    return Object.freeze(originsByPluginId);
}

/**
 * Convert a mounted UI binding into invocation provenance only after the
 * daemon has matched every component against its current runtime lease. The
 * wire record is a claim from the client, not caller authority.
 */
async function deriveMountedPluginInvocationCaller(input: Readonly<{
    request: Readonly<{
        machineId: string;
        invocationSurface: 'cli' | 'ui' | 'voice';
        invocation?: DaemonPluginStructuredMessageActionInvocationV1;
    }>;
    registry: ResolvedExecutablePluginRuntimeRegistry;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    options: DaemonContributionRegistryProjectionRegistrationOptions | undefined;
}>): Promise<
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{
        status: 'available';
        caller: Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
        /** Re-read live machine identity immediately before target effect. */
        isMountedCallerCurrent: () => Promise<boolean>;
    }>
> {
    const binding = input.request.invocation?.kind === 'mountedPluginSurface'
        ? input.request.invocation.mountedBinding
        : undefined;
    if (!binding) return Object.freeze({ status: 'absent' as const });
    const contributes = input.registry.contributes;

    let machineContext: Readonly<{ serverIdentityId: string; machineId: string }> | null = null;
    try {
        machineContext = await input.options?.resolvePluginProjectionExecutionOriginContext?.() ?? null;
    } catch {
        return Object.freeze({ status: 'unavailable' as const });
    }
    const materialization = binding.materializationRef;
    if (
        !machineContext
        || machineContext.machineId !== input.request.machineId
        || materialization.machineId !== machineContext.machineId
        || contributes.materializationIdsByPluginId?.[materialization.pluginId]
            !== materialization.materializationId
    ) {
        return Object.freeze({ status: 'unavailable' as const });
    }
    const initialMachineContext = machineContext;

    const mountedContribution = [
        ...(contributes.uiViewsV2 ?? []),
        ...(contributes.uiSettingsPagesV2 ?? []),
        // Plugin manifest ingestion reserves local contribution IDs across
        // families, so this exact pluginId/localId pair is unambiguous for a
        // mounted app-shell Voice invocation too.
        ...(contributes.voiceProviders ?? []),
    ].find((entry) => (
        entry.pluginId === materialization.pluginId
        && entry.identity.pluginId === materialization.pluginId
        && entry.identity.localId === binding.contributionLocalId
    ));
    if (!mountedContribution) return Object.freeze({ status: 'unavailable' as const });

    return Object.freeze({
        status: 'available' as const,
        caller: Object.freeze({
            kind: 'plugin' as const,
            pluginId: materialization.pluginId,
            contribution: Object.freeze({
                id: mountedContribution.identity.localId,
                qualifiedId: buildQualifiedPluginContributionKey(mountedContribution.identity),
            }),
            materialization: Object.freeze({ ...materialization }),
            // Diagnostic provenance only. Target policy receives the independent
            // invocationSurface below.
            originSurface: input.request.invocationSurface,
        }),
        isMountedCallerCurrent: async (): Promise<boolean> => {
            let current: Readonly<{ serverIdentityId: string; machineId: string }> | null = null;
            try {
                current = await input.options?.resolvePluginProjectionExecutionOriginContext?.() ?? null;
            } catch {
                return false;
            }
            let liveMaterialization: typeof materialization | null = null;
            try {
                liveMaterialization = input
                    .resolveCurrentPluginMaterializationRef?.(materialization.pluginId)
                    ?? null;
            } catch {
                return false;
            }
            return current !== null
                && liveMaterialization !== null
                && current.serverIdentityId === initialMachineContext.serverIdentityId
                && current.machineId === initialMachineContext.machineId
                && current.machineId === input.request.machineId
                && current.machineId === materialization.machineId
                && arePluginMachineMaterializationRefsEqual(liveMaterialization, materialization);
        },
    });
}

/**
 * A host-presented provenance arm is meaningful only for the Action's
 * declarative semantic placement. Absence remains the existing non-Composer
 * compatibility path, so it is deliberately not inferred from this catalog.
 */
function isComposerActionPlacement(binding: string): boolean {
    return binding === 'composer.primary'
        || binding === 'composer.more'
        || binding === 'composer.slash';
}

function actionRequiresHostPresentedInvocation(
    action: Readonly<{
        definition: Readonly<{ placementBindings?: readonly string[] }>;
    }> | undefined,
): boolean {
    const bindings = action?.definition.placementBindings ?? [];
    return bindings.length > 0 && bindings.every((binding) => (
        isComposerActionPlacement(binding) || binding === 'message.menu'
    ));
}

function isHostPresentedActionInvocationAvailable(
    action: Readonly<{
        definition: Readonly<{ placementBindings?: readonly string[] }>;
    }> | undefined,
    invocation: Exclude<
        DaemonPluginStructuredMessageActionInvocationV1,
        Readonly<{ kind: 'mountedPluginSurface' }>
    >,
): boolean {
    const bindings = action?.definition.placementBindings ?? [];
    return invocation.kind === 'hostPresentedComposer'
        ? bindings.some(isComposerActionPlacement)
        : bindings.includes('message.menu');
}

/**
 * Project only immutable, display-safe facts supplied by the current Resource
 * owner. The handler never reopens a package or interprets the manifest brand
 * declaration, so it cannot become a second asset-admission authority.
 */
function readCurrentPluginBrandAssetsForProjection(input: Readonly<{
    registry: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
}>): Readonly<Record<string, PluginProjectionBrandAssetV2>> {
    const readBrandAsset = input.runtimeRegistry?.getPluginBrandAsset;
    if (!readBrandAsset) return Object.freeze({});

    const assetsByPluginId: Record<string, PluginProjectionBrandAssetV2> = {};
    const pluginIds = [...new Set(input.registry.activationTargets.map((target) => target.pluginId))]
        .sort((left, right) => left.localeCompare(right));
    for (const pluginId of pluginIds) {
        const asset = readBrandAsset(pluginId);
        if (asset !== undefined) assetsByPluginId[pluginId] = asset;
    }
    return Object.freeze(assetsByPluginId);
}

async function resolveProjectionHostRuntime(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    params?: Readonly<{
        reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
        reactNativeWebLoaderCapability?: DaemonReactNativeWebLoaderCapabilityV1;
        hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
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
        ...(params?.hostedWebFrameCapability
            ? { hostedWebFrameCapability: params.hostedWebFrameCapability }
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

/**
 * Reads the registry's own projected renderer/cache facts to derive every
 * currently executable physical surface binding. This is a projection reader, not
 * another artifact or renderer selector.
 */
function readCurrentReactNativeCrashStateBindings(params: Readonly<{
    projection: PluginProjectionV2;
}>): readonly ReactNativeCrashStateBinding[] {
    const entries = params.projection.familiesById.pluginUi?.entriesById ?? {};
    const bindingsByKey = new Map<string, ReactNativeCrashStateBinding>();
    for (const entry of Object.values(entries)) {
        const descriptor = readRecord(entry);
        if (
            !descriptor
            || (descriptor.contributionKind !== 'surfacePlacement'
                && descriptor.contributionKind !== 'settingsPage')
        ) {
            continue;
        }
        const binding = PluginUiSurfaceBindingV1Schema.safeParse(descriptor.binding);
        const renderer = readRecord(descriptor.renderer);
        const rendererId = typeof renderer?.contributionId === 'string'
            ? renderer.contributionId.trim()
            : '';
        if (!binding.success || renderer?.kind !== 'reactNative' || !rendererId) continue;

        const owner = binding.data.kind === 'destination'
            ? binding.data.destination
            : binding.data.surface;
        const rendererEntry = readRecord(entries[
            `reactNativeBundle:${owner.pluginId}:${rendererId}`
        ]);
        const rendererRuntime = readRecord(rendererEntry?.runtime);
        const cacheIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(
            rendererRuntime?.cacheIdentity,
        );
        if (
            !cacheIdentity.success
            || cacheIdentity.data.pluginId !== owner.pluginId
            || cacheIdentity.data.contributionId !== rendererId
        ) {
            continue;
        }
        const current: ReactNativeCrashStateBinding = Object.freeze({
            mount: binding.data.kind === 'destination'
                ? Object.freeze({
                    kind: 'destination' as const,
                    destination: Object.freeze({ ...binding.data.destination }),
                })
                : Object.freeze({
                    kind: 'inline' as const,
                    surface: Object.freeze({ ...binding.data.surface }),
                    role: binding.data.role,
                }),
            renderer: Object.freeze({
                pluginId: cacheIdentity.data.pluginId,
                localId: cacheIdentity.data.contributionId,
            }),
            artifactDigest: cacheIdentity.data.artifactDigest,
        });
        const key = createReactNativeCrashStateBindingKey(current);
        const previous = bindingsByKey.get(key);
        if (previous && previous.artifactDigest !== current.artifactDigest) {
            throw new Error('Projected React Native binding has conflicting current artifact digests');
        }
        bindingsByKey.set(key, current);
    }
    return Object.freeze([...bindingsByKey.values()]);
}

/**
 * Reads target-private RN bindings from the exact admitted target snapshots.
 * It reuses the broad projection's already-normalized cache identity and does
 * not select a renderer, materialize a plugin, or inspect an authored
 * manifest. The target/contributor generations in `mount` are therefore the
 * same currentness fence used by the private mount response.
 */
function readCurrentTargetedReactNativeCrashStateBindings(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
}>): readonly ReactNativeCrashStateBinding[] {
    const projection = buildPluginProjectionV2({
        registry: params.registry,
        generation: params.generation,
        installedPackages: [],
        pluginDiagnosticsByPluginId: {},
        pluginUiHostRuntime: params.pluginUiHostRuntime,
    });
    const entries = projection.familiesById.pluginUi?.entriesById ?? {};
    const bindingsByKey = new Map<string, ReactNativeCrashStateBinding>();
    for (const { point, snapshot } of params.snapshots) {
        for (const contribution of snapshot.contributions) {
            for (const surface of contribution.surfaces) {
                for (const renderer of surface.rendererChain) {
                    if (renderer.definition.kind !== 'reactNative') continue;
                    const rendererEntry = readRecord(entries[
                        `reactNativeBundle:${renderer.pluginId}:${renderer.definition.id}`
                    ]);
                    const rendererRuntime = readRecord(rendererEntry?.runtime);
                    const cacheIdentity = DaemonPluginReactNativeBundleCacheIdentityV1Schema.safeParse(
                        rendererRuntime?.cacheIdentity,
                    );
                    if (
                        !cacheIdentity.success
                        || cacheIdentity.data.pluginId !== contribution.contributor.pluginId
                        || cacheIdentity.data.contributionId !== renderer.definition.id
                        || renderer.identity.pluginId !== contribution.contributor.pluginId
                        || renderer.identity.localId !== renderer.definition.id
                    ) {
                        continue;
                    }
                    const current: ReactNativeCrashStateBinding = Object.freeze({
                        mount: Object.freeze({
                            kind: 'targetedSurface' as const,
                            target: Object.freeze({
                                pluginId: snapshot.target.pluginId,
                                immutableGenerationId: snapshot.target.immutableGenerationId,
                            }),
                            point: Object.freeze({
                                pointId: point.pointId,
                                protocol: Object.freeze({ ...point.protocol }),
                            }),
                            contributor: Object.freeze({ ...surface.contributor }),
                            role: surface.role,
                            presentation: surface.presentation,
                        }),
                        renderer: Object.freeze({
                            pluginId: cacheIdentity.data.pluginId,
                            localId: cacheIdentity.data.contributionId,
                        }),
                        artifactDigest: cacheIdentity.data.artifactDigest,
                    });
                    const key = createReactNativeCrashStateBindingKey(current);
                    const previous = bindingsByKey.get(key);
                    if (previous && previous.artifactDigest !== current.artifactDigest) {
                        throw new Error('Projected targeted React Native binding has conflicting current artifact digests');
                    }
                    bindingsByKey.set(key, current);
                }
            }
        }
    }
    return Object.freeze([...bindingsByKey.values()]);
}

function emptyReactNativeCrashStatesByBindingKey(): Readonly<Record<string, ReactNativeCrashStateProjection | undefined>> {
    return Object.freeze({});
}

async function resolveProjectionHostRuntimeWithCrashState(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    input: Readonly<{
        registry: ResolvedContributionRegistry;
        generation: number;
        reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
        reactNativeWebLoaderCapability?: DaemonReactNativeWebLoaderCapabilityV1;
        hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
        targetedSurfaceSnapshots?: readonly MountedTargetedContributionSnapshot[];
    }>,
): Promise<ReturnType<typeof resolvePluginUiProjectionHostRuntime>> {
    const baseHostRuntime = await resolveProjectionHostRuntime(opts, {
        ...(input.reactNativeHostRuntimeIdentity
            ? { reactNativeHostRuntimeIdentity: input.reactNativeHostRuntimeIdentity }
            : {}),
        ...(input.reactNativeWebLoaderCapability
            ? { reactNativeWebLoaderCapability: input.reactNativeWebLoaderCapability }
            : {}),
        ...(input.hostedWebFrameCapability
            ? { hostedWebFrameCapability: input.hostedWebFrameCapability }
            : {}),
    });
    if (!baseHostRuntime.reactNativeBundles) return baseHostRuntime;

    let crashStatesByBindingKey: Readonly<Record<string, ReactNativeCrashStateProjection | undefined>>;
    try {
        const projection = buildPluginProjectionV2({
            registry: input.registry,
            generation: input.generation,
            installedPackages: [],
            pluginDiagnosticsByPluginId: {},
            pluginUiHostRuntime: baseHostRuntime,
        });
        const bindings = [
            ...readCurrentReactNativeCrashStateBindings({
                projection,
            }),
            ...readCurrentComposerReactNativeCrashStateBindings({
                registry: input.registry,
                projection,
            }),
            ...readCurrentAutomationEventSetupReactNativeCrashStateBindings({
                registry: input.registry,
                projection,
            }),
            ...(input.targetedSurfaceSnapshots
                ? readCurrentTargetedReactNativeCrashStateBindings({
                    registry: input.registry,
                    generation: input.generation,
                    pluginUiHostRuntime: baseHostRuntime,
                    snapshots: input.targetedSurfaceSnapshots,
                })
                : []),
        ];
        crashStatesByBindingKey = (await reconcileReactNativeCrashStateBindings({
            store: createReactNativeCrashStateStore({ happyHomeDir: configuration.happyHomeDir }),
            bindings,
        })).statesByBindingKey;
    } catch {
        // A missing/corrupt durable owner must not authorize executable RN
        // bytes. Projection receives an explicitly present empty map, whose
        // exact-binding consumer fails closed.
        crashStatesByBindingKey = emptyReactNativeCrashStatesByBindingKey();
    }

    return Object.freeze({
        ...baseHostRuntime,
        reactNativeBundles: Object.freeze({
            ...baseHostRuntime.reactNativeBundles,
            crashStatesByBindingKey,
        }),
    });
}

async function acquireProjectionRuntimeRegistryLease(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    allowColdInitialization = false,
): Promise<Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    release: () => Promise<void>;
}>> {
    if (opts?.resolveRuntimeRegistry) {
        const registry = await opts.resolveRuntimeRegistry();
        return {
            registry,
            resolveCurrentPluginMaterializationRef: registry.resolveCurrentPluginMaterializationRef,
            release: async () => {},
        };
    }

    if (allowColdInitialization) {
        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        return await pluginReloadController.acquireRuntimeRegistry();
    }

    return await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir,
    });
}

async function isArtifactProjectionPairCurrent(input: Readonly<{
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined;
    registry: ResolvedExecutablePluginRuntimeRegistry;
    generation: number;
}>): Promise<boolean> {
    const currentLease = await acquireProjectionRuntimeRegistryLease(input.opts);
    try {
        const currentGeneration = await (
            input.opts?.resolveGeneration ?? defaultResolveGeneration
        )();
        // Artifact lookup reads the immutable contribution registry snapshot;
        // runtime wrappers may be re-created around that same exact snapshot.
        return currentLease.registry.contributes === input.registry.contributes
            && currentGeneration === input.generation;
    } finally {
        await currentLease.release();
    }
}

function sameConnectedAccountServiceRefs(
    left: readonly Readonly<{ pluginId: string; localId: string }>[],
    right: readonly Readonly<{ pluginId: string; localId: string }>[],
): boolean {
    if (left.length !== right.length) return false;
    const key = (entry: Readonly<{ pluginId: string; localId: string }>) => (
        `${entry.pluginId}\u0000${entry.localId}`
    );
    const leftKeys = [...left].map(key).sort();
    const rightKeys = [...right].map(key).sort();
    return leftKeys.every((entry, index) => entry === rightKeys[index]);
}

function isCurrentConnectedAccountActionFormTarget(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    action: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return registry.targetActionInvocations?.has(action.pluginId, action.localId) === true;
}

function readPluginSettingsDeclaration(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string,
    machineId: string,
    scope: DaemonPluginSettingsSnapshot['scope'],
): Readonly<{
    fields: readonly PluginSettingFieldV2[];
}> {
    const declarations = resolveLocalSettingsDeclarations({
        settings: [
            ...(registry.contributes.settings ?? []).filter((entry) => (
                entry.definition.scope === scope.kind
            )),
            ...resolveNotificationChannelSettingsContributions(
                registry.contributes.notificationChannels ?? [],
            ).filter((entry) => entry.definition.scope === scope.kind),
        ],
        pluginId,
    });
    assertLocalSettingsDeclarationsAccessible({
        declarations,
        facts: resolveInvocationContributionPolicyFacts({
            facts: { 'machine.id': machineId },
        }),
        supportedScopes: new Set([scope.kind]),
    });
    if (declarations.length === 0) {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
            `Plugin settings scope '${scope.kind}' is not declared for '${pluginId}'`,
        );
    }
    return {
        fields: flattenLocalSettingsFields(declarations),
    };
}

function isSecretSettingsField(field: PluginSettingFieldV2): boolean {
    return readPluginSettingSecretCustody(field.secret) !== null;
}

function isPluginSettingsRevisionConflict(error: unknown): boolean {
    return isPluginError(error)
        && (
            error.code === 'plugin_settings_revision_conflict'
            || error.code === 'plugin_secret_revision_conflict'
        );
}

/**
 * The UI/CLI route chooses a portable target, but the daemon remains the
 * authority that decides whether that target still names this receiver. Do
 * not reinterpret a machine id alone as an equivalent local target.
 */
async function assertCurrentDaemonPluginSettingsTarget(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    target: Readonly<{ serverIdentityId: string; machineId: string }>,
    signal: AbortSignal | undefined,
): Promise<void> {
    signal?.throwIfAborted();
    let current: Readonly<{ serverIdentityId: string; machineId: string }> | null = null;
    try {
        current = await opts?.resolvePluginProjectionExecutionOriginContext?.() ?? null;
    } catch {
        signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    if (
        !current
        || current.serverIdentityId !== target.serverIdentityId
        || current.machineId !== target.machineId
    ) {
        throw new PluginContextServiceError(
            'plugin_settings_target_not_current',
            'The requested daemon Settings target is no longer current.',
        );
    }
}

async function withPluginSettingsService<T>(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    pluginId: string,
    machineId: string,
    scope: DaemonPluginSettingsSnapshot['scope'],
    signal: AbortSignal | undefined,
    run: (params: Readonly<{
        service: ScopedSettingsService;
        secrets: SecretsService | null;
        fields: readonly PluginSettingFieldV2[];
        scope: DaemonPluginSettingsSnapshot['scope'];
    }>) => Promise<T>,
): Promise<T> {
    if (scope.kind !== 'daemon') {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
            `Exact-daemon settings RPC does not serve Account scope for '${pluginId}'`,
        );
    }
    const lifetime = createPluginInvocationLifetime(signal);
    let lease: Awaited<ReturnType<typeof acquireProjectionRuntimeRegistryLease>> | null = null;
    try {
        lease = await acquireProjectionRuntimeRegistryLease(opts);
        const { fields } = readPluginSettingsDeclaration(lease.registry, pluginId, machineId, scope);
        const service = lease.registry.createPluginSettingsService?.({
            pluginId,
            scope,
            signal: lifetime.signal,
        }) ?? null;
        if (!service) {
            throw new PluginContextServiceError(
                'PLUGIN_SETTINGS_RUNTIME_UNAVAILABLE',
                `Plugin settings for '${pluginId}' have no current canonical runtime owner`,
            );
        }
        const secrets = lease.registry.createPluginSecretsService?.({
            pluginId,
            signal: lifetime.signal,
        }) ?? null;
        return await run({
            service,
            secrets,
            fields,
            scope,
        });
    } finally {
        try {
            await lease?.release();
        } finally {
            lifetime.complete();
        }
    }
}

/**
 * One bounded, content-free Settings watch request. The scoped daemon service
 * remains the only change producer; this handler observes its revision and
 * releases that service/registry lease before the caller opens the next parked
 * request. The UI record store remains the only Settings snapshot reader.
 */
async function waitForDaemonPluginSettingsWatch(
    input: Readonly<{
        service: ScopedSettingsService;
        knownRevision?: string;
        signal?: AbortSignal;
    }>,
): Promise<DaemonPluginSettingsWatchResponse> {
    input.signal?.throwIfAborted();
    return await new Promise<DaemonPluginSettingsWatchResponse>((resolve, reject) => {
        let settled = false;
        let subscription: ReturnType<ScopedSettingsService['watch']> | null = null;
        let disposeAfterRegistration = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const disposeSubscription = (): void => {
            if (!subscription) {
                disposeAfterRegistration = true;
                return;
            }
            const current = subscription;
            subscription = null;
            try {
                const result = current.dispose();
                if (result instanceof Promise) void result.catch(() => undefined);
            } catch {
                // Lease teardown is best effort; the enclosing owner still
                // retires its invocation lifetime and registry lease.
            }
        };
        const onAbort = (): void => {
            fail(input.signal?.reason ?? new Error('Daemon Settings watch aborted'));
        };
        const cleanup = (): void => {
            if (idleTimer !== null) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            input.signal?.removeEventListener('abort', onAbort);
            disposeSubscription();
        };
        const settle = (result: DaemonPluginSettingsWatchResponse): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) {
            onAbort();
            return;
        }
        try {
            subscription = input.service.watch((change) => {
                // The service itself scopes/deduplicates this callback. Keep
                // an identical cursor level-triggered too, so a malformed
                // duplicate cannot ask the UI record store to reread twice.
                if (change.scope.kind !== 'daemon' || change.revision === input.knownRevision) return;
                settle({ status: 'changed', revision: change.revision });
            });
            if (disposeAfterRegistration) {
                disposeSubscription();
                return;
            }
        } catch (error) {
            fail(error);
            return;
        }

        void input.service.snapshot({ signal: input.signal }).then(
            (snapshot) => {
                if (settled) return;
                if (snapshot.scope.kind !== 'daemon') {
                    fail(new PluginContextServiceError(
                        'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
                        'Exact-daemon Settings watch received an Account snapshot.',
                    ));
                    return;
                }
                if (input.knownRevision === undefined) {
                    settle({ status: 'ready', revision: snapshot.revision });
                    return;
                }
                if (snapshot.revision !== input.knownRevision) {
                    settle({ status: 'changed', revision: snapshot.revision });
                    return;
                }
                // Reuse the incumbent Resource parked-call budget. This is a
                // bounded RPC lifetime, not a Settings retry timer or poller.
                idleTimer = setTimeout(() => {
                    settle({ status: 'idle', revision: snapshot.revision });
                }, DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS);
            },
            fail,
        );
    });
}

/**
 * Secret-native daemon administration is intentionally independent of the
 * Settings model. The leased port owns declaration lookup, exact origin
 * partitioning, custody, and generation currentness.
 */
async function withDaemonPluginSecretAdministrationPort<T>(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    pluginId: string,
    signal: AbortSignal | undefined,
    run: (params: Readonly<{
        port: DeclaredDaemonPluginSecretAdministrationPort;
        signal: AbortSignal;
    }>) => Promise<T>,
): Promise<T> {
    const lifetime = createPluginInvocationLifetime(signal);
    let lease: Awaited<ReturnType<typeof acquireProjectionRuntimeRegistryLease>> | null = null;
    try {
        lease = await acquireProjectionRuntimeRegistryLease(opts);
        const port = lease.registry.createDaemonPluginSecretAdministrationPort?.({
            pluginId,
            signal: lifetime.signal,
        }) ?? null;
        if (!port) {
            throw new PluginContextServiceError(
                'PLUGIN_SETTINGS_SECRET_CUSTODY_UNAVAILABLE',
                `Plugin '${pluginId}' has no current declared secret custody service`,
            );
        }
        return await run({ port, signal: lifetime.signal });
    } finally {
        try {
            await lease?.release();
        } finally {
            lifetime.complete();
        }
    }
}

async function readDaemonPluginSecretStatus(params: Readonly<{
    pluginId: string;
    secretId: string;
    canonicalOrigin?: string;
    signal?: AbortSignal;
    port: DeclaredDaemonPluginSecretAdministrationPort;
}>): Promise<ReturnType<typeof DaemonPluginSecretStatusResponseSchema.parse>> {
    const status = await params.port.status({
        secretId: params.secretId,
        ...(params.canonicalOrigin === undefined
            ? {}
            : { canonicalOrigin: params.canonicalOrigin }),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    return DaemonPluginSecretStatusResponseSchema.parse({
        protocolVersion: 1,
        pluginId: params.pluginId,
        secretId: params.secretId,
        state: status.state,
        revision: status.revision,
    });
}

async function readPluginSettingsSnapshot(params: Readonly<{
    pluginId: string;
    service: ScopedSettingsService;
    secrets: SecretsService | null;
    fields: readonly PluginSettingFieldV2[];
    scope: DaemonPluginSettingsSnapshot['scope'];
}>): Promise<DaemonPluginSettingsSnapshot> {
    const stableSnapshot = await params.service.snapshot();
    if (stableSnapshot.scope.kind !== params.scope.kind) {
        throw new PluginContextServiceError(
            'PLUGIN_SETTINGS_SCOPE_UNAVAILABLE',
            `Plugin settings scope '${params.scope.kind}' resolved a different record`,
        );
    }
    const redactedKeys = (await Promise.all(params.fields
        .filter(isSecretSettingsField)
        .map(async (field) => {
            if (!params.secrets) return null;
            try {
                return (await params.secrets.status(field.id)).state === 'configured'
                    ? field.id
                    : null;
            } catch {
                return null;
            }
        })))
        .filter((id): id is string => id !== null)
        .sort((left, right) => left.localeCompare(right));

    return DaemonPluginSettingsGetResponseSchema.parse({
        protocolVersion: 1,
        pluginId: params.pluginId,
        scope: stableSnapshot.scope,
        revision: stableSnapshot.revision,
        values: stableSnapshot.values,
        redactedKeys,
    });
}

async function acquireProjectionContributionRegistryLease(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    generation: number,
    requireRuntimeRegistry = false,
): Promise<Readonly<{
    registry: ResolvedContributionRegistry;
    pluginDiagnosticsByPluginId: ResolvedExecutablePluginRuntimeRegistry['pluginDiagnosticsByPluginId'];
    targetActivationFacts: NonNullable<ResolvedExecutablePluginRuntimeRegistry['targetActivationFacts']> | null;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    cacheToken: string;
    release: () => Promise<void>;
}>> {
    if (opts?.resolveRuntimeRegistry || requireRuntimeRegistry) {
        const lease = await acquireProjectionRuntimeRegistryLease(opts, requireRuntimeRegistry);
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
    const requiresColdComposerSurfaceCatalog = listComposerSurfaceDeclarations(registry).length > 0;
    if (
        (registry.scmBackends?.length ?? 0) > 0
        || (registry.scmHostingProviders?.length ?? 0) > 0
        || requiresColdComposerSurfaceCatalog
    ) {
        const lease = await acquireProjectionRuntimeRegistryLease(opts, requiresColdComposerSurfaceCatalog);
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
        cacheToken: `metadata:${generation}`,
        release: async () => {},
    };
}

async function resolveProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    request?: DaemonContributionRegistryProjectionDescribeRequest,
): Promise<DaemonContributionRegistryProjectionDescribeResponse> {
    const now = Date.now();
    const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
    const lease = await acquireProjectionContributionRegistryLease(
        opts,
        generation,
        request?.mountedTarget !== undefined,
    );
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
        const mountedTargetSnapshots = request?.mountedTarget
            ? lease.runtimeRegistry
                ? readMountedTargetedContributionSnapshots({
                    runtimeRegistry: lease.runtimeRegistry,
                    mountedTarget: request.mountedTarget,
                })
                : (() => {
                    throw new PluginError({
                        code: 'plugin_targeted_contributions_unavailable',
                        message: 'Targeted contribution projection requires the current runtime registry',
                    });
                })()
            : undefined;
        const resolvedPluginUiHostRuntime = await resolveProjectionHostRuntimeWithCrashState(opts, {
            registry: lease.registry,
            generation,
            ...(request?.reactNativeHostRuntimeIdentity
                ? { reactNativeHostRuntimeIdentity: request.reactNativeHostRuntimeIdentity }
                : {}),
            ...(request?.reactNativeWebLoaderCapability
                ? { reactNativeWebLoaderCapability: request.reactNativeWebLoaderCapability }
                : {}),
            ...(request?.hostedWebFrameCapability
                ? { hostedWebFrameCapability: request.hostedWebFrameCapability }
                : {}),
            ...(mountedTargetSnapshots
                ? { targetedSurfaceSnapshots: mountedTargetSnapshots }
                : {}),
        });
        const preparedTargetedSurfacesByPluginId = request?.mountedTarget && mountedTargetSnapshots
            ? readMountedPreparedTargetedSurfaceInventories({
                mountedTarget: request.mountedTarget,
                snapshots: mountedTargetSnapshots,
            })
            : undefined;
        const modelsByRendererKey = typeof lease.runtimeRegistry?.generation === 'number'
            ? resolveDeclarativeProjectionModels({
                registry: lease.registry,
                generation,
                onRendererModelUnavailable({ pluginId, rendererId, error }) {
                    logger.warn('[PLUGIN RUNTIME] Declarative renderer is unavailable: its model could not be built', {
                        pluginId,
                        rendererId,
                        reason: projectPluginFailureText(
                            error instanceof Error ? error : new Error(String(error)),
                        ),
                    });
                },
                ...(lease.runtimeRegistry.targetActionInvocations
                    ? { actionRuntime: lease.runtimeRegistry.targetActionInvocations }
                    : {}),
                ...(preparedTargetedSurfacesByPluginId
                    ? { preparedTargetedSurfacesByPluginId }
                    : {}),
            })
            : Object.freeze({});
        const pluginUiHostRuntime = Object.freeze({
            ...resolvedPluginUiHostRuntime,
            declarative: Object.freeze({ modelsByRendererKey }),
            ...(lease.runtimeRegistry?.getPluginUiResourceCapability ? {
                resourceCapabilityForPlugin: (pluginId: string) => (
                    lease.runtimeRegistry!.getPluginUiResourceCapability!(pluginId)
                ),
            } : {}),
        });
        const brandAssetsByPluginId = readCurrentPluginBrandAssetsForProjection({
            registry: lease.registry,
            runtimeRegistry: lease.runtimeRegistry,
        });
        const pluginExecutionOriginsByPluginId = await resolvePluginExecutionOriginsForProjection(
            opts,
            lease.registry,
        );
        const pluginFinalPolicyCurrentGenerationsById = lease.runtimeRegistry
            ?.pluginFinalPolicyCurrentGenerationsById;
        const cacheKey = createProjectionCacheKey({
            generation,
            registryCacheToken: lease.cacheToken,
            pluginUiHostRuntime,
            brandAssetsByPluginId,
            pluginExecutionOriginsByPluginId,
            ...(pluginFinalPolicyCurrentGenerationsById
                ? { pluginFinalPolicyCurrentGenerationsById }
                : {}),
            ...(request?.mountedTarget ? { mountedTarget: request.mountedTarget } : {}),
            ...(request?.locale ? { requestedLocale: request.locale } : {}),
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
            brandAssetsByPluginId,
            pluginExecutionOriginsByPluginId,
            ...(lease.runtimeRegistry?.settingsRollbackDeclarations
                ? {
                    settingsRollbackDeclarationsByPluginId:
                        lease.runtimeRegistry.settingsRollbackDeclarations,
                }
                : {}),
            ...(lease.runtimeRegistry?.resolveActionPresentUserGatePolicy
                ? {
                    resolveActionPresentUserGatePolicy:
                        lease.runtimeRegistry.resolveActionPresentUserGatePolicy,
                }
                : {}),
            ...(pluginFinalPolicyCurrentGenerationsById
                ? { pluginFinalPolicyCurrentGenerationsById }
                : {}),
            scmRuntimeAvailability,
            ...(introspectionRuntimeSnapshot ? { introspectionRuntimeSnapshot } : {}),
            ...(request?.locale ? { requestedLocale: request.locale } : {}),
        });
        const composerSurfaceCatalog = lease.runtimeRegistry
            ? projectDaemonComposerSurfaceCatalog({
                registry: lease.registry,
                projection,
                pluginUiHostRuntime,
                modelsByRendererKey,
                pluginExecutionOriginsByPluginId,
                resourceCapabilityForPlugin: (pluginId) => readTargetedSurfaceResourceCapability(
                    lease.runtimeRegistry!,
                    pluginId,
                ),
                readContributorTargetedContributions: (target) => readMountedTargetedContributionsProjection({
                    runtimeRegistry: lease.runtimeRegistry!,
                    mountedTarget: target,
                }),
            })
            : undefined;
        const automationEligibleEvents = (lease.registry.automationEligibleEvents ?? []).map((entry) => {
            const renderer = entry.event.automation.source.setupSurface;
            if (!renderer) return entry;
            const pluginId = entry.event.identity.pluginId;
            const executionOrigin = pluginExecutionOriginsByPluginId[pluginId];
            if (!executionOrigin) return Object.freeze({ ...entry, setupSurface: undefined });
            const rendered = projectDaemonEmbeddedPluginUiRenderer({
                registry: lease.registry,
                projection,
                pluginUiHostRuntime,
                modelsByRendererKey,
                contributor: entry.event.identity,
                immutableGenerationId: entry.event.immutableGenerationId,
                renderer,
                crashMount: Object.freeze({
                    kind: 'automationEventSetupSurface' as const,
                    contribution: Object.freeze({ ...entry.event.identity }),
                    immutableGenerationId: entry.event.immutableGenerationId,
                }),
            });
            if (!rendered) return Object.freeze({ ...entry, setupSurface: undefined });
            try {
                return Object.freeze({
                    ...entry,
                    setupSurface: Object.freeze({
                        contribution: Object.freeze({ ...entry.event.identity }),
                        immutableGenerationId: entry.event.immutableGenerationId,
                        projectionGeneration: projection.generation,
                        rendererChain: rendered.rendererChain.map((identity) => ({ ...identity })),
                        selectedRenderer: rendered.selectedRenderer,
                        executionOrigin: Object.freeze({
                            serverIdentityId: executionOrigin.serverIdentityId,
                            materializationRef: Object.freeze({ ...executionOrigin.materializationRef }),
                        }),
                        resourceCapability: readTargetedSurfaceResourceCapability(
                            lease.runtimeRegistry!,
                            pluginId,
                        ),
                        contributorTargetedContributions: readMountedTargetedContributionsProjection({
                            runtimeRegistry: lease.runtimeRegistry!,
                            mountedTarget: {
                                pluginId,
                                immutableGenerationId: entry.event.immutableGenerationId,
                            },
                        }),
                    }),
                });
            } catch {
                return Object.freeze({ ...entry, setupSurface: undefined });
            }
        });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1,
            projection,
            automationEligibleEvents,
            ...(composerSurfaceCatalog ? { composerSurfaceCatalog } : {}),
            ...(request?.mountedTarget
                ? {
                    targetedContributions: lease.runtimeRegistry
                        ? readMountedTargetedContributionsProjection({
                            runtimeRegistry: lease.runtimeRegistry,
                            mountedTarget: request.mountedTarget,
                            ...(mountedTargetSnapshots ? { snapshots: mountedTargetSnapshots } : {}),
                        })
                        : (() => {
                            throw new PluginError({
                                code: 'plugin_targeted_contributions_unavailable',
                                message: 'Targeted contribution projection requires the current runtime registry',
                            });
                        })(),
                    targetedSurfaceMounts: lease.runtimeRegistry && mountedTargetSnapshots
                        ? readMountedTargetedSurfaceMountsProjection({
                            runtimeRegistry: lease.runtimeRegistry,
                            mountedTarget: request.mountedTarget,
                            snapshots: mountedTargetSnapshots,
                            projection,
                            pluginUiHostRuntime,
                            modelsByRendererKey,
                            pluginExecutionOriginsByPluginId,
                        })
                        : (() => {
                            throw new PluginError({
                                code: 'plugin_targeted_surface_mount_unavailable',
                                message: 'Targeted Surface projection requires the current runtime registry',
                            });
                        })(),
                }
                : {}),
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
    left: DaemonPluginReactNativeBundleCacheIdentityV1,
    right: DaemonPluginReactNativeBundleCacheIdentityV1,
): boolean {
    return isSameDaemonPluginReactNativeBundleCacheIdentityV1(left, right);
}

function hostedWebIdentityMatches(
    left: DaemonPluginHostedWebArtifactCacheIdentityV1,
    right: DaemonPluginHostedWebArtifactCacheIdentityV1,
): boolean {
    return isSameDaemonPluginHostedWebArtifactCacheIdentityV1(left, right);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
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

type ProjectedClientActionExecution = Readonly<{
    target: 'client';
    client: Readonly<{
        artifactId: string;
        modulePath: string;
        exportName: string;
    }>;
    platforms: readonly ('web' | 'ios' | 'android')[];
}>;

type ProjectedClientActionArtifact = Readonly<{
    execution: ProjectedClientActionExecution;
    origin: PluginMachineExecutionOriginV1;
}>;

/**
 * Client Action bytes are authorized by the current projected Action, not by
 * a nearby UI contribution. The projection owns the Action's execution
 * declaration and exact producer origin; this byte route merely consumes it.
 */
async function readCurrentProjectedClientActionArtifact(params: Readonly<{
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined;
    registry: ResolvedContributionRegistry;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    requestMachineId: string;
    action: Readonly<{ pluginId: string; localId: string }>;
}>): Promise<ProjectedClientActionArtifact | null> {
    const pluginExecutionOriginsByPluginId = await resolvePluginExecutionOriginsForProjection(
        params.opts,
        params.registry,
    );
    const projection = buildPluginProjectionV2({
        registry: params.registry,
        generation: params.generation,
        installedPackages: [],
        pluginDiagnosticsByPluginId: {},
        pluginUiHostRuntime: params.pluginUiHostRuntime,
        pluginExecutionOriginsByPluginId,
    });
    const action = projection.actionsById[
        buildQualifiedPluginContributionKey(params.action)
    ];
    if (
        !action
        || action.id !== params.action.localId
        || action.pluginId !== params.action.pluginId
        || action.available !== true
        || action.execution.target !== 'client'
        || action.serverIdentityId === undefined
        || action.materializationRef === undefined
    ) {
        return null;
    }
    const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: action.serverIdentityId,
        materializationRef: action.materializationRef,
    });
    if (
        !parsedOrigin.success
        || parsedOrigin.data.materializationRef.pluginId !== params.action.pluginId
        || parsedOrigin.data.materializationRef.machineId !== params.requestMachineId
    ) {
        return null;
    }
    return Object.freeze({
        execution: Object.freeze({
            target: 'client',
            client: Object.freeze({ ...action.execution.client }),
            platforms: Object.freeze([...action.execution.platforms]),
        }),
        origin: parsedOrigin.data,
    });
}

function readProjectedHostedWebArtifactIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
}>): DaemonPluginHostedWebArtifactCacheIdentityV1 | null {
    const projection = buildPluginProjectionV2({
        registry: params.registry,
        generation: params.generation,
        installedPackages: [],
        pluginDiagnosticsByPluginId: {},
        pluginUiHostRuntime: params.pluginUiHostRuntime,
    });
    const entry = projection.familiesById.pluginUi?.entriesById[
        `hostedWeb:${params.identity.pluginId}:${params.identity.contributionId}`
    ];
    const runtime = readRecord(entry?.runtime);
    const parsed = DaemonPluginHostedWebArtifactCacheIdentityV1Schema.safeParse(
        runtime?.artifactReadIdentity,
    );
    return parsed.success ? parsed.data : null;
}

function findGeneratedReactNativeArtifactGraph(params: Readonly<{
    owner:
        | ResolvedGeneratedReactNativeArtifactOwner
        | ResolvedGeneratedReactNativeClientContributionArtifactOwner;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
}>): PluginUiArtifactsManifestEntryV1 | null {
    const resolved = findGeneratedReactNativeArtifactEntry({
        owner: params.owner,
        platform: params.identity.platform,
    });
    return resolved.entry?.digest === params.identity.artifactDigest ? resolved.entry : null;
}

function findGeneratedHostedWebArtifactGraph(params: Readonly<{
    owner: ResolvedGeneratedHostedWebArtifactOwner;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
}>): PluginUiArtifactsManifestEntryV1 | null {
    const resolved = findGeneratedHostedWebArtifactEntry({ owner: params.owner });
    return resolved.entry?.digest === params.identity.artifactDigest ? resolved.entry : null;
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

async function readVerifiedGeneratedPluginUiArtifactGraph(params: Readonly<{
    pluginRootPath: string | undefined;
    graph: PluginUiArtifactsManifestEntryV1;
    pluginId: string;
    contributionId: string;
    artifactKind: 'reactNativeBundle' | 'hostedWebAsset';
    diagnostics: Readonly<{
        graphInvalid: string;
        rootUnavailable: string;
        pathInvalid: string;
        fileIntegrityFailed: string;
        readFailed: string;
        entryMissing: string;
    }>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>): Promise<
    | Readonly<{
        ok: true;
        digest: PluginUiArtifactDigestV1;
        entry: Readonly<{ relativePath: string; bytes: Uint8Array }>;
        files: readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[];
    }>
    | Readonly<{ ok: false; response: DaemonPluginUiArtifactBytesReadResponse }>
> {
    const uniqueFiles = new Set(params.graph.files.map((file) => file.relativePath));
    if (uniqueFiles.size !== params.graph.files.length || !uniqueFiles.has(params.graph.entry)) {
        return Object.freeze({
            ok: false,
            response: artifactBytesError('artifact_integrity_failed', [params.diagnostics.graphInvalid]),
        });
    }
    const pluginRootPath = params.pluginRootPath?.trim();
    if (!pluginRootPath) {
        return Object.freeze({
            ok: false,
            response: artifactBytesError('artifact_unavailable', [params.diagnostics.rootUnavailable]),
        });
    }
    const installedRoot = join(pluginRootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
    const loadedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
    for (const file of params.graph.files) {
        const resolved = await resolveContainedPluginResourcePath({
            pluginRootPath: installedRoot,
            resourcePath: file.relativePath,
        });
        if (!resolved) {
            return Object.freeze({
                ok: false,
                response: artifactBytesError('artifact_unavailable', [params.diagnostics.pathInvalid]),
            });
        }
        try {
            const bytes = await (params.readArtifactFile ?? readFile)(resolved.absolutePath);
            if (bytes.byteLength !== file.byteSize || computePluginUiArtifactSha256DigestV1(bytes) !== file.digest) {
                return Object.freeze({
                    ok: false,
                    response: artifactBytesError('artifact_integrity_failed', [params.diagnostics.fileIntegrityFailed]),
                });
            }
            loadedFiles.push(Object.freeze({ relativePath: file.relativePath, bytes }));
        } catch {
            return Object.freeze({
                ok: false,
                response: artifactBytesError('artifact_read_failed', [params.diagnostics.readFailed]),
            });
        }
    }

    const integrity = verifyPluginUiArtifactFileSetIntegrityV1({
        files: loadedFiles,
        integrity: {
            digest: params.graph.digest,
            pluginId: params.pluginId,
            contributionId: params.contributionId,
            artifactKind: params.artifactKind,
        },
    });
    if (!integrity.ok) {
        return Object.freeze({
            ok: false,
            response: artifactBytesError('artifact_integrity_failed', [integrity.reasonCode]),
        });
    }
    const entry = loadedFiles.find((file) => file.relativePath === params.graph.entry);
    if (!entry) {
        return Object.freeze({
            ok: false,
            response: artifactBytesError('artifact_integrity_failed', [params.diagnostics.entryMissing]),
        });
    }
    return Object.freeze({
        ok: true,
        digest: integrity.digest,
        entry,
        files: Object.freeze(loadedFiles),
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

/**
 * The projected exact binding is the only currentness authority for UI crash
 * state. A byte/report caller cannot substitute another surface which happens
 * to share the renderer or artifact digest.
 */
function readCurrentReactNativeCrashStateForToken(params: Readonly<{
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    token: DaemonPluginReactNativeCrashBindingTokenV1;
}>): ReactNativeCrashStateProjection | null {
    const state = params.pluginUiHostRuntime.reactNativeBundles?.crashStatesByBindingKey?.[
        createReactNativeCrashStateBindingKey(params.token)
    ];
    return state && isSameDaemonPluginReactNativeCrashBindingTokenV1(state.token, params.token) ? state : null;
}

/**
 * A crash token is only a currentness claim. Its target arm can narrow the
 * canonical admission read, but it cannot supply a synthetic snapshot or
 * bypass exact target-generation admission.
 */
function readTargetedSurfaceSnapshotsForCrashToken(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    token: DaemonPluginReactNativeCrashBindingTokenV1,
): readonly MountedTargetedContributionSnapshot[] | undefined {
    if (token.mount.kind !== 'targetedSurface') return undefined;
    return readMountedTargetedContributionSnapshots({
        runtimeRegistry: registry,
        mountedTarget: token.mount.target,
    });
}

type GeneratedReactNativeArtifactReadParams = Readonly<{
    registry: ResolvedContributionRegistry;
    owner:
        | ResolvedGeneratedReactNativeArtifactOwner
        | ResolvedGeneratedReactNativeClientContributionArtifactOwner;
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}> & (
    | Readonly<{
        artifactOwnerKind: 'renderer';
        crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1;
    }>
    | Readonly<{
        artifactOwnerKind: 'voiceProvider';
    }>
    | Readonly<{
        /**
         * Candidate Collection migrations use the exact renderer artifact
         * graph, but never enter renderer crash containment or Voice lifecycle.
         */
        artifactOwnerKind: 'collectionMigrations';
    }>
    | Readonly<{
        artifactOwnerKind: 'clientContribution';
        clientContribution: Readonly<{
            family: 'actions';
            action: Readonly<{ pluginId: string; localId: string }>;
        }>;
        projectedClientAction: ProjectedClientActionArtifact;
    }>
);

/**
 * The generated Artifact graph is the sole daemon byte authority for both
 * React Native consumers. The renderer-only branch is deliberately the only
 * place this path reads crash state; Voice and host-private candidate
 * Collection migrations never enter that lifecycle. Candidate code additionally
 * requires its explicit signed module declaration; a renderer graph is not
 * candidate code merely because it shares an artifact family.
 */
async function readGeneratedReactNativeArtifactBytesByCacheIdentity(
    params: GeneratedReactNativeArtifactReadParams,
): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    if (
        params.artifactOwnerKind === 'renderer'
        && (
            params.crashStateToken.renderer.pluginId !== params.identity.pluginId
            || params.crashStateToken.renderer.localId !== params.identity.contributionId
            || params.crashStateToken.artifactDigest !== params.identity.artifactDigest
        )
    ) {
        return artifactBytesError('crash_state_token_mismatch', ['react_native_crash_state_token_mismatch']);
    }
    if (params.artifactOwnerKind === 'renderer') {
        // Authorize the renderer binding before resolving its graph or opening
        // any file. A stale or disabled crash token must never disclose or
        // materialize executable bytes merely because the graph is otherwise
        // current.
        const crashState = readCurrentReactNativeCrashStateForToken({
            pluginUiHostRuntime: params.pluginUiHostRuntime,
            token: params.crashStateToken,
        });
        if (!crashState) {
            return artifactBytesError('crash_state_token_mismatch', ['react_native_crash_state_token_mismatch']);
        }
        if (crashState.disabled) {
            return artifactBytesError('artifact_unavailable', ['crash_threshold_reached']);
        }
    }
    const projected = params.artifactOwnerKind === 'clientContribution'
        ? Object.freeze({ cacheIdentity: params.identity })
        : readProjectedReactNativeExecutableIdentity(params);
    if (!projected || !reactNativeIdentityMatches(projected.cacheIdentity, params.identity)) {
        return artifactBytesError('artifact_not_found', ['react_native_projected_identity_not_found']);
    }
    if (
        params.artifactOwnerKind === 'clientContribution'
        && (
            params.owner.kind !== 'clientContribution'
            || params.owner.pluginId !== params.clientContribution.action.pluginId
            || params.owner.contributionId !== params.clientContribution.action.localId
            || params.projectedClientAction.execution.client.artifactId !== params.owner.artifactId
            || params.projectedClientAction.execution.client.modulePath !== params.owner.expectedRepackModule.modulePath
            || params.projectedClientAction.execution.client.exportName !== params.owner.expectedRepackModule.exportName
            || !params.projectedClientAction.execution.platforms.includes(
                params.identity.platform as 'web' | 'ios' | 'android',
            )
        )
    ) {
        return artifactBytesError('artifact_not_found', ['generated_react_native_client_contribution_artifact_mismatch']);
    }
    const collectionMigrations = params.artifactOwnerKind === 'collectionMigrations'
        && params.owner.kind === 'renderer'
        ? findGeneratedReactNativeCollectionMigrationsModule({
            owner: params.owner,
            platform: params.identity.platform,
        })
        : null;
    const graph = collectionMigrations?.entry ?? findGeneratedReactNativeArtifactGraph(params);
    const expectedBundler = graph?.platform === 'web' ? 'vite' : 'repack';
    if (!graph || graph.builtWith.bundler !== expectedBundler) {
        return artifactBytesError('artifact_not_found', [
            collectionMigrations?.failure ?? 'generated_react_native_artifact_graph_not_found',
        ]);
    }
    const loaded = await readVerifiedGeneratedPluginUiArtifactGraph({
        pluginRootPath: params.owner.pluginRootPath,
        graph,
        pluginId: params.identity.pluginId,
        contributionId: params.identity.contributionId,
        artifactKind: 'reactNativeBundle',
        diagnostics: {
            graphInvalid: 'generated_react_native_artifact_graph_invalid',
            rootUnavailable: 'generated_react_native_plugin_root_unavailable',
            pathInvalid: 'react_native_artifact_path_invalid',
            fileIntegrityFailed: 'react_native_artifact_file_integrity_failed',
            readFailed: 'react_native_artifact_read_failed',
            entryMissing: 'generated_react_native_entry_missing',
        },
        ...(params.readArtifactFile ? { readArtifactFile: params.readArtifactFile } : {}),
    });
    if (!loaded.ok) return loaded.response;
    // The success contract pins `format: 'plainJs'`, so this authority verifies
    // the claim instead of asserting it. Hermes bytecode is integrity-valid but
    // unloadable by every consumer of this path, so it is refused here rather
    // than shipped to a JS evaluator on the device.
    if (isPluginUiHermesBytecodeArtifactV1(loaded.entry.bytes)) {
        return artifactBytesError('unsupported_artifact_format', ['hermes_bytecode_unsupported']);
    }
    const files = loaded.files.map((file) => Object.freeze({
        relativePath: file.relativePath,
        digest: computePluginUiArtifactSha256DigestV1(file.bytes),
        byteSize: file.bytes.byteLength,
        bytesBase64: Buffer.from(file.bytes).toString('base64'),
    }));
    const response = {
        ok: true,
        artifactFamily: 'reactNative',
        artifactOwnerKind: params.artifactOwnerKind,
        cacheIdentity: projected.cacheIdentity,
        artifact: {
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            artifactKind: 'reactNativeBundle',
            // This is the canonical complete-file-set digest, not an entry-byte digest.
            digest: loaded.digest,
            format: 'plainJs',
            byteSize: loaded.entry.bytes.byteLength,
        },
        bytesBase64: Buffer.from(loaded.entry.bytes).toString('base64'),
        files,
    };
    if (params.artifactOwnerKind === 'renderer') {
        return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
            ...response,
            crashStateToken: params.crashStateToken,
        });
    }
    if (params.artifactOwnerKind === 'clientContribution') {
        return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
            ...response,
            clientContribution: params.clientContribution,
        });
    }
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse(response);
}

async function readGeneratedHostedWebArtifactBytesByCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    owner: ResolvedGeneratedHostedWebArtifactOwner;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    const projected = readProjectedHostedWebArtifactIdentity(params);
    if (!projected || !hostedWebIdentityMatches(projected, params.identity)) {
        return artifactBytesError('artifact_not_found', ['hosted_web_projected_identity_not_found']);
    }
    const graph = findGeneratedHostedWebArtifactGraph(params);
    if (!graph || graph.platform !== 'web' || graph.builtWith.bundler !== 'vite' || graph.repack) {
        return artifactBytesError('artifact_not_found', ['generated_hosted_web_artifact_graph_not_found']);
    }
    const loaded = await readVerifiedGeneratedPluginUiArtifactGraph({
        pluginRootPath: params.owner.pluginRootPath,
        graph,
        pluginId: params.identity.pluginId,
        contributionId: params.identity.contributionId,
        artifactKind: 'hostedWebAsset',
        diagnostics: {
            graphInvalid: 'generated_hosted_web_artifact_graph_invalid',
            rootUnavailable: 'generated_hosted_web_plugin_root_unavailable',
            pathInvalid: 'hosted_web_artifact_path_invalid',
            fileIntegrityFailed: 'hosted_web_artifact_file_integrity_failed',
            readFailed: 'hosted_web_artifact_read_failed',
            entryMissing: 'generated_hosted_web_entry_missing',
        },
        ...(params.readArtifactFile ? { readArtifactFile: params.readArtifactFile } : {}),
    });
    if (!loaded.ok) return loaded.response;

    return DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: true,
        artifactFamily: 'hostedWeb',
        cacheIdentity: projected,
        artifact: {
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            artifactKind: 'hostedWebAsset',
            digest: loaded.digest,
            byteSize: loaded.entry.bytes.byteLength,
        },
        bytesBase64: Buffer.from(loaded.entry.bytes).toString('base64'),
        files: loaded.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: computePluginUiArtifactSha256DigestV1(file.bytes),
            byteSize: file.bytes.byteLength,
            bytesBase64: Buffer.from(file.bytes).toString('base64'),
        })),
    });
}

async function readHostedWebArtifactBytesByCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    identity: DaemonPluginHostedWebArtifactCacheIdentityV1;
    generation: number;
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    if (params.pluginUiHostRuntime.hostedWeb?.featureEnabled !== true) {
        return artifactBytesError('artifact_unavailable', ['feature_disabled']);
    }
    if (params.identity.projectionGeneration !== params.generation) {
        return artifactBytesError('artifact_not_found', ['hosted_web_projection_generation_mismatch']);
    }
    const generatedOwner = findResolvedGeneratedHostedWebArtifactOwner({
        registry: params.registry,
        pluginId: params.identity.pluginId,
        contributionId: params.identity.contributionId,
    });
    if (!generatedOwner) {
        return artifactBytesError('artifact_not_found', ['hosted_web_artifact_not_found']);
    }
    return await readGeneratedHostedWebArtifactBytesByCacheIdentity({
        ...params,
        owner: generatedOwner,
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
        const report = request.data.report;
        let targetedSurfaceSnapshots: readonly MountedTargetedContributionSnapshot[] | undefined;
        try {
            targetedSurfaceSnapshots = readTargetedSurfaceSnapshotsForCrashToken(
                lease.registry,
                report.token,
            );
        } catch {
            return reactNativeCrashReportError(
                'binding_token_mismatch',
                ['react_native_crash_report_binding_token_mismatch'],
            );
        }
        const pluginUiHostRuntime = await resolveProjectionHostRuntimeWithCrashState(opts, {
            registry: lease.registry.contributes,
            generation,
            ...(targetedSurfaceSnapshots ? { targetedSurfaceSnapshots } : {}),
        });
        const current = readCurrentReactNativeCrashStateForToken({
            pluginUiHostRuntime,
            token: report.token,
        });
        if (!current) {
            return reactNativeCrashReportError(
                'binding_token_mismatch',
                ['react_native_crash_report_binding_token_mismatch'],
            );
        }

        try {
            const store = createReactNativeCrashStateStore({ happyHomeDir: configuration.happyHomeDir });
            if (report.kind === 'reportFailure') {
                const recorded = await recordReactNativeCrashFailure({
                    store,
                    token: report.token,
                    failureOccurrenceId: report.failureOccurrenceId,
                    failure: report.failure,
                });
                if (recorded.status === 'binding_token_mismatch') {
                    return reactNativeCrashReportError(
                        'binding_token_mismatch',
                        ['react_native_crash_report_binding_token_mismatch'],
                    );
                }
                if (recorded.status === 'failure_occurrence_conflict') {
                    return reactNativeCrashReportError(
                        'failure_occurrence_conflict',
                        ['react_native_crash_report_failure_occurrence_conflict'],
                    );
                }
                invalidateDaemonContributionRegistryProjectionCache();
                return reactNativeCrashReportResponse({
                    protocolVersion: 1,
                    ok: true,
                    token: current.token,
                    disabled: recorded.disabled,
                });
            }

            const reset = await resetReactNativeCrashState({
                store,
                token: report.token,
            });
            if (reset.status === 'binding_token_mismatch' || !reset.token) {
                return reactNativeCrashReportError(
                    'binding_token_mismatch',
                    ['react_native_crash_report_binding_token_mismatch'],
                );
            }
            invalidateDaemonContributionRegistryProjectionCache();
            return reactNativeCrashReportResponse({
                protocolVersion: 1,
                ok: true,
                token: reset.token,
                disabled: false,
            });
        } catch {
            return reactNativeCrashReportError(
                'state_write_failed',
                ['react_native_crash_report_state_write_failed'],
            );
        }
    } finally {
        await lease.release();
    }
}

/**
 * One taxonomy mapping for every live-resource call. The codes are the resource
 * owner's own; only the coarse `reason` is transport vocabulary, and an
 * unrecognized failure stays `unavailable` rather than being reported as a
 * client mistake.
 */
function readPluginUiResourceWatchFailure(error: unknown): Readonly<{
    ok: false;
    code: string;
    reason: 'invalid_payload' | 'stale_generation' | 'not_found' | 'unknown_subscription' | 'unavailable';
}> {
    const code = isPluginError(error) ? error.code : 'plugin_resource_unavailable';
    const reason = code === 'plugin_resource_not_found'
        ? 'not_found' as const
        : code === 'plugin_generation_stale'
            ? 'stale_generation' as const
            : code === 'plugin_resource_subscription_unknown'
                ? 'unknown_subscription' as const
                : code === 'plugin_resource_declaration_invalid'
                    || code === 'plugin_resource_options_invalid'
                    || code === 'plugin_resource_limit_invalid'
                    ? 'invalid_payload' as const
                    : 'unavailable' as const;
    return { ok: false, code, reason };
}

export function registerDaemonContributionRegistryProjectionHandler(
    rpc: RpcHandlerRegistrar,
    opts?: DaemonContributionRegistryProjectionRegistrationOptions,
): void {
    registerDaemonPluginCollectionCandidatePreparationHandler(rpc, {
        resolveCurrentTarget: async ({ signal }) => {
            if (signal?.aborted) return null;
            try {
                const current = await opts?.resolvePluginProjectionExecutionOriginContext?.() ?? null;
                return signal?.aborted ? null : current;
            } catch {
                return null;
            }
        },
        acquireRuntimeRegistryLease: async () => {
            const lease = await acquireProjectionRuntimeRegistryLease(opts);
            return {
                registry: lease.registry,
                release: lease.release,
            };
        },
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async (raw: unknown) => {
        // Parse input for forward compatibility and to avoid accepting accidental session-scoped payloads.
        const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(raw);
        return await resolveProjectionCoalescingConcurrentRequests(opts, request);
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSettingsGetRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withPluginSettingsService(
            opts,
            request.pluginId,
            request.machineId,
            request.scope,
            context?.signal,
            async ({
                service,
                secrets,
                fields,
                scope,
            }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const snapshot = await readPluginSettingsSnapshot({
                    pluginId: request.pluginId,
                    service,
                    secrets,
                    fields,
                    scope,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return snapshot;
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSettingsSetRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withPluginSettingsService(
            opts,
            request.pluginId,
            request.machineId,
            request.scope,
            context?.signal,
            async ({
                service,
                secrets,
                fields,
                scope,
            }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const field = fields.find((candidate) => candidate.id === request.fieldId);
                if (!field) {
                    throw new PluginContextServiceError(
                        'PLUGIN_SETTINGS_UNKNOWN_KEY',
                        `Plugin setting '${request.fieldId}' is not declared in the manifest`,
                    );
                }
                let status: 'applied' | 'conflict' = 'applied';
                try {
                    if (isSecretSettingsField(field)) {
                        if (!secrets) {
                            throw new PluginContextServiceError(
                                'PLUGIN_SETTINGS_SECRET_CUSTODY_UNAVAILABLE',
                                `Plugin setting '${request.fieldId}' has no declared secret custody owner`,
                            );
                        }
                        if (request.mutation.kind === 'delete') {
                            await secrets.delete(request.fieldId, {
                                ...(request.expectedRevision === undefined
                                    ? {}
                                    : { expectedRevision: request.expectedRevision }),
                                signal: context?.signal,
                            });
                        } else {
                            if (typeof request.mutation.value !== 'string') {
                                throw new PluginContextServiceError(
                                    'PLUGIN_SETTINGS_VALIDATION_FAILED',
                                    `Plugin setting '${request.fieldId}' failed schema validation`,
                                );
                            }
                            assertPluginSettingFieldValue({
                                pluginId: request.pluginId,
                                field,
                                value: request.mutation.value,
                            });
                            await secrets.set(request.fieldId, request.mutation.value, {
                                ...(request.expectedRevision === undefined
                                    ? {}
                                    : { expectedRevision: request.expectedRevision }),
                                signal: context?.signal,
                            });
                        }
                    } else if (request.mutation.kind === 'delete') {
                        await service.reset(request.fieldId, {
                            ...(request.expectedRevision === undefined
                                ? {}
                                : { expectedRevision: request.expectedRevision }),
                        });
                    } else {
                        assertPluginSettingFieldValue({
                            pluginId: request.pluginId,
                            field,
                            value: request.mutation.value,
                        });
                        await service.set(request.fieldId, request.mutation.value as JsonValue, {
                            ...(request.expectedRevision === undefined
                                ? {}
                                : { expectedRevision: request.expectedRevision }),
                        });
                    }
                } catch (error) {
                    if (!isPluginSettingsRevisionConflict(error)) throw error;
                    status = 'conflict';
                }
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const snapshot = await readPluginSettingsSnapshot({
                    pluginId: request.pluginId,
                    service,
                    secrets,
                    fields,
                    scope,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return DaemonPluginSettingsSetResponseSchema.parse({ status, snapshot });
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSettingsWatchRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withPluginSettingsService(
            opts,
            request.pluginId,
            request.machineId,
            request.scope,
            context?.signal,
            async ({ service }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const result = await waitForDaemonPluginSettingsWatch({
                    service,
                    ...(request.knownRevision === undefined ? {} : { knownRevision: request.knownRevision }),
                    ...(context?.signal === undefined ? {} : { signal: context.signal }),
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return DaemonPluginSettingsWatchResponseSchema.parse(result);
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSecretStatusRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withDaemonPluginSecretAdministrationPort(
            opts,
            request.pluginId,
            context?.signal,
            async ({ port, signal }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return status;
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SECRET_SET, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSecretSetRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withDaemonPluginSecretAdministrationPort(
            opts,
            request.pluginId,
            context?.signal,
            async ({ port, signal }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                await port.set({
                    secretId: request.secretId,
                    value: request.value,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    ...(request.expectedRevision === undefined
                        ? {}
                        : { expectedRevision: request.expectedRevision }),
                    signal,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return DaemonPluginSecretSetResponseSchema.parse(status);
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE, async (
        raw: unknown,
        context?: RpcHandlerContext,
    ) => {
        const request = DaemonPluginSecretDeleteRequestSchema.parse(raw);
        await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
        return await withDaemonPluginSecretAdministrationPort(
            opts,
            request.pluginId,
            context?.signal,
            async ({ port, signal }) => {
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                await port.delete({
                    secretId: request.secretId,
                    ...(request.expectedRevision === undefined
                        ? {}
                        : { expectedRevision: request.expectedRevision }),
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    signal,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
                await assertCurrentDaemonPluginSettingsTarget(opts, request, context?.signal);
                return DaemonPluginSecretDeleteResponseSchema.parse(status);
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, async (raw: unknown, context) => {
        const request = DaemonPluginUiResourceReadRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginUiResourceReadResponseSchema.parse({
                ok: false,
                code: 'plugin_resource_request_invalid',
                reason: 'invalid_payload',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            if (!lease.registry.readUiResource || typeof lease.registry.generation !== 'number') {
                return DaemonPluginUiResourceReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_service_unavailable',
                    reason: 'unavailable',
                });
            }
            // Caller-scoped by construction: the resource service is bound to the
            // host-stamped calling plugin, so a reference naming another plugin
            // is simply not declared for that bind.
            if (request.data.resource.pluginId !== request.data.callerPluginId) {
                return DaemonPluginUiResourceReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_not_found',
                    reason: 'not_found',
                });
            }
            const value = await lease.registry.readUiResource({
                // The public projection revision and retained activation
                // generation deliberately differ after a peer reload. Resource
                // ownership is activation-local, so translate only at this
                // internal boundary after validating public currentness above.
                expectedGeneration: String(lease.registry.generation),
                callerPluginId: request.data.callerPluginId,
                resourceId: request.data.resource.localId,
                ...(request.data.context === undefined ? {} : { context: request.data.context }),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            return DaemonPluginUiResourceReadResponseSchema.parse({
                ok: true,
                resource: request.data.resource,
                kind: value.kind,
                contentType: value.contentType,
                digest: value.digest,
                bytesBase64: Buffer.from(value.bytes).toString('base64'),
            });
        } catch (error) {
            const code = isPluginError(error) ? error.code : 'plugin_resource_unavailable';
            const reason = code === 'plugin_resource_not_found'
                ? 'not_found'
                : code === 'plugin_generation_stale'
                    ? 'stale_generation'
                    : code === 'plugin_resource_declaration_invalid'
                        || code === 'plugin_resource_options_invalid'
                        || code === 'plugin_resource_limit_invalid'
                        ? 'invalid_payload'
                        : 'unavailable';
            return DaemonPluginUiResourceReadResponseSchema.parse({ ok: false, code, reason });
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH, async (raw: unknown, context) => {
        const request = DaemonPluginComposerReferenceSearchRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                ok: false,
                code: 'composer_reference_request_invalid',
                reason: 'invalid_payload',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            const references = lease.registry.composerReferences;
            if (!references) {
                return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                    ok: false,
                    code: 'composer_reference_unavailable',
                    reason: 'unavailable',
                });
            }
            const page = await references.search({
                reference: request.data.reference,
                query: request.data.query,
                trigger: request.data.trigger,
                signal: context?.signal ?? new AbortController().signal,
            });
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                ok: true,
                reference: request.data.reference,
                page,
            });
        } catch (error) {
            const code = isPluginError(error) ? error.code : 'composer_reference_unavailable';
            const reason = code === 'plugin_generation_stale'
                ? 'stale_generation'
                : code === 'composer_reference_not_current'
                    ? 'not_current'
                    : 'unavailable';
            return DaemonPluginComposerReferenceSearchResponseSchema.parse({ ok: false, code, reason });
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, async (raw: unknown) => {
        const request = DaemonPluginUiResourceWatchOpenRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                ok: false,
                code: 'plugin_resource_request_invalid',
                reason: 'invalid_payload',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            if (!lease.registry.openUiResourceWatch || typeof lease.registry.generation !== 'number') {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_service_unavailable',
                    reason: 'unavailable',
                });
            }
            // Caller-scoped by construction, exactly like the snapshot read: the
            // watch owner binds the resource service to the host-stamped calling
            // plugin, so a reference naming another plugin is not declared.
            if (request.data.resource.pluginId !== request.data.callerPluginId) {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_not_found',
                    reason: 'not_found',
                });
            }
            const opened = await lease.registry.openUiResourceWatch({
                expectedGeneration: String(lease.registry.generation),
                callerPluginId: request.data.callerPluginId,
                subscriptionId: request.data.subscriptionId,
                resourceId: request.data.resource.localId,
                ...(request.data.context === undefined ? {} : { context: request.data.context }),
            });
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            return DaemonPluginUiResourceWatchOpenResponseSchema.parse({ ok: true, ...opened });
        } catch (error) {
            return DaemonPluginUiResourceWatchOpenResponseSchema.parse(
                readPluginUiResourceWatchFailure(error),
            );
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, async (raw: unknown, context) => {
        const request = DaemonPluginUiResourceWatchNextRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                ok: false,
                code: 'plugin_resource_request_invalid',
                reason: 'invalid_payload',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            if (!lease.registry.pollUiResourceWatch || typeof lease.registry.generation !== 'number') {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_service_unavailable',
                    reason: 'unavailable',
                });
            }
            const polled = await lease.registry.pollUiResourceWatch({
                expectedGeneration: String(lease.registry.generation),
                callerPluginId: request.data.callerPluginId,
                subscriptionId: request.data.subscriptionId,
                ...(request.data.waitMs === undefined ? {} : { waitMs: request.data.waitMs }),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (!(await isExpectedProjectionGenerationCurrent(opts, request.data.expectedGeneration))) {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                    reason: 'stale_generation',
                });
            }
            return DaemonPluginUiResourceWatchNextResponseSchema.parse(
                polled.status === 'event'
                    ? { ok: true, status: 'event', event: polled.event }
                    : { ok: true, status: 'idle' },
            );
        } catch (error) {
            return DaemonPluginUiResourceWatchNextResponseSchema.parse(
                readPluginUiResourceWatchFailure(error),
            );
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, async (raw: unknown) => {
        const request = DaemonPluginUiResourceWatchCloseRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginUiResourceWatchCloseResponseSchema.parse({ ok: true, closed: false });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const closed = lease.registry.closeUiResourceWatch?.({
                callerPluginId: request.data.callerPluginId,
                subscriptionId: request.data.subscriptionId,
            }) === true;
            return DaemonPluginUiResourceWatchCloseResponseSchema.parse({ ok: true, closed });
        } catch {
            // Retirement is best effort: the daemon-side owner already fences a
            // subscription whose generation or plugin consumer went away.
            return DaemonPluginUiResourceWatchCloseResponseSchema.parse({ ok: true, closed: false });
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
        let releaseLease = true;
        try {
            const projectionGeneration = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
            if (String(projectionGeneration) !== request.data.expectedGeneration) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                });
            }
            const invocation = request.data.invocation;
            // Keep the supported RPC spelling at this ingress seam. All
            // canonical Action-domain consumers receive invocationSurface.
            const invocationSurface = request.data.executionSurface;
            const resolvedAction = lease.registry.contributes.actionsById?.get(
                request.data.qualifiedActionId,
            );
            if (
                invocation === undefined
                && actionRequiresHostPresentedInvocation(resolvedAction)
            ) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_unavailable',
                });
            }
            if (
                (invocation?.kind === 'hostPresentedComposer'
                    || invocation?.kind === 'hostPresentedMessage')
                && !isHostPresentedActionInvocationAvailable(resolvedAction, invocation)
            ) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_unavailable',
                });
            }
            let defaultSessionId = request.data.sessionId;
            let messageAction: Extract<MessageActionResolutionV1, { status: 'available' }>['snapshot'] | undefined;
            if (request.data.messageActionReference) {
                const resolution = opts?.resolveMessageActionReference
                    ? await opts.resolveMessageActionReference({
                        reference: request.data.messageActionReference,
                        ...(context?.signal ? { signal: context.signal } : {}),
                    })
                    : { status: 'unavailable' as const };
                if (resolution.status !== 'available') {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                        ok: false,
                        code: 'plugin_message_action_unavailable',
                    });
                }
                if (
                    request.data.sessionId !== undefined
                    && request.data.sessionId !== resolution.snapshot.sessionId
                ) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                        ok: false,
                        code: 'plugin_message_action_unavailable',
                    });
                }
                defaultSessionId = resolution.snapshot.sessionId;
                messageAction = resolution.snapshot;
            }
            const mountedCaller = await deriveMountedPluginInvocationCaller({
                request: {
                    machineId: request.data.machineId,
                    invocationSurface,
                    ...(request.data.invocation ? { invocation: request.data.invocation } : {}),
                },
                registry: lease.registry,
                resolveCurrentPluginMaterializationRef:
                    lease.resolveCurrentPluginMaterializationRef,
                options: opts,
            });
            if (mountedCaller.status === 'unavailable') {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_mounted_caller_unavailable',
                });
            }
            const selectedActionInputCarrier = invocation?.kind === 'mountedPluginSurface'
                ? request.data.selectedActionInputCarrier
                : undefined;
            if (selectedActionInputCarrier !== undefined) {
                const mountedPluginId = mountedCaller.status === 'available'
                    ? mountedCaller.caller.pluginId
                    : undefined;
                const currentMountedGeneration = mountedPluginId === undefined
                    ? undefined
                    : lease.registry.contributes.immutableGenerationIdsByPluginId?.[mountedPluginId];
                if (
                    mountedCaller.status !== 'available'
                    || selectedActionInputCarrier.result.selection.target.pluginId !== mountedPluginId
                    || selectedActionInputCarrier.result.selection.target.immutableGenerationId
                        !== currentMountedGeneration
                ) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                        ok: false,
                        code: 'plugin_selected_action_input_unavailable',
                    });
                }
                // The relay is only for a target-owned management Action.
                // The carrier cannot be attached to another plugin's outer
                // Action and rely on a later nested check after that Action
                // has already observed/effected the request.
                const outerAction = lease.registry.contributes.actionsById?.get(
                    request.data.qualifiedActionId,
                );
                if (!outerAction || outerAction.pluginId !== mountedPluginId) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                        ok: false,
                        code: 'plugin_selected_action_input_unavailable',
                    });
                }
                let mountedCallerCurrent = false;
                try {
                    mountedCallerCurrent = await mountedCaller.isMountedCallerCurrent();
                } catch {
                    // A carrier is valid only for the live mounted UI caller
                    // that selected it. Failure to re-read cannot authorize
                    // even the outer target-management Action.
                }
                if (!mountedCallerCurrent) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                        ok: false,
                        code: 'plugin_mounted_caller_unavailable',
                    });
                }
            }
            const trackedOperation = resolvedAction?.definition.execution?.target === 'daemon'
                ? resolvedAction.definition.operation
                : undefined;
            let preparedTrackedInvocation: Readonly<{
                run(operationProgress?: Readonly<{ update(progress: Readonly<{
                    label?: string; phase?: string; current?: number; total?: number;
                }>): void }>): Promise<unknown>;
            }> | null = null;
            const attempt = await executePluginActionIfAvailable({
                runtimeRegistry: lease.registry,
                actionId: request.data.qualifiedActionId,
                ...(request.data.input === undefined ? {} : { input: request.data.input }),
                ...(request.data.expectedContributorImmutableGenerationId === undefined
                    ? {}
                    : {
                        expectedContributorImmutableGenerationId:
                            request.data.expectedContributorImmutableGenerationId,
                    }),
                ...(opts?.requestCurrentIntent
                    ? { requestCurrentIntent: opts.requestCurrentIntent }
                    : {}),
                context: {
                    // The canonical contributed-Action owner derives the target
                    // plugin surface from authenticated caller identity. This
                    // adapter supplies only the actual UI execution origin.
                    surface: invocationSurface,
                    invocationSurface,
                    ...(mountedCaller.status === 'available'
                        ? {
                            caller: mountedCaller.caller,
                            isMountedCallerCurrent: mountedCaller.isMountedCallerCurrent,
                        }
                        : {}),
                    ...(selectedActionInputCarrier
                        ? { selectedActionInputCarrier }
                        : {}),
                    ...(defaultSessionId ? { defaultSessionId } : {}),
                    ...(messageAction ? { messageAction } : {}),
                    ...(context?.signal && !(trackedOperation && opts?.observePluginExecution)
                        ? { signal: context.signal }
                        : {}),
                    ...(context?.localActionContext?.operationProgress
                        ? { operationProgress: context.localActionContext.operationProgress }
                        : {}),
                    ...(trackedOperation && opts?.observePluginExecution
                        ? {
                            capturePreparedInvocation: (invocation) => {
                                preparedTrackedInvocation = invocation;
                            },
                        }
                        : {}),
                },
            });
            if (!attempt.matched) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_unavailable',
                });
            }
            if (trackedOperation && opts?.observePluginExecution) {
                if (!attempt.result.ok || !preparedTrackedInvocation || !resolvedAction) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(
                        attempt.result.ok
                            ? { ok: false, code: 'plugin_action_unavailable' }
                            : { ok: false, code: attempt.result.errorCode },
                    );
                }
                const rawTitle = resolvedAction.definition.title;
                const title = typeof rawTitle === 'string'
                    ? rawTitle
                    : (rawTitle as Readonly<{ fallback: string }>).fallback;
                const observed = await opts.observePluginExecution({
                    actionId: request.data.qualifiedActionId,
                    title,
                    operation: trackedOperation,
                    input: request.data.input,
                    ...(request.data.requestId ? { requestId: request.data.requestId } : {}),
                    ...(request.data.sessionId ? { sessionId: request.data.sessionId } : {}),
                    execute: async ({ operationProgress }) => {
                        const rawResult = await preparedTrackedInvocation!.run(operationProgress);
                        const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
                            ? rawResult as Record<string, unknown>
                            : {};
                        if (result.ok === true) return { ok: true, result: result.result };
                        const errorCode = typeof result.errorCode === 'string'
                            ? result.errorCode
                            : 'plugin_action_execution_failed';
                        return { ok: false, errorCode, error: errorCode };
                    },
                });
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(
                    observed.ok
                        ? { ok: true, result: observed.result }
                        : { ok: false, code: observed.errorCode },
                );
            }
            if (attempt.result.ok) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: true,
                    result: attempt.result.result,
                });
            }
            const authorPayload = readPluginActionFailureAuthorPayload(attempt.result.data);
            return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                ok: false,
                code: attempt.result.errorCode,
                ...(attempt.result.retryable === undefined
                    ? {}
                    : { retryable: attempt.result.retryable }),
                ...(authorPayload.remediation === undefined
                    ? {}
                    : { remediation: authorPayload.remediation }),
            });
        } finally {
            if (releaseLease) await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE, async (raw: unknown, context) => {
        const request = DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                ok: false,
                code: 'plugin_action_form_connected_account_options_request_invalid',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const resolveGeneration = opts?.resolveGeneration ?? defaultResolveGeneration;
            const beforeGeneration = await resolveGeneration();
            if (String(beforeGeneration) !== request.data.expectedGeneration) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                });
            }
            const resolveOptionalAccess = (pluginId: string) => (
                lease.registry.resolveOptionalAccess?.(pluginId) ?? Object.freeze([])
            );
            const authorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
                registry: lease.registry.contributes,
                qualifiedActionId: request.data.qualifiedActionId,
                fieldPath: request.data.fieldPath,
                resolveOptionalAccess,
            });
            if (
                !authorization
                || !isCurrentConnectedAccountActionFormTarget(
                    lease.registry,
                    authorization.action,
                )
            ) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_form_connected_account_options_unavailable',
                });
            }
            let runtime: Pick<DaemonConnectedAccountPurposeBindingRuntime, 'listActionFormConnectedAccountOptions'> | null;
            try {
                runtime = opts?.resolveConnectedAccountPurposeBindingRuntime?.() ?? null;
            } catch {
                runtime = null;
            }
            if (!runtime) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_form_connected_account_options_unavailable',
                });
            }
            const options = await runtime.listActionFormConnectedAccountOptions({
                purpose: authorization.purpose,
                serviceRefs: authorization.serviceRefs,
                signal: context?.signal ?? new AbortController().signal,
            });
            const afterGeneration = await resolveGeneration();
            const currentAuthorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
                registry: lease.registry.contributes,
                qualifiedActionId: request.data.qualifiedActionId,
                fieldPath: request.data.fieldPath,
                resolveOptionalAccess,
            });
            if (
                String(afterGeneration) !== request.data.expectedGeneration
                || !currentAuthorization
                || currentAuthorization.action.pluginId !== authorization.action.pluginId
                || currentAuthorization.action.localId !== authorization.action.localId
                || currentAuthorization.purpose.purpose !== authorization.purpose.purpose
                || !sameConnectedAccountServiceRefs(
                    currentAuthorization.serviceRefs,
                    authorization.serviceRefs,
                )
                || !isCurrentConnectedAccountActionFormTarget(
                    lease.registry,
                    currentAuthorization.action,
                )
            ) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_generation_stale',
                });
            }
            return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                ok: true,
                options,
            });
        } catch (error) {
            return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                ok: false,
                code: isPluginError(error)
                    ? error.code
                    : 'plugin_action_form_connected_account_options_unavailable',
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
            if (request.data.artifactFamily === 'reactNative') {
                let targetedSurfaceSnapshots: readonly MountedTargetedContributionSnapshot[] | undefined;
                if (request.data.artifactOwnerKind === 'renderer') {
                    try {
                        targetedSurfaceSnapshots = readTargetedSurfaceSnapshotsForCrashToken(
                            lease.registry,
                            request.data.crashStateToken,
                        );
                    } catch {
                        return artifactBytesError(
                            'crash_state_token_mismatch',
                            ['react_native_crash_state_token_mismatch'],
                        );
                    }
                }
                const projectionInput = {
                    registry: lease.registry.contributes,
                    generation,
                    ...(request.data.reactNativeHostRuntimeIdentity
                        ? { reactNativeHostRuntimeIdentity: request.data.reactNativeHostRuntimeIdentity }
                        : {}),
                    ...(request.data.reactNativeWebLoaderCapability
                        ? { reactNativeWebLoaderCapability: request.data.reactNativeWebLoaderCapability }
                        : {}),
                    ...(targetedSurfaceSnapshots ? { targetedSurfaceSnapshots } : {}),
                };
                // Voice uses the generated Artifact graph but has no renderer
                // crash lifecycle. Resolve its normal runtime facts without
                // touching durable renderer crash-state reconciliation.
                const basePluginUiHostRuntime = await resolveProjectionHostRuntime(opts, projectionInput);
                if (basePluginUiHostRuntime.reactNativeBundles?.featureEnabled !== true) {
                    return artifactBytesError('artifact_unavailable', ['feature_disabled']);
                }
                if (request.data.cacheIdentity.projectionGeneration !== generation) {
                    return artifactBytesError('artifact_not_found', ['react_native_projection_generation_mismatch']);
                }
                const projectedClientAction = request.data.artifactOwnerKind === 'clientContribution'
                    ? await readCurrentProjectedClientActionArtifact({
                        opts,
                        registry: lease.registry.contributes,
                        generation,
                        pluginUiHostRuntime: basePluginUiHostRuntime,
                        requestMachineId: request.data.machineId,
                        action: request.data.clientContribution.action,
                    })
                    : null;
                if (request.data.artifactOwnerKind === 'clientContribution' && !projectedClientAction) {
                    return artifactBytesError(
                        'artifact_unavailable',
                        ['client_contribution_execution_origin_unavailable'],
                    );
                }
                const owner = request.data.artifactOwnerKind === 'clientContribution'
                    ? findResolvedGeneratedReactNativeClientContributionArtifactOwner({
                        registry: lease.registry.contributes,
                        action: request.data.clientContribution.action,
                    })
                    : findResolvedGeneratedReactNativeArtifactOwner({
                        registry: lease.registry.contributes,
                        pluginId: request.data.cacheIdentity.pluginId,
                        contributionId: request.data.cacheIdentity.contributionId,
                    });
                const collectionMigrations = request.data.artifactOwnerKind === 'collectionMigrations'
                    && owner?.kind === 'renderer'
                    ? findGeneratedReactNativeCollectionMigrationsModule({
                        owner,
                        platform: request.data.cacheIdentity.platform,
                    })
                    : null;
                const ownerMatchesRequest = owner !== null && (
                    request.data.artifactOwnerKind === 'clientContribution'
                        ? owner.kind === 'clientContribution'
                            && projectedClientAction !== null
                            && owner.pluginId === request.data.clientContribution.action.pluginId
                            && owner.contributionId === request.data.clientContribution.action.localId
                            && owner.artifactId === projectedClientAction.execution.client.artifactId
                            && owner.expectedRepackModule.modulePath
                                === projectedClientAction.execution.client.modulePath
                            && owner.expectedRepackModule.exportName
                                === projectedClientAction.execution.client.exportName
                            && projectedClientAction.execution.platforms.includes(
                                request.data.cacheIdentity.platform as 'web' | 'ios' | 'android',
                            )
                        : request.data.artifactOwnerKind === 'collectionMigrations'
                        ? collectionMigrations?.entry != null
                        : owner.kind === request.data.artifactOwnerKind
                );
                if (!ownerMatchesRequest || !owner) {
                    return artifactBytesError(
                        'artifact_not_found',
                        [collectionMigrations?.failure ?? 'generated_react_native_artifact_owner_not_found'],
                    );
                }
                const pluginUiHostRuntime = request.data.artifactOwnerKind === 'renderer'
                    ? await resolveProjectionHostRuntimeWithCrashState(opts, projectionInput)
                    : basePluginUiHostRuntime;
                const generatedRead = {
                    registry: lease.registry.contributes,
                    owner,
                    identity: request.data.cacheIdentity,
                    generation,
                    pluginUiHostRuntime,
                    ...(opts?.readArtifactFile ? { readArtifactFile: opts.readArtifactFile } : {}),
                };
                const response = request.data.artifactOwnerKind === 'renderer'
                    ? await readGeneratedReactNativeArtifactBytesByCacheIdentity({
                        ...generatedRead,
                        artifactOwnerKind: 'renderer',
                        crashStateToken: request.data.crashStateToken,
                    })
                    : request.data.artifactOwnerKind === 'clientContribution'
                        ? await readGeneratedReactNativeArtifactBytesByCacheIdentity({
                            ...generatedRead,
                            artifactOwnerKind: 'clientContribution',
                            clientContribution: request.data.clientContribution,
                            projectedClientAction: projectedClientAction!,
                        })
                    : await readGeneratedReactNativeArtifactBytesByCacheIdentity({
                        ...generatedRead,
                        artifactOwnerKind: request.data.artifactOwnerKind,
                    });
                if (!response.ok) return response;

                if (request.data.artifactOwnerKind === 'renderer') {
                    // The bytes may have been read while another UI report crossed
                    // the daemon lock. Reconcile and require the same exact token
                    // again before returning executable cached bytes.
                    const recheckedHostRuntime = await resolveProjectionHostRuntimeWithCrashState(opts, projectionInput);
                    const rechecked = readCurrentReactNativeCrashStateForToken({
                        pluginUiHostRuntime: recheckedHostRuntime,
                        token: request.data.crashStateToken,
                    });
                    if (!rechecked) {
                        return artifactBytesError('crash_state_token_mismatch', ['react_native_crash_state_token_mismatch']);
                    }
                    if (rechecked.disabled) {
                        return artifactBytesError('artifact_unavailable', ['crash_threshold_reached']);
                    }
                }
                if (request.data.artifactOwnerKind === 'clientContribution') {
                    const currentGeneration = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
                    if (currentGeneration !== generation) {
                        return artifactBytesError(
                            'artifact_unavailable',
                            ['client_contribution_projection_generation_stale'],
                        );
                    }
                    const rechecked = await readCurrentProjectedClientActionArtifact({
                        opts,
                        registry: lease.registry.contributes,
                        generation,
                        pluginUiHostRuntime: basePluginUiHostRuntime,
                        requestMachineId: request.data.machineId,
                        action: request.data.clientContribution.action,
                    });
                    if (
                        !rechecked
                        || rechecked.origin.serverIdentityId
                            !== projectedClientAction!.origin.serverIdentityId
                        || rechecked.origin.materializationRef.machineId
                            !== projectedClientAction!.origin.materializationRef.machineId
                        || rechecked.origin.materializationRef.materializationId
                            !== projectedClientAction!.origin.materializationRef.materializationId
                        || rechecked.origin.materializationRef.pluginId
                            !== projectedClientAction!.origin.materializationRef.pluginId
                        || rechecked.execution.client.artifactId
                            !== projectedClientAction!.execution.client.artifactId
                        || rechecked.execution.client.modulePath
                            !== projectedClientAction!.execution.client.modulePath
                        || rechecked.execution.client.exportName
                            !== projectedClientAction!.execution.client.exportName
                        || rechecked.execution.platforms.join('\u0000')
                            !== projectedClientAction!.execution.platforms.join('\u0000')
                    ) {
                        return artifactBytesError(
                            'artifact_unavailable',
                            ['client_contribution_execution_origin_stale'],
                        );
                    }
                }
                if (!await isArtifactProjectionPairCurrent({ opts, registry: lease.registry, generation })) {
                    return artifactBytesError(
                        'artifact_unavailable',
                        ['artifact_projection_pair_stale'],
                    );
                }
                return response;
            }

            const pluginUiHostRuntime = await resolveProjectionHostRuntime(opts);
            const response = await readHostedWebArtifactBytesByCacheIdentity({
                registry: lease.registry.contributes,
                identity: request.data.cacheIdentity,
                generation,
                pluginUiHostRuntime,
                ...(opts?.readArtifactFile ? { readArtifactFile: opts.readArtifactFile } : {}),
            });
            if (
                response.ok
                && !await isArtifactProjectionPairCurrent({ opts, registry: lease.registry, generation })
            ) {
                return artifactBytesError(
                    'artifact_unavailable',
                    ['artifact_projection_pair_stale'],
                );
            }
            return response;
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_REACT_NATIVE_CRASH_REPORT_SUBMIT, async (raw: unknown) =>
        await recordReactNativeCrashReportFromProjection(opts, raw));
}
