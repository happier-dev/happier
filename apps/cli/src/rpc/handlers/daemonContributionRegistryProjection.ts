import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DaemonPluginUiCaptureSourceReadRequestSchema, DaemonPluginUiCaptureSourceReadResponseSchema } from '@happier-dev/protocol/daemon/pluginCaptureSources';
import type { MachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';
import { registerPluginCaptureSource } from '@/daemon/peer/mediation/stream/pluginCaptureSource';
import { DaemonPluginStoredImageReadRequestSchema, DaemonPluginStoredImageReadResponseSchema } from '@happier-dev/protocol/daemon/pluginStoredImage';

import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { readPluginSkills } from '@/prompts/skills/library/readPluginSkills';
import { PluginSkillLibraryContentV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { skillsProjectionFamily } from '@/plugins/projection/registry/skills';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema, DaemonPluginUiTargetedSurfaceMountV1Schema, DaemonPluginSettingsGetRequestSchema, DaemonPluginSettingsGetResponseSchema, DaemonPluginSettingsSetRequestSchema, DaemonPluginSettingsSetResponseSchema, DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS, DaemonPluginSecretStatusRequestSchema, DaemonPluginSecretStatusResponseSchema, DaemonPluginSecretSetRequestSchema, DaemonPluginSecretSetResponseSchema, DaemonPluginSecretDeleteRequestSchema, DaemonPluginSecretDeleteResponseSchema, DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema, DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseRequestSchema, DaemonPluginUiResourceWatchCloseResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema, DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema, DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema, DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema, DaemonPluginComposerReferenceSearchRequestSchema, DaemonPluginComposerReferenceSearchResponseSchema, DaemonPluginUiArtifactBytesReadRequestSchema, DaemonPluginUiArtifactBytesReadResponseSchema, PluginUiResourceBindingCapabilityV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { DaemonPluginSettingsSnapshot, FeatureDecision, DaemonHostedWebFrameCapabilityV1, DaemonReactNativeHostRuntimeIdentityV1, ActionOperationDeclarationV1, DaemonContributionRegistryProjectionDescribeRequest, DaemonContributionRegistryProjectionDescribeResponse, DaemonPluginUiTargetedContributionsReadRequest, DaemonPluginUiTargetedContributionsReadResponse, PluginSettingFieldV2, DaemonPluginUiArtifactBytesReadResponse, DaemonPluginUiTargetedSurfaceMountV1, DaemonPluginStructuredMessageActionInvocationV1, MessageActionReferenceV1, MessageActionResolutionV1, PluginMachineExecutionOriginV1, PluginProjectionBrandAssetV2, PluginProjectionV2 } from '@happier-dev/protocol';
import { resolvePluginMachineExecutionOrigin } from '@/plugins/runtime/resolvePluginMachineExecutionOrigin';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readPluginSettingSecretCustody } from '@happier-dev/protocol/plugins/contributions/settings';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    isPluginError,
    PluginError,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import { computePluginUiArtifactSha256DigestV1, isPluginUiHermesBytecodeArtifactV1, verifyPluginUiArtifactFileSetIntegrityV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { PluginUiSurfaceBindingV1Schema, selectPluginUiRendererChainMemberV1 } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import { projectPluginUiTargetedContributionIdentityV1, projectPluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import type { PluginUiArtifactDigestV1, PluginUiArtifactsManifestEntryV2, PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { DaemonPluginSettingsWatchRequestSchema, DaemonPluginSettingsWatchResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { DaemonPluginSettingsWatchResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonContributionRegistryProjectionDescribeUnchangedResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildDaemonProjectionSections, buildDeferredDaemonProjectionSections, omitKnownDaemonProjectionSectionBodies, DAEMON_PROJECTION_SECTION_STALE_CODE,
    type DaemonContributionRegistryProjectionSectionsResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonPluginTargetedSourceDeclarationV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonPluginUiResourceDeclarationsByPluginIdV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginSourceCustodyEqual } from '@/plugins/runtime/sourceAuthority';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type {
    TargetActionCurrentIntentRequest,
    TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type {
    AdmittedTargetedContributionSnapshot,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
    buildAgentsById,
    buildResourcesById,
    buildPluginConnectedAccountAdmissionProjectionV2,
    buildPluginSettingsProjectionV2,
    buildPluginProjectionV2,
} from '@/plugins/projection/registry/projection/v2';
import {
    projectDaemonEmbeddedPluginUiRenderer,
    projectDaemonComposerSurfaceCatalog,
} from '@/plugins/projection/registry/composer';
import {
    adaptTargetActivationFacts,
    type PluginTargetActivationIntrospectionSnapshot,
} from '@/plugins/projection/introspection/targetActivationFacts';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import {
    resolvePluginUiProjectionHostRuntime,
} from '@/plugins/projection/registry/ui/hostRuntime';
import {
    pluginUiProjectionFamily,
    projectPluginUiRendererAvailability,
    projectPluginUiRendererRef,
    resolvePluginUiRendererProjectionEntry,
} from '@/plugins/projection/registry/ui/projection';
import {
    findGeneratedHostedWebArtifactEntry,
    collectResolvedGeneratedHostedWebArtifactOwners,
    findGeneratedReactNativeArtifactEntry,
    collectResolvedGeneratedReactNativeArtifactOwners,
    collectResolvedGeneratedReactNativeClientContributionArtifactOwners,
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
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginFinalPolicyCurrentRuntime } from '@/plugins/runtime/policy/facts';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { PluginContextServiceError } from '@/plugins/runtime/context/errors';
import type { DeclaredDaemonPluginSecretAdministrationPort } from '@/plugins/runtime/context/secrets';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { deriveMountedPluginInvocationCaller, type MountedAccountPluginExecutionSelectionResolver } from '@/plugins/runtime/invocation/mountedPluginInvocationCaller';
import {
    assertLocalSettingsDeclarationsAccessible,
    flattenLocalSettingsFields,
    admitLocalSettingsDeclarations,
} from '@/plugins/settings/localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import {
    deriveRegistryConnectedAccountPurposeAuthorizations,
    resolveRegistryConnectedAccountActionFormPurposeAuthorization,
} from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type {
    DaemonConnectedAccountPurposeBindingRuntime,
} from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import {
    registerDaemonPluginCollectionCandidatePreparationHandler,
} from './daemonPluginCollectionCandidatePreparation';

export type DaemonContributionRegistryProjectionRegistrationOptions = Readonly<{
    /** Account caller provenance is read from the captured authenticated Home, never a Machine occurrence. */
    resolveAccountPluginExecutionSelection?: MountedAccountPluginExecutionSelectionResolver;
    /** The connected machine binds approval requests to its current Account custody. */
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
    resolveCaptureRegistry?: () => MachineLiveStreamCaptureRegistry | null;
    resolveRegistry?: () => Promise<ResolvedContributionRegistry>;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    resolveInstalledPackages?: () => Promise<readonly PluginCatalogEntry[]>;
    resolveGeneration?: () => Promise<number>;
    /** Genuine filesystem boundary used by focused Artifact-read race tests. */
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
    resolveHostedWebFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
    resolveReactNativeBundlesFeatureDecision?: () => Promise<FeatureDecision> | FeatureDecision;
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
    // G-RC4: the SAME async server-features provider shape as the inventory/quotas/browser gates.
    // Threaded so the four plugin-UI-tier fallback decisions resolve against the live server
    // snapshot — a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the
    // projection (master §3.5 "server disables X → daemon refuses").
    resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
    processEnv?: NodeJS.ProcessEnv;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
    observePluginExecution?: (request: Readonly<{
        actionId: string;
        title: string;
        operation: ActionOperationDeclarationV1;
        input: unknown;
        requestId?: string;
        sessionId?: string;
        rpcContext?: RpcHandlerContext;
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

function projectStructuredMessageActionFailure(result: Readonly<{
    errorCode: string;
    error: string;
    retryable?: boolean;
    data?: JsonValue;
}>) {
    const authorPayload = readPluginActionFailureAuthorPayload(result.data);
    // Target invocation already redacts its failures; the same canonical
    // projection also covers an operation observer's own thrown failure.
    const message = result.error.trim();
    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
        ok: false,
        code: result.errorCode,
        ...(message && message !== result.errorCode
            ? { message: projectPluginFailureText(new Error(message)) }
            : {}),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(authorPayload.remediation === undefined ? {} : { remediation: authorPayload.remediation }),
    });
}

/**
 * One built describe response, keyed by everything the build reads:
 * the registry generation, the client context (locale, host runtime and
 * feature decisions), brand assets, execution origins and applied policy.
 */
type ProjectionBuild = Readonly<{
    inputKey: string;
    response: DaemonContributionRegistryProjectionDescribeResponse;
    readSections?: () => DaemonContributionRegistryProjectionSectionsResponse;
    readDeferredSections?: () => ReturnType<typeof buildDeferredDaemonProjectionSections>;
}>;

/**
 * One complete build per handler/output context and selection. Manifest reads
 * replace changed inputs; section pages finish the last advertised build.
 */
const defaultProjectionBuildScope = {};
const projectionBuildsByScope = new WeakMap<object, Readonly<{
    complete: Map<string, ProjectionBuild>;
    /** Share exact-input preparation only until it settles; failures are not latched. */
    pending: Map<string, Promise<ProjectionBuild>>;
}>>();
let projectionBuildCacheRevision = 0;
/**
 * The installed-package catalog, derived once per runtime registry rather than
 * re-read from disk per request. A registry is immutable; a plugin change
 * publishes a new one.
 */
const installedPackagesByRuntimeRegistry = new WeakMap<
    ResolvedExecutablePluginRuntimeRegistry,
    Promise<readonly PluginCatalogEntry[]>
>();

export function invalidateDaemonContributionRegistryProjectionCache(): void {
    // Invalidate future manifests without discarding pages already advertised.
    projectionBuildCacheRevision += 1;
}

/**
 * UI/Voice carry the person's settled confirmation. Automated origins ask
 * through the same durable approval owner as other contributed Actions.
 */
function createPresentUserCurrentIntent(
    presentUserIntent: 'confirmed' | undefined,
    requestCurrentIntent: DaemonContributionRegistryProjectionRegistrationOptions['requestCurrentIntent'],
): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
    return async request => {
        const surface = request.invocationSurface ?? request.surface;
        if (surface === 'cli' || surface === 'agent' || surface === 'mcp') {
            request.signal?.throwIfAborted();
            if (!requestCurrentIntent) {
                return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
            }
            return await requestCurrentIntent(request);
        }
        return presentUserIntent === 'confirmed'
            ? { status: 'approved', fingerprint: request.fingerprint }
            : { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    };
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

function isExpectedPluginOccurrenceCurrent(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string | undefined,
    expectedOccurrenceId: string | undefined,
): boolean {
    try {
        if (pluginId === undefined) return false;
        const currentOccurrenceId = registry.readPluginOccurrenceId?.(pluginId)
            ?? registry.contributes.occurrenceIdsByPluginId?.[pluginId]
            ?? null;
        return currentOccurrenceId === expectedOccurrenceId;
    } catch {
        return false;
    }
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

type ProjectionOutputContext = Readonly<{
    selection?: ProjectionClientContext['selection'];
    pluginUiHostRuntime?: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    requestedLocale?: string;
}>;

function createProjectionOutputContext(input: ProjectionOutputContext) {
    const full = input.selection === undefined;
    const hostedWeb = input.pluginUiHostRuntime?.hostedWeb;
    const reactNative = input.pluginUiHostRuntime?.reactNativeBundles;
    return {
        selection: input.selection ?? 'full',
        // Artifact admission consumes physical-frame availability and the Host
        // UI API, rather than the app release/channel or adapter's name.
        pluginUiHostRuntime: full ? {
            hostedWebEnabled: hostedWeb?.featureEnabled === true,
            hostedWebFrameAvailable: hostedWeb?.featureEnabled === true && hostedWeb.frameCapability !== undefined,
            reactNativeBundlesEnabled: reactNative?.featureEnabled === true,
            hostUiApiVersion: reactNative?.hostRuntime?.hostUiApiVersion ?? null,
        } : null,
        requestedLocale: full ? input.requestedLocale ?? null : null,
    };
}

function createProjectionCacheKeyParts(input: Readonly<{
    generation: number;
    registryCacheToken: string;
    selection?: ProjectionClientContext['selection'];
    pluginUiHostRuntime?: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    brandAssetsByPluginId: Readonly<Record<string, PluginProjectionBrandAssetV2>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    pluginFinalPolicyCurrentRuntimesById?: ReadonlyMap<string, PluginFinalPolicyCurrentRuntime>;
    targetActivationFacts?: ProjectionLease['targetActivationFacts'];
    pluginDiagnosticsByPluginId?: ProjectionLease['pluginDiagnosticsByPluginId'];
    /**
     * The projected translation bundles depend on it, so two clients with
     * different display locales must not share one cached body.
     */
    requestedLocale?: string;
}>): Readonly<Record<string, string>> {
    const full = input.selection === undefined;
    const admission = input.selection === 'connectedAccountAdmission';
    const hostedWeb = input.pluginUiHostRuntime?.hostedWeb;
    const reactNative = input.pluginUiHostRuntime?.reactNativeBundles;
    const parts = {
        generation: input.generation,
        registryCacheToken: input.registryCacheToken,
        selection: input.selection ?? 'full',
        // Artifact admission consumes the Host UI API and physical-frame
        // availability, not app release/channel or the frame adapter's name.
        pluginUiHostRuntime: full ? {
            hostedWebEnabled: hostedWeb?.featureEnabled === true,
            hostedWebFrameAvailable: hostedWeb?.featureEnabled === true && hostedWeb.frameCapability !== undefined,
            reactNativeBundlesEnabled: reactNative?.featureEnabled === true,
            hostUiApiVersion: reactNative?.hostRuntime?.hostUiApiVersion ?? null,
        } : null,
        brandAssetsByPluginId: full || admission ? input.brandAssetsByPluginId : null,
        pluginExecutionOriginsByPluginId: full || admission ? input.pluginExecutionOriginsByPluginId : null,
        pluginFinalPolicyCurrentRuntimes: (full || admission) && input.pluginFinalPolicyCurrentRuntimesById
            ? [...input.pluginFinalPolicyCurrentRuntimesById.entries()].sort(([left], [right]) => left.localeCompare(right))
            : [],
        targetActivationFacts: full || admission ? input.targetActivationFacts ?? null : null,
        pluginDiagnosticsByPluginId: full || admission ? input.pluginDiagnosticsByPluginId ?? null : null,
        requestedLocale: full ? input.requestedLocale ?? null : null,
    };
    return Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, JSON.stringify(value)]));
}

/**
 * The key parts of the most recent build, kept only so a build miss can log
 * which part of the key differs from it (diagnostics; never a cache input).
 */
let previousProjectionBuildKeyParts: Readonly<Record<string, string>> | null = null;

function changedProjectionBuildKeyParts(parts: Readonly<Record<string, string>>): readonly string[] {
    const previous = previousProjectionBuildKeyParts;
    previousProjectionBuildKeyParts = parts;
    if (!previous) return ['none-before'];
    return Object.keys(parts).filter((name) => previous[name] !== parts[name]);
}

/** Which kind of client a projection is built for, for the daemon log. */
function projectionClientKind(context: ProjectionClientContext): string {
    if (context.reactNativeHostRuntimeIdentity) {
        return `react-native:${context.reactNativeHostRuntimeIdentity.platform}`;
    }
    if (context.hostedWebFrameCapability) {
        return `${context.hostedWebFrameCapability.platform}:${context.hostedWebFrameCapability.adapter}`;
    }
    return 'unreported';
}

type MountedTargetedContributionSnapshot = Readonly<{
    point: Readonly<{
        pointId: string;
        protocol: Readonly<{ id: string; version: number }>;
    }>;
    snapshot: AdmittedTargetedContributionSnapshot;
}>;

/**
 * The one cold-admission read for a mounted target at its current occurrence.
 * Its callers project public handles and private mounts from these same
 * immutable snapshot objects; this is deliberately not another manifest scan,
 * registry, or activation path. A snapshot that disagrees with the occurrence
 * it was read for is an internal inconsistency, not a caller-visible fence.
 */
function readMountedTargetedContributionSnapshots(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; occurrenceId: string }>;
}>): readonly MountedTargetedContributionSnapshot[] {
    const currentOccurrenceId = input.runtimeRegistry
        .contributes.occurrenceIdsByPluginId?.[input.mountedTarget.pluginId];
    if (currentOccurrenceId !== input.mountedTarget.occurrenceId) {
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
                || snapshot.target.occurrenceId !== input.mountedTarget.occurrenceId
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
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; occurrenceId: string }>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
}>): PluginUiTargetedContributionsV1 {
    return projectPluginUiTargetedContributionsV1({
        target: input.mountedTarget,
        snapshots: input.snapshots,
        readSourceCustody: (pluginId) => readTargetedContributionSourceCustody(input.runtimeRegistry, pluginId),
    });
}

function projectTargetedContributionIdentity<
    TIdentity extends Readonly<{ pluginId: string; occurrenceId: string }>,
>(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    identity: TIdentity,
): TIdentity & Readonly<{
    sourceCustody: NonNullable<ReturnType<
        NonNullable<ResolvedExecutablePluginRuntimeRegistry['readPluginSourceCustody']>
    >>;
}> {
    return projectPluginUiTargetedContributionIdentityV1({
        identity,
        readSourceCustody: (pluginId) => readTargetedContributionSourceCustody(runtimeRegistry, pluginId),
    });
}

function readTargetedContributionSourceCustody(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string,
) {
    const sourceCustody = runtimeRegistry.readPluginSourceCustody?.(pluginId);
    if (!sourceCustody) {
        throw new PluginError({
            code: 'plugin_targeted_contributions_unavailable',
            message: `Targeted contribution source custody is unavailable for '${pluginId}'`,
        });
    }
    return sourceCustody;
}

/**
 * Projects only the runtime registry's already-admitted target snapshots for
 * one exact occurrence; declarations supply the bounded point/protocol
 * inventory, while the canonical reader supplies every contribution and never
 * activates a plugin.
 */
function readMountedTargetedContributionsProjection(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; occurrenceId: string }>;
    snapshots?: readonly MountedTargetedContributionSnapshot[];
}>): PluginUiTargetedContributionsV1 {
    return projectMountedTargetedContributionSnapshots({
        runtimeRegistry: input.runtimeRegistry,
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
 * snapshots and the same client's renderer projection. The consumer
 * receives the producer-selected renderer, never a second renderer lookup or
 * fallback decision path.
 */
function readMountedTargetedSurfaceMountsProjection(input: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    mountedTarget: Readonly<{ pluginId: string; occurrenceId: string }>;
    snapshots: readonly MountedTargetedContributionSnapshot[];
    entriesById: Parameters<typeof resolvePluginUiRendererProjectionEntry>[0]['entriesById'];
    pluginUiHostRuntime: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    modelsByRendererKey: Readonly<Record<string, import('@/plugins/runtime/invocation/services/declarativeModel').StablePluginDeclarativeModel | undefined>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
}>): readonly DaemonPluginUiTargetedSurfaceMountV1[] {
    const entriesById = input.entriesById;
    const mounts: DaemonPluginUiTargetedSurfaceMountV1[] = [];
    for (const { point, snapshot } of input.snapshots) {
        for (const contribution of snapshot.contributions) {
            if (contribution.surfaces.length === 0) continue;
            const executionOrigin = input.pluginExecutionOriginsByPluginId[contribution.contributor.pluginId];
            if (!executionOrigin) {
                throw new PluginError({
                    code: 'plugin_targeted_surface_mount_unavailable',
                    message: `Targeted Surface execution origin is unavailable for '${contribution.contributor.pluginId}'`,
                });
            }
            const contributorTargetedContributions = readMountedTargetedContributionsProjection({
                runtimeRegistry: input.runtimeRegistry,
                mountedTarget: {
                    pluginId: contribution.contributor.pluginId,
                    occurrenceId: contribution.contributor.occurrenceId,
                },
            });
            for (const surface of contribution.surfaces) {
                const mount = Object.freeze({
                    kind: 'targetedSurface' as const,
                    target: projectTargetedContributionIdentity(
                        input.runtimeRegistry,
                        input.mountedTarget,
                    ),
                    point: Object.freeze({
                        pointId: point.pointId,
                        protocol: Object.freeze({ ...point.protocol }),
                    }),
                    contributor: projectTargetedContributionIdentity(
                        input.runtimeRegistry,
                        surface.contributor,
                    ),
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
                    const artifactProjection = resolvePluginUiRendererProjectionEntry({
                        pluginId: contribution.contributor.pluginId,
                        renderer: rendererProjection.registryRendererRef,
                        entriesById,
                    });
                    return Object.freeze({
                        renderer,
                        rendererRef: rendererProjection.rendererRef,
                        availability,
                        ...(artifactProjection ? { artifactProjection } : {}),
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
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null,
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

    // Availability qualifies source eligibility; the admitted runtime custody
    // supplies source identity. Actual install-registry ids retain precedence.
    const materializationIdsByPluginId = {
        ...Object.fromEntries((runtimeRegistry?.readReleaseLessMaterializations?.() ?? [])
            .filter((materialization) => materialization.enabled
                && materialization.trustState === 'trusted'
                && runtimeRegistry?.readPluginOccurrenceId?.(materialization.pluginId))
            .map(({ pluginId, materializationId }) => [pluginId, materializationId] as const)),
        ...(registry.materializationIdsByPluginId ?? {}),
    };
    const originsByPluginId: Record<string, PluginMachineExecutionOriginV1> = {};
    for (const pluginId of Object.keys(materializationIdsByPluginId)) {
        const origin = resolvePluginMachineExecutionOrigin({
            pluginId,
            context,
            materializationId: registry.materializationIdsByPluginId?.[pluginId],
            sourceCustody: runtimeRegistry?.readPluginSourceCustody?.(pluginId),
        });
        if (origin) originsByPluginId[pluginId] = origin;
    }
    return Object.freeze(originsByPluginId);
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
    invocation: Extract<
        DaemonPluginStructuredMessageActionInvocationV1,
        Readonly<{ kind: 'hostPresentedComposer' | 'hostPresentedMessage' }>
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
        hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
    }>,
): Promise<ReturnType<typeof resolvePluginUiProjectionHostRuntime>> {
    const reactNativeHostRuntime = params?.reactNativeHostRuntimeIdentity
        ? toReactNativeHostRuntimeReadinessIdentity(params.reactNativeHostRuntimeIdentity)
        : opts?.reactNativeHostRuntime;
    // G-RC4: resolve the server-features snapshot once per host-runtime resolve and thread it into
    // every plugin-UI-tier fallback decision so a server that disables `plugins`/`plugins.ui`
    // cascades the tiers OFF in the projection. A missing/failed provider keeps the tiers
    // fail-closed (the decisions still resolve, just snapshot-less ⇒ client-fail-closed default).
    const serverFeaturesSnapshot = await resolveProjectionServerFeaturesSnapshot(opts);
    return resolvePluginUiProjectionHostRuntime({
        hostAppVersion: configuration.currentCliVersion,
        hostedWebFeatureDecision: await resolveHostedWebFeatureDecision(opts, serverFeaturesSnapshot),
        reactNativeBundlesFeatureDecision: await resolveReactNativeBundlesFeatureDecision(opts, serverFeaturesSnapshot),
        ...(reactNativeHostRuntime
            ? { reactNativeHostRuntime }
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
        platform: identity.platform,
        channel: identity.channel,
    });
}

async function acquireProjectionRuntimeRegistryLease(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
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

    return await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir,
    });
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
    // Forms consume an admitted declaration before any Action effect. A cold
    // plugin has no applied handler yet; requiring one prevents its setup form
    // from selecting the very account that invocation needs. Occurrence and
    // declared Connected Account access are revalidated by the caller.
    const occurrenceId = registry.readPluginOccurrenceId?.(action.pluginId);
    return occurrenceId != null
        && registry.isPluginOccurrenceCurrent?.(action.pluginId, occurrenceId) === true
        && registry.targetActionInvocations?.expects(action.pluginId, action.localId) === true;
}

function readPluginSettingsDeclaration(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    pluginId: string,
    machineId: string,
    scope: DaemonPluginSettingsSnapshot['scope'],
): Readonly<{
    fields: readonly PluginSettingFieldV2[];
}> {
    const admission = admitLocalSettingsDeclarations({
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
    const { declarations } = admission;
    if (declarations.length === 0 && admission.errors[0]) throw admission.errors[0];
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
    const leaseRuntimeRegistry = async () => {
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        return {
            registry: lease.registry.contributes,
            pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
            targetActivationFacts: lease.registry.targetActivationFacts ?? null,
            runtimeRegistry: lease.registry,
            cacheToken: `runtime:${generation}`,
            release: lease.release,
        };
    };
    if (opts?.resolveRuntimeRegistry || requireRuntimeRegistry) return await leaseRuntimeRegistry();

    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    if (pluginReloadController.getState().activeRegistry) return await leaseRuntimeRegistry();

    const registry = await (opts?.resolveRegistry ?? defaultResolveRegistry)();
    if (
        (registry.scmBackends?.length ?? 0) > 0
        || (registry.scmHostingProviders?.length ?? 0) > 0
    ) {
        return await leaseRuntimeRegistry();
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

type ProjectionClientContext = Readonly<{
    sectionRead?: Exclude<DaemonContributionRegistryProjectionDescribeRequest, { selection: string }>['sectionRead'];
    selection?: 'agents' | 'settings' | 'connectedAccountAdmission';
    locale?: string;
    reactNativeHostRuntimeIdentity?: DaemonReactNativeHostRuntimeIdentityV1;
    hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
}>;

type ProjectionLease = Awaited<ReturnType<typeof acquireProjectionContributionRegistryLease>>;

async function resolveInstalledPackagesForProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null,
): Promise<readonly PluginCatalogEntry[]> {
    if (opts?.resolveInstalledPackages || !runtimeRegistry) {
        return await (opts?.resolveInstalledPackages ?? defaultResolveInstalledPackages)();
    }
    let installedPackages = installedPackagesByRuntimeRegistry.get(runtimeRegistry);
    if (!installedPackages) {
        installedPackages = defaultResolveInstalledPackages();
        installedPackagesByRuntimeRegistry.set(runtimeRegistry, installedPackages);
        // A failed read is not kept: the next build reads again.
        installedPackages.catch(() => {
            if (installedPackagesByRuntimeRegistry.get(runtimeRegistry) === installedPackages) {
                installedPackagesByRuntimeRegistry.delete(runtimeRegistry);
            }
        });
    }
    return await installedPackages;
}

/**
 * Leases the current registry, resolves the cheap keyed inputs, and hands the
 * caller the cached build for this client context — building it only on a
 * miss. Declarative models, the installed catalog, SCM activation and the
 * projection itself are all behind the cache check.
 */
async function withProjectionBuild<T>(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    context: ProjectionClientContext,
    requireRuntimeRegistry: boolean,
    consume: (build: ProjectionBuild, lease: ProjectionLease) => T | Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
    const lease = await acquireProjectionContributionRegistryLease(opts, generation, requireRuntimeRegistry);
    try {
        signal?.throwIfAborted();
        const full = context.selection === undefined;
        const admission = context.selection === 'connectedAccountAdmission';
        const resolvedPluginUiHostRuntime = full ? await resolveProjectionHostRuntime(opts, {
            ...(context.reactNativeHostRuntimeIdentity
                ? { reactNativeHostRuntimeIdentity: context.reactNativeHostRuntimeIdentity }
                : {}),
            ...(context.hostedWebFrameCapability
                ? { hostedWebFrameCapability: context.hostedWebFrameCapability }
                : {}),
        }) : undefined;
        const cacheScope = opts ?? defaultProjectionBuildScope;
        let scopedBuilds = projectionBuildsByScope.get(cacheScope);
        if (!scopedBuilds) {
            scopedBuilds = { complete: new Map(), pending: new Map() };
            projectionBuildsByScope.set(cacheScope, scopedBuilds);
        }
        const projectionBuildsByKey = scopedBuilds.complete;
        const inFlightProjectionBuildsByKey = scopedBuilds.pending;
        const contextKey = JSON.stringify(createProjectionOutputContext({
            selection: context.selection,
            pluginUiHostRuntime: resolvedPluginUiHostRuntime,
            requestedLocale: context.locale,
        }));
        // A page finishes the immutable revision already advertised to this
        // output context. Its plugin-wide facts belong to that build, rather
        // than being read and serialized again for every body page.
        const complete = lease.runtimeRegistry ? projectionBuildsByKey.get(contextKey) : undefined;
        if (context.sectionRead && complete) return await consume(complete, lease);
        const pluginExecutionOriginsByPluginId = full || admission ? await resolvePluginExecutionOriginsForProjection(
            opts,
            lease.registry,
            lease.runtimeRegistry,
        ) : {};
        const baseInputs: ProjectionBuildInputs = {
            generation,
            ...(context.selection ? { selection: context.selection } : {}),
            ...(resolvedPluginUiHostRuntime ? { resolvedPluginUiHostRuntime } : {}),
            brandAssetsByPluginId: {},
            pluginExecutionOriginsByPluginId,
            installedPackages: [],
            ...(full && context.locale ? { locale: context.locale } : {}),
        };
        const cacheRevision = projectionBuildCacheRevision;
        const capture = (inputs: ProjectionBuildInputs) => {
            const currentLease = {
                ...lease,
                targetActivationFacts: lease.runtimeRegistry?.targetActivationFacts ?? lease.targetActivationFacts,
                pluginDiagnosticsByPluginId: lease.runtimeRegistry?.pluginDiagnosticsByPluginId ?? lease.pluginDiagnosticsByPluginId,
            };
            const currentInputs = { ...inputs,
                brandAssetsByPluginId: full || admission ? readCurrentPluginBrandAssetsForProjection({
                    registry: lease.registry, runtimeRegistry: lease.runtimeRegistry,
                }) : inputs.brandAssetsByPluginId,
                pluginFinalPolicyCurrentRuntimesById: lease.runtimeRegistry?.pluginFinalPolicyCurrentRuntimesById,
            };
            const parts = createProjectionCacheKeyParts({ generation, registryCacheToken: lease.cacheToken,
                selection: context.selection, pluginUiHostRuntime: resolvedPluginUiHostRuntime,
                brandAssetsByPluginId: currentInputs.brandAssetsByPluginId,
                pluginExecutionOriginsByPluginId: currentInputs.pluginExecutionOriginsByPluginId,
                pluginFinalPolicyCurrentRuntimesById: currentInputs.pluginFinalPolicyCurrentRuntimesById,
                targetActivationFacts: currentLease.targetActivationFacts,
                pluginDiagnosticsByPluginId: currentLease.pluginDiagnosticsByPluginId,
                ...(context.locale ? { requestedLocale: context.locale } : {}),
            });
            return { lease: currentLease, inputs: currentInputs, parts, inputKey: JSON.stringify([cacheRevision, parts]) };
        };
        const initial = capture(baseInputs);
        const readCached = (inputKey: string) => {
            const cached = lease.runtimeRegistry ? projectionBuildsByKey.get(contextKey) : undefined;
            return cached?.inputKey === inputKey ? cached : undefined;
        };
        const cached = readCached(initial.inputKey);
        if (cached) return await consume(cached, lease);
        const existing = lease.runtimeRegistry ? inFlightProjectionBuildsByKey.get(initial.inputKey) : undefined;
        if (existing) return await consume(await existing, lease);

        const changedKeyParts = changedProjectionBuildKeyParts(initial.parts);
        const startedAtMs = Date.now();
        const started = (async () => {
            const installedPackages = full || admission
                ? await resolveInstalledPackagesForProjection(opts, lease.runtimeRegistry) : [];
            const prepared = capture({ ...baseInputs, installedPackages,
                pluginExecutionOriginsByPluginId: full || admission
                    ? await resolvePluginExecutionOriginsForProjection(opts, lease.registry, lease.runtimeRegistry) : {},
            });
            const cachedAfterPreparation = readCached(prepared.inputKey);
            if (cachedAfterPreparation) return cachedAfterPreparation;
            // Initial-key callers already share preparation. From this exact
            // snapshot, build/store is synchronous; joining another build's
            // initial witness here can form a cycle after authority recovery.
            const content = buildSelectedProjection(prepared.lease, prepared.inputs);
            // Hash the complete full output once, alongside its existing
            // immutable build. Generation alone omits live authority/context
            // changes, and the projection omits the response's catalog siblings.
            const response = full ? Object.freeze({ ...content,
                projectionDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
            }) : content;
            let sections: DaemonContributionRegistryProjectionSectionsResponse | undefined;
            let deferredSections: ReturnType<typeof buildDeferredDaemonProjectionSections> | undefined;
            const build = Object.freeze({ inputKey: prepared.inputKey, response,
                ...(full ? { readDeferredSections: () => deferredSections ??= buildDeferredDaemonProjectionSections(response) } : {}),
                ...(full ? { readSections: () => sections ??= buildDaemonProjectionSections(response) } : {}) });
            if (lease.runtimeRegistry) {
                projectionBuildsByKey.set(contextKey, build);
            }
            return build;
        })();
        if (lease.runtimeRegistry) inFlightProjectionBuildsByKey.set(initial.inputKey, started);
        void started.then(() => {
            logger.debug('[PLUGIN PROJECTION] Built projection (cache miss)', { generation,
                clientKind: projectionClientKind(context), durationMs: Date.now() - startedAtMs, changedKeyParts });
        }, () => {}).finally(() => {
            if (inFlightProjectionBuildsByKey.get(initial.inputKey) === started) {
                inFlightProjectionBuildsByKey.delete(initial.inputKey);
            }
        });
        return await consume(await started, lease);
    } finally {
        await lease.release();
    }
}

type ProjectionBuildInputs = Readonly<{
    generation: number;
    selection?: ProjectionClientContext['selection'];
    resolvedPluginUiHostRuntime?: ReturnType<typeof resolvePluginUiProjectionHostRuntime>;
    installedPackages: readonly PluginCatalogEntry[];
    brandAssetsByPluginId: Readonly<Record<string, PluginProjectionBrandAssetV2>>;
    pluginExecutionOriginsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    pluginFinalPolicyCurrentRuntimesById?: ReadonlyMap<string, PluginFinalPolicyCurrentRuntime>;
    locale?: string;
}>;

function projectActivationIntrospectionRuntimeSnapshot(
    lease: ProjectionLease,
    generation: number,
): PluginTargetActivationIntrospectionSnapshot | undefined {
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
    return activationIntrospection
        ? Object.freeze({
            ...activationIntrospection,
            // This is a snapshot of the current public projection revision.
            // Individual retained registrations keep their internal activation generation.
            generation,
        })
        : undefined;
}

function buildSelectedProjection(
    lease: ProjectionLease,
    inputs: ProjectionBuildInputs,
): DaemonContributionRegistryProjectionDescribeResponse {
    if (inputs.selection === 'settings') return { protocolVersion: 1,
        projection: buildPluginSettingsProjectionV2({ registry: lease.registry, generation: inputs.generation }) };
    if (inputs.selection === 'agents') return { protocolVersion: 1, projection: {
        v: 2, generation: inputs.generation, agentsById: buildAgentsById(lease.registry, inputs.generation),
        installedPackagesById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
        settingsById: {}, familiesById: {}, diagnostics: [],
    } };
    if (inputs.selection === 'connectedAccountAdmission') return { protocolVersion: 1,
        projection: buildPluginConnectedAccountAdmissionProjectionV2({
            registry: lease.registry, generation: inputs.generation, installedPackages: inputs.installedPackages,
            pluginDiagnosticsByPluginId: lease.pluginDiagnosticsByPluginId,
            brandAssetsByPluginId: inputs.brandAssetsByPluginId,
            pluginExecutionOriginsByPluginId: inputs.pluginExecutionOriginsByPluginId,
            ...(lease.runtimeRegistry?.resolveActionPresentUserGatePolicy ? {
                resolveActionPresentUserGatePolicy: lease.runtimeRegistry.resolveActionPresentUserGatePolicy,
            } : {}),
            ...(inputs.pluginFinalPolicyCurrentRuntimesById ? {
                pluginFinalPolicyCurrentRuntimesById: inputs.pluginFinalPolicyCurrentRuntimesById,
            } : {}),
            introspectionRuntimeSnapshot: projectActivationIntrospectionRuntimeSnapshot(lease, inputs.generation),
        }),
    };
    return buildProjection(lease, inputs);
}

function buildProjection(
    lease: ProjectionLease,
    buildInputs: ProjectionBuildInputs,
): DaemonContributionRegistryProjectionDescribeResponse {
    const {
        generation,
        resolvedPluginUiHostRuntime,
        brandAssetsByPluginId,
        pluginExecutionOriginsByPluginId,
        pluginFinalPolicyCurrentRuntimesById,
    } = buildInputs;
    const modelsByRendererKey = typeof lease.runtimeRegistry?.generation === 'number'
        ? resolveDeclarativeProjectionModels({
            registry: lease.registry,
            readPluginOccurrenceId: (pluginId) => lease.runtimeRegistry!.readPluginOccurrenceId?.(pluginId) ?? null,
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

    const introspectionRuntimeSnapshot = projectActivationIntrospectionRuntimeSnapshot(lease, generation);
    const baseProjection = buildPluginProjectionV2({
        registry: lease.registry,
        generation,
        installedPackages: buildInputs.installedPackages,
        pluginDiagnosticsByPluginId: lease.pluginDiagnosticsByPluginId,
        pluginUiHostRuntime,
        brandAssetsByPluginId,
        pluginExecutionOriginsByPluginId,
        ...(lease.runtimeRegistry?.resolveActionPresentUserGatePolicy
            ? {
                resolveActionPresentUserGatePolicy:
                    lease.runtimeRegistry.resolveActionPresentUserGatePolicy,
            }
            : {}),
        ...(pluginFinalPolicyCurrentRuntimesById
            ? { pluginFinalPolicyCurrentRuntimesById }
            : {}),
        ...(introspectionRuntimeSnapshot ? { introspectionRuntimeSnapshot } : {}),
        ...(buildInputs.locale ? { requestedLocale: buildInputs.locale } : {}),
    });
    // Automation setup and typed pickers share one physical embedded mount owner.
    const projectEmbeddedSurface = (
        contribution: Readonly<{ pluginId: string; localId: string }>,
        occurrenceId: string,
        renderer: Parameters<typeof projectDaemonEmbeddedPluginUiRenderer>[0]['renderer'],
    ) => {
        const runtimeRegistry = lease.runtimeRegistry;
        const executionOrigin = pluginExecutionOriginsByPluginId[contribution.pluginId];
        if (!runtimeRegistry || !executionOrigin) return undefined;
        const rendered = projectDaemonEmbeddedPluginUiRenderer({
            registry: lease.registry, projection: baseProjection, pluginUiHostRuntime, modelsByRendererKey,
            contributor: contribution, occurrenceId, renderer,
        });
        if (!rendered) return undefined;
        try {
            return Object.freeze({
                contribution: Object.freeze({ ...contribution }), occurrenceId,
                projectionGeneration: baseProjection.generation,
                rendererChain: rendered.rendererChain.map(identity => ({ ...identity })),
                selectedRenderer: rendered.selectedRenderer,
                executionOrigin,
                resourceCapability: readTargetedSurfaceResourceCapability(runtimeRegistry, contribution.pluginId),
                contributorTargetedContributions: readMountedTargetedContributionsProjection({
                    runtimeRegistry, mountedTarget: { pluginId: contribution.pluginId, occurrenceId },
                }),
            });
        } catch {
            return undefined;
        }
    };
    const inputTypes = baseProjection.familiesById.inputTypes;
    const projection = inputTypes ? Object.freeze({
        ...baseProjection,
        familiesById: Object.freeze({
            ...baseProjection.familiesById,
            inputTypes: Object.freeze({ ...inputTypes, entriesById: Object.freeze(Object.fromEntries(
                Object.entries(inputTypes.entriesById).map(([key, entry]) => {
                    const picker = entry.definition.picker
                        ? qualifyPluginContributionReferenceV1(entry.definition.picker, entry.pluginId) : null;
                    const pickerSurface = picker?.pluginId === entry.pluginId && entry.occurrenceId
                        ? projectEmbeddedSurface({ pluginId: entry.pluginId, localId: entry.definition.id },
                            entry.occurrenceId, { renderer: picker.localId }) : undefined;
                    return [key, Object.freeze({ ...entry, ...(pickerSurface ? { pickerSurface } : {}) })];
                }),
            )) }),
        }),
    }) : baseProjection;
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
        const pluginId = entry.event.identity.pluginId;
        const sourceCustody = lease.runtimeRegistry?.readPluginSourceCustody?.(
            pluginId,
        );
        const currentEntry = sourceCustody
            ? Object.freeze({
                ...entry,
                event: Object.freeze({ ...entry.event, sourceCustody }),
            })
            : null;
        if (!currentEntry) return null;
        const renderer = entry.event.automation.source.setupSurface;
        if (!renderer) return currentEntry;
        return Object.freeze({ ...currentEntry,
            setupSurface: projectEmbeddedSurface(entry.event.identity, entry.event.occurrenceId, renderer) });
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    // Built from typed producers and validated by the owner tests; the
    // client parses the response once at its boundary. The small Event
    // automation sibling is validated here because its producer carries
    // manifest-typed payload schemas that are looser than the wire type.
    const response: DaemonContributionRegistryProjectionDescribeResponse = {
        protocolVersion: 1,
        projection,
        automationEligibleEvents: DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema
            .parse(automationEligibleEvents),
        ...(composerSurfaceCatalog ? { composerSurfaceCatalog: [...composerSurfaceCatalog] } : {}),
    };
    return response;
}

async function describeProjection(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    request: DaemonContributionRegistryProjectionDescribeRequest,
    signal?: AbortSignal,
): Promise<DaemonContributionRegistryProjectionDescribeResponse | DaemonContributionRegistryProjectionDescribeUnchangedResponse
    | DaemonContributionRegistryProjectionSectionsResponse
    | ReturnType<typeof buildDeferredDaemonProjectionSections>['manifest']
    | NonNullable<ReturnType<ReturnType<typeof buildDeferredDaemonProjectionSections>['read']>>> {
    if (request.selection === 'skills') {
        const generation = await (opts?.resolveGeneration ?? defaultResolveGeneration)();
        const lease = await acquireProjectionContributionRegistryLease(opts, generation, true);
        try {
            signal?.throwIfAborted();
            const registry = request.skillIds ? { ...lease.registry, skills: (lease.registry.skills ?? []).filter(
                entry => request.skillIds!.includes(pluginSkillIdV1(entry.identity))) } : lease.registry;
            const pluginExecutionOriginsByPluginId = await resolvePluginExecutionOriginsForProjection(
                opts, registry, lease.runtimeRegistry);
            // Package bytes remain a fresh filesystem read, separate from the
            // immutable registry-shaped responses retained by the cache owner.
            return {
                protocolVersion: 1,
                pluginSkills: PluginSkillLibraryContentV1Schema.parse(
                    await readPluginSkills(signal, request.skillIds, registry)),
                projection: {
                    v: 2,
                    generation,
                    familiesById: { skills: buildPluginProjectionFamilyV2({ registry, generation,
                        pluginExecutionOriginsByPluginId }, skillsProjectionFamily) },
                    agentsById: {},
                    installedPackagesById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    diagnostics: [],
                },
            };
        } finally {
            await lease.release();
        }
    }
    logger.debug('[PLUGIN PROJECTION] Describe', {
        clientKind: projectionClientKind(request),
        locale: request.locale ?? null,
    });
    signal?.throwIfAborted();
    return await withProjectionBuild(opts, request, request.selection === 'connectedAccountAdmission', (build) => {
        signal?.throwIfAborted();
        if (request.selection === undefined && request.deferredSections === true && build.readDeferredSections) {
            if (request.sectionRead) {
                const body = build.readDeferredSections().read(request.sectionRead.digest, request.sectionRead.offset, request.sectionRead.includeDigests, request.sectionFrameVersion);
                if (!body) throw new RpcError('Projection section is no longer available', DAEMON_PROJECTION_SECTION_STALE_CODE);
                return body;
            }
            if (request.knownProjectionDigest !== build.response.projectionDigest) {
                const manifest = build.readDeferredSections().manifest;
                return request.supportedSectionFrameVersions?.includes(2) ? { ...manifest, sectionFrameVersion: 2 as const } : manifest;
            }
        }
        if (request.selection === undefined && request.knownProjectionDigest !== undefined
            && request.knownProjectionDigest === build.response.projectionDigest) {
            return { protocolVersion: 1, unchanged: true, projectionDigest: request.knownProjectionDigest } satisfies DaemonContributionRegistryProjectionDescribeUnchangedResponse;
        }
        if (request.selection === undefined && request.knownSectionDigests !== undefined && build.readSections) {
            return omitKnownDaemonProjectionSectionBodies(build.readSections(), request.knownSectionDigests);
        }
        return build.response;
    }, signal);
}

/**
 * The current contributions to one target plugin, tagged with the target's
 * current occurrence. Reads are not fenced: a reloaded plugin answers with its
 * new occurrence and the client remounts. Effects stay occurrence-fenced.
 */
async function readTargetedContributions(
    opts: DaemonContributionRegistryProjectionRegistrationOptions | undefined,
    request: DaemonPluginUiTargetedContributionsReadRequest,
): Promise<DaemonPluginUiTargetedContributionsReadResponse> {
    const lease = await acquireProjectionRuntimeRegistryLease(opts);
    try {
        const runtimeRegistry = lease.registry;
        if (request.readMode === 'sourceDeclarations') {
            const declarations = runtimeRegistry.contributes.pluginDeclarations;
            if (!declarations || !runtimeRegistry.readPluginOccurrenceId || !runtimeRegistry.readPluginSourceCustody) {
                return { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' };
            }
            const sourceDeclarations: DaemonPluginTargetedSourceDeclarationV1[] = [];
            for (const declaration of declarations) {
                const contributions = declaration.manifest.contributes.targetedPluginContributions
                    .filter((entry) => entry.target.pluginId === request.pluginId);
                if (contributions.length === 0) continue;
                const occurrenceId = runtimeRegistry.readPluginOccurrenceId(declaration.pluginId);
                if (!occurrenceId) continue;
                const sourceCustody = runtimeRegistry.readPluginSourceCustody(declaration.pluginId);
                if (!sourceCustody) return { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' };
                const actionIds = new Set(contributions.flatMap((entry) => Object.values(entry.operations)));
                const rendererIds = new Set(contributions.flatMap((entry) => Object.values(entry.surfaces ?? {})
                    .flatMap((surface) => [surface.renderer, ...(surface.fallbackRenderers ?? [])])));
                // Manifest ingestion already admitted these typed declarations.
                // Select their references here; the receiver validates the wire.
                sourceDeclarations.push({
                    manifest: { id: declaration.pluginId, contributes: {
                        actions: declaration.manifest.contributes.actions.filter((entry) => actionIds.has(entry.id)),
                        pluginContributionPoints: [],
                        targetedPluginContributions: contributions,
                        ui: { renderers: declaration.manifest.contributes.ui.renderers.filter((entry) => rendererIds.has(entry.id)) },
                    } },
                    occurrenceId,
                    sourceCustody,
                });
            }
            return { status: 'sourceDeclarations', pluginId: request.pluginId, sourceDeclarations };
        }
        const occurrenceId = runtimeRegistry.readPluginOccurrenceId?.(request.pluginId)
            ?? runtimeRegistry.contributes.occurrenceIdsByPluginId?.[request.pluginId]
            ?? null;
        if (!occurrenceId) {
            return { status: 'unavailable', code: 'plugin_targeted_contributions_target_unavailable' };
        }
        const mountedTarget = Object.freeze({ pluginId: request.pluginId, occurrenceId });
        try {
            const snapshots = readMountedTargetedContributionSnapshots({ runtimeRegistry, mountedTarget });
            const targetedContributions = readMountedTargetedContributionsProjection({
                runtimeRegistry,
                mountedTarget,
                snapshots,
            });
            // The admitted chains are the complete private renderer demand.
            // Neither an unrelated family nor a full describe cache miss is a
            // prerequisite for this target's handles and mounts.
            const renderers = [...new Map(snapshots.flatMap(({ snapshot }) => (
                snapshot.contributions.flatMap((contribution) => (
                    contribution.surfaces.flatMap((surface) => surface.rendererChain)
                ))
            )).map((renderer) => [
                `${renderer.pluginId}\0${renderer.definition.id}`, renderer,
            ] as const)).values()];
            const resourcePluginIds = new Set([
                request.pluginId,
                ...targetedContributions.points.flatMap((point) => point.protocols.flatMap((protocol) => (
                    protocol.contributions.map((contribution) => contribution.contributor.pluginId)
                ))),
                ...renderers.flatMap((renderer) => renderer.pluginId ? [renderer.pluginId] : []),
            ]);
            const resourceRegistry = {
                ...runtimeRegistry.contributes,
                resources: runtimeRegistry.contributes.resources.filter((resource) => (
                    resource.pluginId && resourcePluginIds.has(resource.pluginId)
                )),
                activationTargets: runtimeRegistry.contributes.activationTargets.filter((target) => resourcePluginIds.has(target.pluginId)),
            };
            const pluginExecutionOriginsByPluginId = renderers.length > 0 || resourceRegistry.resources.length > 0
                ? await resolvePluginExecutionOriginsForProjection(opts, runtimeRegistry.contributes, runtimeRegistry)
                : Object.freeze({});
            const resourceDeclarationsByPluginId: DaemonPluginUiResourceDeclarationsByPluginIdV1 = Object.fromEntries(
                [...resourcePluginIds].map((pluginId) => [pluginId, {}]),
            );
            if (resourceRegistry.resources.length > 0) {
                const resourcesById = buildResourcesById(resourceRegistry,
                    deriveRegistryConnectedAccountPurposeAuthorizations(resourceRegistry), pluginExecutionOriginsByPluginId);
                for (const [key, resource] of Object.entries(resourcesById)) {
                    resourceDeclarationsByPluginId[resource.pluginId]![key] = resource;
                }
            }
            if (renderers.length === 0) {
                return { status: 'current', targetedContributions, targetedSurfaceMounts: [], resourceDeclarationsByPluginId };
            }
            const pluginUiHostRuntime = await resolveProjectionHostRuntime(opts, request);
            const modelsByRendererKey = typeof runtimeRegistry.generation === 'number'
                && renderers.some((renderer) => renderer.definition.kind === 'declarative')
                ? resolveDeclarativeProjectionModels({
                    // Models retain their declared Action/destination inputs,
                    // while unrelated renderers and Session sections are not built.
                    registry: { ...runtimeRegistry.contributes, uiRenderersV2: renderers, sessionInfoSections: [] },
                    readPluginOccurrenceId: (pluginId) => runtimeRegistry.readPluginOccurrenceId?.(pluginId) ?? null,
                    ...(runtimeRegistry.targetActionInvocations
                        ? { actionRuntime: runtimeRegistry.targetActionInvocations }
                        : {}),
                    onRendererModelUnavailable({ pluginId, rendererId, error }) {
                        logger.warn('[PLUGIN RUNTIME] Declarative renderer is unavailable: its model could not be built', {
                            pluginId, rendererId,
                            reason: projectPluginFailureText(error instanceof Error ? error : new Error(String(error))),
                        });
                    },
                })
                : Object.freeze({});
            const rendererProjection = buildPluginProjectionFamilyV2({
                registry: createResolvedContributionRegistry({
                    uiRenderersV2: renderers,
                    occurrenceIdsByPluginId: runtimeRegistry.contributes.occurrenceIdsByPluginId,
                }),
                generation: await (opts?.resolveGeneration ?? defaultResolveGeneration)(),
                pluginUiHostRuntime,
                pluginExecutionOriginsByPluginId,
            }, pluginUiProjectionFamily);
            return {
                status: 'current',
                targetedContributions,
                resourceDeclarationsByPluginId,
                targetedSurfaceMounts: [...readMountedTargetedSurfaceMountsProjection({
                    runtimeRegistry,
                    mountedTarget,
                    snapshots,
                    entriesById: rendererProjection.entriesById,
                    pluginUiHostRuntime,
                    modelsByRendererKey,
                    pluginExecutionOriginsByPluginId,
                })],
            };
        } catch (error) {
            if (error instanceof PluginError) {
                logger.warn('[PLUGIN RUNTIME] Targeted contributions are unavailable for a mounted target', {
                    pluginId: request.pluginId,
                    code: error.code,
                    reason: projectPluginFailureText(error),
                });
                return { status: 'unavailable', code: error.code };
            }
            throw error;
        }
    } finally {
        await lease.release();
    }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function findGeneratedReactNativeArtifactGraph(params: Readonly<{
    owner:
        | ResolvedGeneratedReactNativeArtifactOwner
        | ResolvedGeneratedReactNativeClientContributionArtifactOwner;
    identity: Readonly<{ artifactDigest: PluginUiArtifactDigestV1 }>;
}>): PluginUiArtifactsManifestEntryV2 | null {
    const resolved = findGeneratedReactNativeArtifactEntry({
        owner: params.owner,
        platform: undefined,
    });
    return resolved.entry?.digest === params.identity.artifactDigest ? resolved.entry : null;
}

function findGeneratedHostedWebArtifactGraph(params: Readonly<{
    owner: ResolvedGeneratedHostedWebArtifactOwner;
    identity: Readonly<{ artifactDigest: PluginUiArtifactDigestV1 }>;
}>): PluginUiArtifactsManifestEntryV2 | null {
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
    graph: PluginUiArtifactsManifestEntryV2;
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
        entry: Readonly<{ relativePath: string; bytes: Uint8Array; digest: PluginUiArtifactDigestV1 }>;
        files: readonly Readonly<{ relativePath: string; bytes: Uint8Array; digest: PluginUiArtifactDigestV1 }>[];
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
    const loadedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array; digest: PluginUiArtifactDigestV1 }>> = [];
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
            const digest = bytes.byteLength === file.byteSize ? computePluginUiArtifactSha256DigestV1(bytes) : null;
            if (digest === null || digest !== file.digest) {
                return Object.freeze({
                    ok: false,
                    response: artifactBytesError('artifact_integrity_failed', [params.diagnostics.fileIntegrityFailed]),
                });
            }
            loadedFiles.push(Object.freeze({ relativePath: file.relativePath, bytes, digest }));
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

type GeneratedReactNativeArtifactReadParams = Readonly<{
    registry: ResolvedContributionRegistry;
    owner:
        | ResolvedGeneratedReactNativeArtifactOwner
        | ResolvedGeneratedReactNativeClientContributionArtifactOwner;
    identity: Readonly<{ artifactDigest: PluginUiArtifactDigestV1 }>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>;

/**
 * The generated Artifact graph is the sole daemon byte authority. Selection
 * is digest-only; semantic owners retain their own admission lifecycles.
 */
async function readGeneratedReactNativeArtifactBytesByCacheIdentity(
    params: GeneratedReactNativeArtifactReadParams,
): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    const graph = findGeneratedReactNativeArtifactGraph(params);
    if (!graph || graph.tier !== 'reactNative' || graph.builtWith.bundler !== 'esbuild') {
        return artifactBytesError('artifact_not_found', [
            'generated_react_native_artifact_graph_not_found',
        ]);
    }
    const loaded = await readVerifiedGeneratedPluginUiArtifactGraph({
        pluginRootPath: params.owner.pluginRootPath,
        graph,
        pluginId: params.owner.pluginId,
        contributionId: params.owner.contributionId,
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
        digest: file.digest,
        byteSize: file.bytes.byteLength,
        bytesBase64: Buffer.from(file.bytes).toString('base64'),
    }));
    const response = {
        ok: true,
        artifactFamily: 'reactNative',
        cacheIdentity: params.identity,
        artifact: {
            artifactKind: 'reactNativeBundle',
            // This is the canonical complete-file-set digest, not an entry-byte digest.
            digest: loaded.digest,
            format: 'plainJs',
            byteSize: loaded.entry.bytes.byteLength,
        },
        files,
    };
    return DaemonPluginUiArtifactBytesReadResponseSchema.parse(response);
}

async function readGeneratedHostedWebArtifactBytesByCacheIdentity(params: Readonly<{
    owner: ResolvedGeneratedHostedWebArtifactOwner;
    identity: Readonly<{ artifactDigest: PluginUiArtifactDigestV1 }>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    const graph = findGeneratedHostedWebArtifactGraph(params);
    if (!graph || graph.tier !== 'hostedWeb' || graph.builtWith.staging !== 'staticDirectory') {
        return artifactBytesError('artifact_not_found', ['generated_hosted_web_artifact_graph_not_found']);
    }
    const loaded = await readVerifiedGeneratedPluginUiArtifactGraph({
        pluginRootPath: params.owner.pluginRootPath,
        graph,
        pluginId: params.owner.pluginId,
        contributionId: params.owner.contributionId,
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
        cacheIdentity: params.identity,
        artifact: {
            artifactKind: 'hostedWebAsset',
            digest: loaded.digest,
            byteSize: loaded.entry.bytes.byteLength,
        },
        files: loaded.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.bytes.byteLength,
            bytesBase64: Buffer.from(file.bytes).toString('base64'),
        })),
    });
}

async function readHostedWebArtifactBytesByCacheIdentity(params: Readonly<{
    registry: ResolvedContributionRegistry;
    identity: Readonly<{ artifactDigest: PluginUiArtifactDigestV1 }>;
    readArtifactFile?: (path: string) => Promise<Uint8Array>;
}>): Promise<DaemonPluginUiArtifactBytesReadResponse> {
    const generatedOwner = collectResolvedGeneratedHostedWebArtifactOwners(params.registry)
        .map((owner) => ({ owner, graph: findGeneratedHostedWebArtifactGraph({ owner, identity: params.identity }) }))
        .filter((candidate) => candidate.graph !== null)
        .sort((left, right) => `${left.owner.pluginId}\u0000${left.owner.contributionId}`
            .localeCompare(`${right.owner.pluginId}\u0000${right.owner.contributionId}`))[0]?.owner ?? null;
    if (!generatedOwner) {
        return artifactBytesError('artifact_not_found', ['hosted_web_artifact_not_found']);
    }
    return await readGeneratedHostedWebArtifactBytesByCacheIdentity({
        ...params,
        owner: generatedOwner,
    });
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
    reason: 'invalid_payload' | 'stale_occurrence' | 'not_found' | 'unknown_subscription' | 'unavailable';
}> {
    const code = isPluginError(error) ? error.code : 'plugin_resource_unavailable';
    const reason = code === 'plugin_resource_not_found'
        ? 'not_found' as const
        : code === 'plugin_generation_stale'
            ? 'stale_occurrence' as const
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
    rpc.registerHandler(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async (raw: unknown, context?: RpcHandlerContext) => {
        // Parse input for forward compatibility and to avoid accepting accidental session-scoped payloads.
        const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(raw);
        return await describeProjection(opts, request, context?.signal);
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ, async (raw: unknown) => {
        const request = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(raw);
        return await readTargetedContributions(opts, request);
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
                const snapshot = await readPluginSettingsSnapshot({
                    pluginId: request.pluginId,
                    service,
                    secrets,
                    fields,
                    scope,
                });
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
                const field = fields.find((candidate) => candidate.id === request.fieldId);
                if (!field) {
                    throw new PluginContextServiceError(
                        'PLUGIN_SETTINGS_UNKNOWN_KEY',
                        `Plugin setting '${request.fieldId}' is not declared in the manifest`,
                    );
                }
                if (isSecretSettingsField(field)) {
                    // Secret fields have one writer: the declared secret
                    // administration port (`secrets.set` / `secrets.delete`).
                    throw new PluginContextServiceError(
                        'PLUGIN_SETTINGS_SECRET_FIELD_REQUIRES_SECRET_WRITE',
                        `Plugin setting '${request.fieldId}' is a secret; write it through the plugin secret RPC`,
                    );
                }
                let status: 'applied' | 'conflict' = 'applied';
                try {
                    // The Settings service owns validation of declared values.
                    if (request.mutation.kind === 'delete') {
                        await service.reset(request.fieldId, {
                            ...(request.expectedRevision === undefined
                                ? {}
                                : { expectedRevision: request.expectedRevision }),
                        });
                    } else {
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
                const snapshot = await readPluginSettingsSnapshot({
                    pluginId: request.pluginId,
                    service,
                    secrets,
                    fields,
                    scope,
                });
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
                const result = await waitForDaemonPluginSettingsWatch({
                    service,
                    ...(request.knownRevision === undefined ? {} : { knownRevision: request.knownRevision }),
                    ...(context?.signal === undefined ? {} : { signal: context.signal }),
                });
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
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
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
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
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
                const status = await readDaemonPluginSecretStatus({
                    pluginId: request.pluginId,
                    secretId: request.secretId,
                    ...(request.canonicalOrigin === undefined
                        ? {}
                        : { canonicalOrigin: request.canonicalOrigin }),
                    port,
                    signal,
                });
                return DaemonPluginSecretDeleteResponseSchema.parse(status);
            },
        );
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_STORED_IMAGE_READ, async (raw: unknown, context) => {
        const request = DaemonPluginStoredImageReadRequestSchema.safeParse(raw);
        if (!request.success) return { ok: false, code: 'plugin_session_media_request_invalid' };
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!isExpectedPluginOccurrenceCurrent(lease.registry, request.data.callerPluginId, request.data.expectedCallerOccurrenceId)) {
                return { ok: false, code: 'plugin_generation_stale' };
            }
            if (!lease.registry.readUiStoredImage) return { ok: false, code: 'plugin_session_media_unavailable' };
            const image = await lease.registry.readUiStoredImage({ ...request.data, ...(context?.signal ? { signal: context.signal } : {}) });
            if (!isExpectedPluginOccurrenceCurrent(lease.registry, request.data.callerPluginId, request.data.expectedCallerOccurrenceId)) {
                return { ok: false, code: 'plugin_generation_stale' };
            }
            return DaemonPluginStoredImageReadResponseSchema.parse({ ok: true, image });
        } catch (error) {
            return { ok: false, code: isPluginError(error) ? error.code : 'plugin_session_media_unavailable' };
        } finally {
            await lease.release();
        }
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
        const declaredRequest = request.data;
        const refuse = (failure: Extract<ReturnType<typeof DaemonPluginUiResourceReadResponseSchema.parse>, { ok: false }>, generation?: number) => {
            // Identity only: never include Resource bytes, contextual input or error text.
            logger.infoFile('[PLUGIN RESOURCE] Read refused', {
                ...(context?.transportRequestId ? { requestId: context.transportRequestId } : {}),
                callerPluginId: declaredRequest.callerPluginId,
                resourcePluginId: declaredRequest.resource.pluginId,
                resourceId: declaredRequest.resource.localId,
                expectedCallerOccurrenceId: declaredRequest.expectedCallerOccurrenceId,
                ...(generation === undefined ? {} : { generation }),
                code: failure.code, reason: failure.reason,
            });
            return DaemonPluginUiResourceReadResponseSchema.parse(failure);
        };
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return refuse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
                }, lease.registry.generation);
            }
            if (!lease.registry.readUiResource) {
                return refuse({
                    ok: false,
                    code: 'plugin_resource_service_unavailable',
                    reason: 'unavailable',
                }, lease.registry.generation);
            }
            // Caller-scoped by construction: the resource service is bound to the
            // host-stamped calling plugin, so a reference naming another plugin
            // is simply not declared for that bind.
            if (request.data.resource.pluginId !== request.data.callerPluginId) {
                return refuse({
                    ok: false,
                    code: 'plugin_resource_not_found',
                    reason: 'not_found',
                }, lease.registry.generation);
            }
            const value = await lease.registry.readUiResource({
                expectedCallerOccurrenceId: request.data.expectedCallerOccurrenceId,
                callerPluginId: request.data.callerPluginId,
                resourceId: request.data.resource.localId,
                ...(request.data.context === undefined ? {} : { context: request.data.context }),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return refuse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
                }, lease.registry.generation);
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
                    ? 'stale_occurrence'
                    : code === 'plugin_resource_declaration_invalid'
                        || code === 'plugin_resource_options_invalid'
                        || code === 'plugin_resource_limit_invalid'
                        ? 'invalid_payload'
                        : 'unavailable';
            return refuse({ ok: false, code, reason }, lease.registry.generation);
        } finally {
            await lease.release();
        }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ, async (raw: unknown, context) => {
        const parsed = DaemonPluginUiCaptureSourceReadRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, code: 'invalid_payload' };
        const request = parsed.data;
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            if (!opts) return { ok: false, code: 'capture_source_unavailable' };
            const origin = await opts.resolvePluginProjectionExecutionOriginContext?.();
            if (!origin || origin.machineId !== request.machineId) return { ok: false, code: 'capture_source_denied' };
            if (!isExpectedPluginOccurrenceCurrent(lease.registry, request.callerPluginId, request.expectedCallerOccurrenceId)) {
                return { ok: false, code: 'plugin_occurrence_stale' };
            }
            const registry = opts.resolveCaptureRegistry?.();
            if (!registry) return { ok: false, code: 'capture_source_unavailable' };
            if (request.reference.kind === 'plugin') {
                if (request.reference.source.pluginId !== request.callerPluginId) return { ok: false, code: 'capture_source_denied' };
                await registerPluginCaptureSource({ runtimeRegistry: lease.registry, captureRegistry: registry, reference: request.reference.source });
            }
            context?.signal?.throwIfAborted();
            if (!isExpectedPluginOccurrenceCurrent(lease.registry, request.callerPluginId, request.expectedCallerOccurrenceId)) {
                return { ok: false, code: 'plugin_occurrence_stale' };
            }
            const described = registry.describeViewing({ pluginId: request.callerPluginId, reference: request.reference });
            if (!described.ok) return { ok: false, code: described.reasonCode };
            return DaemonPluginUiCaptureSourceReadResponseSchema.parse({ ok: true, source: {
                sourceId: described.source.sourceId, sourceOccurrenceId: described.source.sourceOccurrenceId,
                streamFamily: described.source.streamFamily, supportedCodecs: described.source.capabilities.supportedCodecs,
                requiresApproval: !described.source.plugin,
            } });
        } catch {
            return { ok: false, code: 'capture_source_unavailable' };
        } finally { await lease.release(); }
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
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.reference.pluginId,
                request.data.expectedOccurrenceId,
            )) {
                return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
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
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.reference.pluginId,
                request.data.expectedOccurrenceId,
            )) {
                return DaemonPluginComposerReferenceSearchResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
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
                ? 'stale_occurrence'
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
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
                });
            }
            if (!lease.registry.openUiResourceWatch) {
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
                expectedCallerOccurrenceId: request.data.expectedCallerOccurrenceId,
                callerPluginId: request.data.callerPluginId,
                subscriptionId: request.data.subscriptionId,
                resourceId: request.data.resource.localId,
                ...(request.data.context === undefined ? {} : { context: request.data.context }),
            });
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return DaemonPluginUiResourceWatchOpenResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
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
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
                });
            }
            if (!lease.registry.pollUiResourceWatch) {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_resource_service_unavailable',
                    reason: 'unavailable',
                });
            }
            const polled = await lease.registry.pollUiResourceWatch({
                expectedCallerOccurrenceId: request.data.expectedCallerOccurrenceId,
                callerPluginId: request.data.callerPluginId,
                subscriptionId: request.data.subscriptionId,
                ...(request.data.waitMs === undefined ? {} : { waitMs: request.data.waitMs }),
                ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                request.data.callerPluginId,
                request.data.expectedCallerOccurrenceId,
            )) {
                return DaemonPluginUiResourceWatchNextResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                    reason: 'stale_occurrence',
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
        const traceStage = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
            'action.invoke', context?.localActionContext?.actionRequestId ?? context?.transportRequestId, stage, operation,
        );
        const lease = await traceStage('contributed.runtime_lease', () => acquireProjectionRuntimeRegistryLease(opts));
        let releaseLease = true;
        try {
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
            const mountedCaller = await traceStage('contributed.mounted_caller', () => deriveMountedPluginInvocationCaller({
                request: {
                    machineId: request.data.machineId,
                    invocationSurface,
                    ...(request.data.invocation ? { invocation: request.data.invocation } : {}),
                },
                registry: lease.registry,
                ...(opts?.resolveAccountPluginExecutionSelection ? {
                    resolveAccountExecutionSelection: (pluginId: string) => opts.resolveAccountPluginExecutionSelection!(pluginId, lease.registry, context?.signal),
                } : {}),
                resolveCurrentPluginMaterializationRef:
                    lease.resolveCurrentPluginMaterializationRef,
                resolveExecutionOriginContext: opts?.resolvePluginProjectionExecutionOriginContext
                    ? () => traceStage('contributed.mounted_origin', () => opts.resolvePluginProjectionExecutionOriginContext!())
                    : undefined,
            }));
            if (mountedCaller.status === 'unavailable') {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_mounted_caller_unavailable',
                });
            }
            let defaultSessionId = request.data.sessionId;
            if (request.data.resolveClientMessageContext) {
                if (resolvedAction?.definition.execution?.target !== 'client'
                    || !resolvedAction.definition.contributionSurfaces?.includes('ui')
                    || !resolvedAction.definition.placementBindings?.includes('message.menu')
                    || resolvedAction.definition.surfaces[invocationSurface] !== true
                    || (invocation?.kind === 'clientPluginAction' && (
                        mountedCaller.status !== 'available'
                        || buildQualifiedPluginContributionKey({ pluginId: invocation.clientActionBinding.pluginId,
                            localId: invocation.clientActionBinding.contributionLocalId }) !== request.data.qualifiedActionId
                    ))) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: false, code: 'plugin_action_unavailable' });
                }
                if (!isExpectedPluginOccurrenceCurrent(lease.registry, resolvedAction.pluginId, request.data.expectedContributorOccurrenceId)) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: false, code: 'plugin_occurrence_stale' });
                }
            }
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
            if (request.data.resolveClientMessageContext) {
                if (!messageAction || !resolvedAction
                    || !isExpectedPluginOccurrenceCurrent(lease.registry, resolvedAction.pluginId, request.data.expectedContributorOccurrenceId)
                    || (mountedCaller.status === 'available' && !await mountedCaller.isMountedCallerCurrent())
                    || context?.signal?.aborted) {
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: false, code: 'plugin_message_action_unavailable' });
                }
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: messageAction });
            }
            const selectedActionInputCarrier = request.data.selectedActionInputCarrier;
            if (selectedActionInputCarrier !== undefined) {
                const mountedPluginId = mountedCaller.status === 'available'
                    ? mountedCaller.caller.pluginId
                    : undefined;
                const currentMountedSourceCustody = mountedPluginId === undefined
                    ? undefined
                    : lease.registry.readPluginSourceCustody?.(mountedPluginId) ?? undefined;
                if (
                    mountedCaller.status !== 'available'
                    || selectedActionInputCarrier.result.selection.target.pluginId !== mountedPluginId
                    || currentMountedSourceCustody === undefined
                    || !pluginSourceCustodyEqual(
                        selectedActionInputCarrier.result.selection.target.sourceCustody,
                        currentMountedSourceCustody,
                    )
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
                    // A carrier is valid only for the live bound UI plugin caller
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
            const attempt = await traceStage('contributed.execute', () => executeContributedAction({
                runtimeRegistry: lease.registry,
                actionId: request.data.qualifiedActionId,
                ...(request.data.input === undefined ? {} : { input: request.data.input }),
                expectedContributorOccurrenceId: request.data.expectedContributorOccurrenceId,
                approvalContext: {
                    ...context?.localActionContext,
                    authority: context?.callerAuthority ?? context?.localActionContext?.authority ?? 'account_automation',
                    ...(context?.localActionContext?.actionRequestId ?? context?.transportRequestId
                        ? { actionRequestId: context?.localActionContext?.actionRequestId ?? context?.transportRequestId } : {}),
                },
                requestCurrentIntent: createPresentUserCurrentIntent(request.data.presentUserIntent, opts?.requestCurrentIntent),
                context: {
                    // Keep the physical origin for confirmation. Only an admitted
                    // client/Account Action grants nested plugin-surface semantics;
                    // an ordinary mounted UI press does not.
                    surface: invocationSurface,
                    invocationSurface,
                    ...(mountedCaller.status === 'available' && invocation?.kind === 'clientPluginAction'
                        ? { admittedPluginActionSurface: 'plugin' as const } : {}),
                    // This ingress already admitted the present user's mounted or host-presented intent.
                    initiatingActionCaller: { kind: 'host' },
                    ...(mountedCaller.status === 'available'
                        ? {
                            caller: mountedCaller.caller,
                            isMountedCallerCurrent: mountedCaller.isMountedCallerCurrent,
                            ...(mountedCaller.approvalInputCustody
                                ? { approvalInputCustody: mountedCaller.approvalInputCustody }
                                : {}),
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
            }));
            if (!attempt.matched) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_unavailable',
                });
            }
            if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: attempt.result.result });
            }
            if (trackedOperation && opts?.observePluginExecution) {
                if (!attempt.result.ok || !preparedTrackedInvocation || !resolvedAction) {
                    return attempt.result.ok
                        ? DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: false, code: 'plugin_action_unavailable' })
                        : projectStructuredMessageActionFailure(attempt.result);
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
                    ...(context ? { rpcContext: context } : {}),
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
                        return { ok: false, errorCode, error: typeof result.error === 'string' ? result.error : errorCode };
                    },
                });
                return observed.ok
                    ? DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: observed.result })
                    : projectStructuredMessageActionFailure(observed);
            }
            if (attempt.result.ok) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: true,
                    result: attempt.result.result,
                });
            }
            return projectStructuredMessageActionFailure(attempt.result);
        } finally {
            if (releaseLease) await lease.release();
        }
    });
    // Action schemas are not in the describe projection; a reader fetches one
    // Action's declared schemas here, for the exact occurrence it projected.
    rpc.registerHandler(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ, async (raw: unknown) => {
        const request = DaemonPluginActionSchemasReadRequestSchema.safeParse(raw);
        if (!request.success) {
            return DaemonPluginActionSchemasReadResponseSchema.parse({
                ok: false,
                code: 'plugin_action_schemas_request_invalid',
            });
        }
        const lease = await acquireProjectionRuntimeRegistryLease(opts);
        try {
            const action = lease.registry.contributes.actionsById?.get(request.data.qualifiedActionId);
            if (!action?.pluginId) {
                return DaemonPluginActionSchemasReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_schemas_unavailable',
                });
            }
            if (!isExpectedPluginOccurrenceCurrent(lease.registry, action.pluginId, request.data.expectedOccurrenceId)) {
                return DaemonPluginActionSchemasReadResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                });
            }
            return DaemonPluginActionSchemasReadResponseSchema.parse({
                ok: true,
                ...(action.definition.inputSchema === undefined
                    ? {}
                    : { inputSchema: action.definition.inputSchema }),
                ...(action.definition.outputSchema === undefined
                    ? {}
                    : { outputSchema: action.definition.outputSchema }),
            });
        } finally {
            await lease.release();
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
            const resolveOptionalAccess = (pluginId: string) => (
                lease.registry.resolveOptionalAccess?.(pluginId) ?? Object.freeze([])
            );
            const authorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
                registry: lease.registry.contributes,
                qualifiedActionId: request.data.qualifiedActionId,
                fieldPath: request.data.fieldPath,
                resolveOptionalAccess,
            });
            if (!authorization) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_action_form_connected_account_options_unavailable',
                });
            }
            if (!isExpectedPluginOccurrenceCurrent(
                lease.registry,
                authorization.action.pluginId,
                request.data.expectedOccurrenceId,
            )) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
                });
            }
            if (!isCurrentConnectedAccountActionFormTarget(
                    lease.registry,
                    authorization.action,
                )) {
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
            const currentAuthorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
                registry: lease.registry.contributes,
                qualifiedActionId: request.data.qualifiedActionId,
                fieldPath: request.data.fieldPath,
                resolveOptionalAccess,
            });
            if (
                !currentAuthorization
                || currentAuthorization.action.pluginId !== authorization.action.pluginId
                || currentAuthorization.action.localId !== authorization.action.localId
                || currentAuthorization.purpose.purpose !== authorization.purpose.purpose
                || !sameConnectedAccountServiceRefs(
                    currentAuthorization.serviceRefs,
                    authorization.serviceRefs,
                )
                || !isExpectedPluginOccurrenceCurrent(
                    lease.registry,
                    currentAuthorization.action.pluginId,
                    request.data.expectedOccurrenceId,
                )
                || !isCurrentConnectedAccountActionFormTarget(
                    lease.registry,
                    currentAuthorization.action,
                )
            ) {
                return DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
                    ok: false,
                    code: 'plugin_occurrence_stale',
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
            if (request.data.artifactFamily === 'reactNative') {
                const owner = [
                    ...collectResolvedGeneratedReactNativeArtifactOwners(lease.registry.contributes),
                    ...collectResolvedGeneratedReactNativeClientContributionArtifactOwners(lease.registry.contributes),
                ]
                    .filter((candidate) => findGeneratedReactNativeArtifactGraph({
                        owner: candidate,
                        identity: request.data.cacheIdentity,
                    }) !== null)
                    .sort((left, right) => (
                        left.pluginId.localeCompare(right.pluginId)
                        || left.contributionId.localeCompare(right.contributionId)
                    ))[0] ?? null;
                if (!owner) {
                    return artifactBytesError('artifact_not_found', ['generated_react_native_artifact_owner_not_found']);
                }
                return await readGeneratedReactNativeArtifactBytesByCacheIdentity({
                    registry: lease.registry.contributes,
                    owner,
                    identity: request.data.cacheIdentity,
                    ...(opts?.readArtifactFile ? { readArtifactFile: opts.readArtifactFile } : {}),
                });
            }

            const response = await readHostedWebArtifactBytesByCacheIdentity({
                registry: lease.registry.contributes,
                identity: request.data.cacheIdentity,
                ...(opts?.readArtifactFile ? { readArtifactFile: opts.readArtifactFile } : {}),
            });
            return response;
        } finally {
            await lease.release();
        }
    });
}
