import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import {
    isRenderableHostRendererId,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_SURFACE_REGISTRY,
    PluginHostedWebSecurityPolicyV1Schema,
    type PluginUiArtifactsManifestEntryV1,
    type PluginSurfaceRuntimeModeV1,
} from '@happier-dev/protocol/plugins/ui';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import {
    deriveReactNativeBundleRuntimeCacheKey,
    deriveReactNativeNativeCapabilitiesDigest,
    type ReactNativeBundleCacheIdentity,
    type ReactNativeBundleHostRuntime,
} from '@/plugins/install/ui/reactNativeBundles';
import type {
    ResolvedContributionRegistry,
    ResolvedHostedWebContribution,
    ResolvedReactNativeBundleContribution,
    ResolvedSessionHeaderActionContribution,
    ResolvedStructuredMessageContribution,
    ResolvedSurfacePlacementContribution,
    ResolvedUiArtifactContribution,
    ResolvedUiRendererV2Contribution,
    ResolvedUiTranslationBundleV2Contribution,
    ResolvedUiTranslationsContribution,
    ResolvedUiViewV2Contribution,
} from '../types';
import { resolveHostedWebRuntimeBinding } from './hostedWebBuild';
import {
    resolveReactNativeBundleRuntimeProjection,
    type ReactNativeBundleRuntimeProjection,
} from './reactNativeRuntime';
import {
    projectStructuredMessages,
    type StructuredMessageProjectionHostRuntimeContext,
} from './structuredMessages';
import {
    collectResolvedGeneratedReactNativeArtifactOwners,
    findGeneratedReactNativeArtifactEntry,
} from './generatedUiArtifactOwners';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';

type PluginUiProjectedEntry = Readonly<Record<string, unknown> & {
    id: string;
    pluginId?: string;
    contributionKind: string;
}>;

export type ReactNativeBundleProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
    // Phase 6.3: the `plugins.ui.reactNativeBundles.devHotReload` author gate. A
    // separate kill-switch from the family feature; only authorises the
    // dev-server source for a local plugin on the development channel.
    devHotReloadEnabled?: boolean;
    loaderBackendAvailable?: boolean;
    loaderBackendDiagnostics?: readonly string[];
    crashDisabledContributionIds?: readonly string[];
    crashDisabledByContributionId?: Readonly<Record<string, boolean>>;
    hostRuntime?: Partial<ReactNativeBundleHostRuntime>;
}>;

export type HostedWebProjectionHostRuntimeContext = Readonly<{
    featureEnabled?: boolean;
}>;

export type DeclarativeProjectionHostRuntimeContext = Readonly<{
    modelsByRendererKey?: Readonly<Record<string, StablePluginDeclarativeModel | undefined>>;
}>;

export type PluginUiProjectionHostRuntimeContext = Readonly<{
    hostedWeb?: HostedWebProjectionHostRuntimeContext;
    declarative?: DeclarativeProjectionHostRuntimeContext;
    reactNativeBundles?: ReactNativeBundleProjectionHostRuntimeContext;
    structuredMessages?: StructuredMessageProjectionHostRuntimeContext;
}>;

function digestJson(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function readPluginId(entry: Readonly<{ pluginId?: string }>): string | null {
    const pluginId = entry.pluginId?.trim();
    return pluginId && pluginId.length > 0 ? pluginId : null;
}

function addEntry(
    entriesById: Record<string, PluginUiProjectedEntry>,
    entry: PluginUiProjectedEntry,
): void {
    // §13.5.6 id-uniqueness / §10 "no silent drop": the projection is one id-keyed
    // model, so a second contribution sharing an already-projected id (same plugin +
    // kind + descriptorId) would otherwise be a silent last-write-wins overwrite that
    // hides a malformed plugin. Preserve last-write-wins (no behavior change to which
    // record survives) but tag the survivor with a `duplicate_contribution_id`
    // diagnostic so the collision is diagnosable instead of dropped.
    const collides = Object.prototype.hasOwnProperty.call(entriesById, entry.id);
    const projected: PluginUiProjectedEntry = collides
        ? {
            ...entry,
            diagnostics: Object.freeze([
                ...readStringArray(entry.diagnostics),
                'duplicate_contribution_id',
            ]),
        }
        : entry;
    entriesById[entry.id] = Object.freeze(projected);
}

function projectTranslations(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const v2ByPluginId = new Map<string, ResolvedUiTranslationBundleV2Contribution[]>();
    const sortedV2 = [...(registry.uiTranslationsV2 ?? [])].sort((left, right) => {
        const leftPluginId = readPluginId(left) ?? '';
        const rightPluginId = readPluginId(right) ?? '';
        if (leftPluginId !== rightPluginId) return leftPluginId.localeCompare(rightPluginId);
        if (left.definition.locale !== right.definition.locale) {
            return left.definition.locale.localeCompare(right.definition.locale);
        }
        const leftOwner = `${left.manifestPath ?? ''}\0${left.manifestDigest ?? ''}\0${JSON.stringify(left.definition)}`;
        const rightOwner = `${right.manifestPath ?? ''}\0${right.manifestDigest ?? ''}\0${JSON.stringify(right.definition)}`;
        return leftOwner.localeCompare(rightOwner);
    });
    for (const contribution of sortedV2) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) continue;
        const contributions = v2ByPluginId.get(pluginId) ?? [];
        contributions.push(contribution);
        v2ByPluginId.set(pluginId, contributions);
    }
    for (const [pluginId, contributions] of [...v2ByPluginId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const bundles: Record<string, Readonly<Record<string, string>>> = {};
        const duplicateLocales = new Set<string>();
        for (const contribution of contributions) {
            const locale = contribution.definition.locale;
            if (Object.hasOwn(bundles, locale)) duplicateLocales.add(locale);
            bundles[locale] = Object.freeze(Object.fromEntries(
                Object.entries(contribution.definition.messages).sort(([left], [right]) => left.localeCompare(right)),
            ));
        }
        addEntry(entriesById, {
            id: `translations:${pluginId}`,
            pluginId,
            contributionKind: 'translations',
            locales: Object.freeze(Object.keys(bundles).sort()),
            bundles: Object.freeze(bundles),
            ...(duplicateLocales.size > 0
                ? { diagnostics: Object.freeze(['duplicate_translation_locale']) }
                : {}),
        });
    }

    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId || v2ByPluginId.has(pluginId)) {
            continue;
        }
        const id = `translations:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'translations',
            defaultLocale: contribution.definition.defaultLocale,
            locales: Object.keys(contribution.definition.locales).sort(),
            bundles: contribution.definition.locales,
        });
    }
}

function projectSessionHeaderActions(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `sessionHeaderAction:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'sessionHeaderAction',
            descriptorId: contribution.definition.id,
            title: contribution.definition.title,
            description: contribution.definition.description,
            action: contribution.definition.action,
            order: contribution.definition.order,
            availability: contribution.definition.availability,
            metadata: contribution.definition.metadata,
        });
    }
}

function hostedWebRuntimeResult(params: Readonly<{
    state: 'available' | 'fallback';
    reason:
        | 'available'
        | 'feature_disabled'
        | 'hosted_web_static_artifact_missing'
        | 'hosted_web_url_runtime_unavailable';
    diagnostics: readonly string[];
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'available' ? 'render' : 'fallback',
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
        }),
    });
}

function projectHostedWeb(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    hostRuntimeContext?: HostedWebProjectionHostRuntimeContext,
    v2OwnedContributionKeys: ReadonlySet<string> = new Set(),
): void {
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        if (v2OwnedContributionKeys.has(`${pluginId}\0${contribution.definition.id}`)) {
            continue;
        }
        const id = `hostedWeb:${pluginId}:${contribution.definition.id}`;
        const runtimeBinding = resolveHostedWebRuntimeBinding({
            contribution,
            uiArtifacts: registry.uiArtifacts ?? [],
        });
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const runtime = !featureEnabled
            ? hostedWebRuntimeResult({
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            })
            : runtimeBinding.ok
                ? hostedWebRuntimeResult({
                    state: 'available',
                    reason: 'available',
                    diagnostics: runtimeBinding.diagnostics,
                })
                : hostedWebRuntimeResult({
                    state: 'fallback',
                    reason: 'hosted_web_static_artifact_missing',
                    diagnostics: runtimeBinding.diagnostics,
                });
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'hostedWeb',
            contributionId: contribution.definition.id,
            service: contribution.definition.service,
            ...(featureEnabled && runtimeBinding.ok ? { runtimeMode: runtimeBinding.runtimeMode } : {}),
            runtimeDiagnostics: runtime.diagnostics,
            runtime,
            entry: contribution.definition.entry,
            bridge: contribution.definition.bridge,
            sandbox: contribution.definition.sandbox,
            security: contribution.definition.security,
            display: contribution.definition.display,
            compatibility: contribution.definition.compatibility,
            fallback: contribution.definition.fallback,
        });
    }
}

function projectGeneratedHostedWebRenderers(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    hostRuntimeContext?: HostedWebProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const ownedContributionKeys = new Set<string>();
    for (const renderer of registry.uiRenderersV2 ?? []) {
        if (renderer.definition.kind !== 'hostedWeb') continue;
        const pluginId = renderer.pluginId;
        const contributionId = renderer.definition.id;
        ownedContributionKeys.add(`${pluginId}\0${contributionId}`);
        const source = renderer.definition.source;
        const candidates = source.kind === 'artifact'
            ? renderer.generatedUiArtifactsManifest?.entries.filter((entry) => (
                entry.contributionId === source.artifact
                && entry.tier === 'hostedWeb'
                && entry.platform === 'web'
            )) ?? []
            : [];
        const artifact = candidates.length === 1 ? candidates[0]! : null;
        const assetRootId = artifact ? posix.dirname(artifact.entry) : null;
        const graphValid = Boolean(
            artifact
            && renderer.pluginRootPath
            && assetRootId
            && assetRootId !== '.'
            && artifact.hostUiApiVersion === PLUGIN_UI_HOST_API_VERSION_V1
            && new Set(artifact.files.map((file) => file.relativePath)).size === artifact.files.length
            && artifact.files.some((file) => file.relativePath === artifact.entry)
            && artifact.files.every((file) => file.relativePath.startsWith(`${assetRootId}/`)),
        );
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const failure = source.kind !== 'artifact'
            ? 'hosted_web_url_runtime_unavailable'
            : !graphValid
                ? 'hosted_web_static_artifact_missing'
                : !featureEnabled
                    ? 'feature_disabled'
                    : null;
        const runtime = failure
            ? hostedWebRuntimeResult({ state: 'fallback', reason: failure, diagnostics: [failure] })
            : hostedWebRuntimeResult({ state: 'available', reason: 'available', diagnostics: [] });
        const requiredHostMethods = renderer.definition.requiredHostMethods ?? [];
        const allowedMessages = Object.freeze([
            ...(requiredHostMethods.some((method) => method === 'context' || method === 'watchContext')
                ? ['ready' as const]
                : []),
            ...(requiredHostMethods.includes('executeAction') ? ['requestHostAction' as const] : []),
            ...(requiredHostMethods.includes('readResource') ? ['requestSessionResource' as const] : []),
            ...(requiredHostMethods.includes('watchResource')
                ? ['subscribeResource' as const, 'unsubscribeResource' as const]
                : []),
            ...(requiredHostMethods.includes('openSurface') ? ['openSurface' as const] : []),
            ...(requiredHostMethods.includes('diagnostic') ? ['logDiagnostic' as const] : []),
            ...(requiredHostMethods.includes('openExternalLink') ? ['openExternal' as const] : []),
            ...(requiredHostMethods.includes('writeClipboard') ? ['copy' as const] : []),
        ]);
        addEntry(entriesById, {
            id: `hostedWeb:${pluginId}:${contributionId}`,
            pluginId,
            pluginVersion: renderer.pluginVersion ?? '0.0.0',
            contributionKind: 'hostedWeb',
            contributionId,
            generatedV2: true,
            source,
            service: Object.freeze({
                kind: 'staticAssets' as const,
                assetRootId: assetRootId ?? `hosted-web/${contributionId}`,
            }),
            ...(artifact && graphValid && featureEnabled
                ? {
                    runtimeMode: Object.freeze({
                        kind: 'installedStaticAssets' as const,
                        artifactId: source.kind === 'artifact' ? source.artifact : contributionId,
                        assetRootId,
                    }),
                    artifactGraph: artifact,
                }
                : {}),
            entry: Object.freeze({ routeMode: 'pathFallback' as const, path: '/' }),
            bridge: Object.freeze({ allowedMessages }),
            sandbox: Object.freeze({
                scripts: true,
                sameOrigin: false,
                popups: false,
                topNavigation: false,
                mixedContent: false,
            }),
            security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
            runtimeDiagnostics: runtime.diagnostics,
            runtime,
        });
    }
    return ownedContributionKeys;
}

function findReactNativeBundleArtifact(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
}>): ResolvedUiArtifactContribution | null {
    const pluginId = readPluginId(params.contribution);
    if (!pluginId) {
        return null;
    }

    const bundle = params.contribution.definition.bundle;
    return params.uiArtifacts.find((artifact) => artifact.pluginId === pluginId
        && artifact.definition.contributionId === params.contribution.definition.id
        && artifact.definition.contributionFamily === 'reactNativeBundles'
        && artifact.definition.artifactKind === 'reactNativeBundle'
        && artifact.definition.platform === bundle.platform
        && artifact.definition.channel === bundle.channel
        && reactNativeArtifactIdentityMatchesBundle(artifact.definition, bundle)) ?? null;
}

function reactNativeArtifactIdentityMatchesBundle(
    artifact: ResolvedUiArtifactContribution['definition'],
    bundle: ResolvedReactNativeBundleContribution['definition']['bundle'],
): boolean {
    const artifactDigest = artifact.integrity?.digest;
    const bundleDigest = bundle.integrity?.digest;
    if (artifactDigest && bundleDigest) {
        return artifactDigest === bundleDigest;
    }
    return artifact.channel === 'development'
        && bundle.channel === 'development'
        && artifact.devUrl !== undefined
        && artifact.assetPath === undefined
        && artifact.url === undefined
        && artifactDigest === undefined
        && bundleDigest === undefined;
}

function toReactNativeExecutableArtifactManifest(
    artifact: ResolvedUiArtifactContribution | null,
): unknown {
    const pluginId = artifact ? readPluginId(artifact) : null;
    if (!artifact || !pluginId) {
        return undefined;
    }

    return Object.freeze({
        ...artifact.definition,
        pluginId,
    });
}

function resolveProjectionHostRuntime(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    artifact: ResolvedUiArtifactContribution | null;
    generation: number;
    hostRuntime?: Partial<ReactNativeBundleHostRuntime>;
}>): ReactNativeBundleHostRuntime {
    const artifactCompatibility = params.artifact?.definition.compatibility;
    const bundleCompatibility = params.contribution.definition.compatibility;
    const hostRuntime = params.hostRuntime;
    return Object.freeze({
        hostAppVersion: hostRuntime?.hostAppVersion ?? artifactCompatibility?.hostAppVersion ?? '0.0.0',
        hostUiApiVersion: hostRuntime?.hostUiApiVersion ?? artifactCompatibility?.hostUiApiVersion ?? bundleCompatibility.hostUiApiVersion,
        reactVersion: hostRuntime?.reactVersion ?? artifactCompatibility?.reactVersion ?? bundleCompatibility.reactVersion,
        reactNativeVersion: hostRuntime?.reactNativeVersion ?? artifactCompatibility?.reactNativeVersion ?? bundleCompatibility.reactNativeVersion,
        ...(hostRuntime?.expoRuntimeVersion ?? artifactCompatibility?.expoRuntimeVersion
            ? { expoRuntimeVersion: hostRuntime?.expoRuntimeVersion ?? artifactCompatibility?.expoRuntimeVersion }
            : {}),
        ...(hostRuntime?.hermesVersion ?? artifactCompatibility?.hermesVersion
            ? { hermesVersion: hostRuntime?.hermesVersion ?? artifactCompatibility?.hermesVersion }
            : {}),
        platform: hostRuntime?.platform ?? params.artifact?.definition.platform ?? params.contribution.definition.bundle.platform,
        channel: hostRuntime?.channel ?? params.artifact?.definition.channel ?? params.contribution.definition.bundle.channel,
        availableNativeCapabilities: Object.freeze([
            ...(hostRuntime?.availableNativeCapabilities ?? artifactCompatibility?.nativeCapabilities ?? []),
        ]),
        projectionGeneration: hostRuntime?.projectionGeneration ?? params.generation,
    });
}

/**
 * Phase 6.3: classify the contribution's install provenance into the plugin
 * source bucket the dev-hot-reload scope checks against. First-party/bundled are
 * `internal`; an explicit local path is `local`; remote marketplace/package
 * sources are `marketplace`. This is development-source classification for the
 * gated hot-reload affordance, not an executable trust decision.
 */
function resolveReactNativePluginSource(
    contribution: Readonly<{
        provenance?: string;
        source?: Readonly<{ kind?: string }>;
    }>,
): 'local' | 'internal' | 'marketplace' | 'external' {
    if (contribution.provenance === 'first_party' || contribution.source?.kind === 'bundled') {
        return 'internal';
    }
    if (contribution.source?.kind === 'path') {
        return 'local';
    }
    if (contribution.source?.kind === 'marketplace' || contribution.source?.kind === 'package') {
        return 'marketplace';
    }
    return 'external';
}

// NATIVE-PIPELINE / LEDGER DEC-6 follow-up: a logical `reactNative` surface can
// now carry multiple platform-specific bundle sibling contributions sharing the
// same `id` (see `resolvePluginReactNativeBundleRegistryId` in
// `createResolvedContributionRegistry.ts`). When the connecting client's own
// reported platform (`hostRuntimeContext.hostRuntime.platform`) does not
// disambiguate to exactly one sibling — because it is unreported, or reported
// but matches none of the declared platforms — this diagnostic marks the
// projected entry as honestly unavailable instead of guessing a sibling. This
// is a real, distinct failure mode (ambiguous platform selection), not the
// same as a `runtime_mismatch` version/platform incompatibility on a SINGLE
// resolved artifact.
const REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC = 'react_native_bundle_platform_unresolved';

function mapReactNativeRuntimeDecisionReason(
    runtime: ReactNativeBundleRuntimeProjection,
): 'compatible' | 'feature_disabled' | 'runtime_mismatch' | 'missing_native_capability' | 'crash_disabled' | 'dev_hot_reload_denied' | 'platform_unavailable' | 'unknown' {
    if (runtime.state === 'loadable') {
        return 'compatible';
    }
    if (runtime.diagnostics.includes(REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC)) {
        return 'platform_unavailable';
    }
    if (runtime.diagnostics.includes('feature_disabled')) {
        return 'feature_disabled';
    }
    if (runtime.diagnostics.includes('dev_hot_reload_denied')) {
        return 'dev_hot_reload_denied';
    }
    if (runtime.diagnostics.includes('runtime_mismatch')) {
        return 'runtime_mismatch';
    }
    if (runtime.diagnostics.includes('missing_native_capability')) {
        return 'missing_native_capability';
    }
    if (runtime.diagnostics.includes('crash_threshold_reached')) {
        return 'crash_disabled';
    }
    return 'unknown';
}

function mapReactNativeRuntimeDecisionState(
    runtime: ReactNativeBundleRuntimeProjection,
): 'load' | 'fallback' | 'disabled' | 'blocked' {
    if (runtime.state === 'loadable') {
        return 'load';
    }
    return runtime.state;
}

function projectReactNativeRuntime(params: Readonly<{
    contribution: ResolvedReactNativeBundleContribution;
    uiArtifacts: readonly ResolvedUiArtifactContribution[];
    generation: number;
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext;
    // NATIVE-PIPELINE: true when `params.contribution` is only a REPRESENTATIVE
    // pick among platform siblings sharing the same logical id — the connecting
    // client's platform did not disambiguate to exactly one. The runtime decision
    // must fail honestly-unavailable rather than validate the representative's
    // own platform against itself (which would always spuriously "match").
    platformUnresolved?: boolean;
}>): Readonly<Record<string, unknown>> {
    const pluginId = readPluginId(params.contribution);
    const contributionKey = `${pluginId ?? ''}:${params.contribution.definition.id}`;
    const crashDisabled = params.hostRuntimeContext?.crashDisabledByContributionId?.[contributionKey] === true
        || params.hostRuntimeContext?.crashDisabledByContributionId?.[params.contribution.definition.id] === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(contributionKey) === true
        || params.hostRuntimeContext?.crashDisabledContributionIds?.includes(params.contribution.definition.id) === true;
    const artifact = params.platformUnresolved
        ? null
        : findReactNativeBundleArtifact({
            contribution: params.contribution,
            uiArtifacts: params.uiArtifacts,
        });
    const runtime: ReactNativeBundleRuntimeProjection = params.platformUnresolved
        ? Object.freeze({
            state: 'fallback',
            diagnostics: Object.freeze([REACT_NATIVE_BUNDLE_PLATFORM_UNRESOLVED_DIAGNOSTIC]),
        })
        : resolveReactNativeBundleRuntimeProjection({
            bundle: {
                pluginId: pluginId ?? '',
                contributionId: params.contribution.definition.id,
                fallback: params.contribution.definition.fallback,
            },
            artifact: toReactNativeExecutableArtifactManifest(artifact),
            hostRuntime: resolveProjectionHostRuntime({
                contribution: params.contribution,
                artifact,
                generation: params.generation,
                hostRuntime: params.hostRuntimeContext?.hostRuntime,
            }),
            featureEnabled: params.hostRuntimeContext?.featureEnabled === true,
            loaderBackendAvailable: params.hostRuntimeContext?.loaderBackendAvailable ?? false,
            loaderBackendDiagnostics: params.hostRuntimeContext?.loaderBackendDiagnostics,
            crashDisabled,
            devHotReloadEnabled: params.hostRuntimeContext?.devHotReloadEnabled === true,
            pluginSource: resolveReactNativePluginSource(params.contribution),
        });
    const decision = Object.freeze({
        state: mapReactNativeRuntimeDecisionState(runtime),
        reason: mapReactNativeRuntimeDecisionReason(runtime),
        diagnostics: Object.freeze([...runtime.diagnostics]),
        ...(params.contribution.definition.fallback ? { fallback: params.contribution.definition.fallback } : {}),
    });

    const runtimeCacheKey = 'cacheKey' in runtime ? runtime.cacheKey : undefined;
    const runtimeCacheIdentity = 'cacheIdentity' in runtime ? runtime.cacheIdentity : undefined;
    return Object.freeze({
        state: runtime.state,
        diagnostics: Object.freeze([...runtime.diagnostics]),
        decision,
        ...(runtimeCacheKey ? { cacheKey: runtimeCacheKey } : {}),
        ...(runtimeCacheIdentity ? { cacheIdentity: runtimeCacheIdentity } : {}),
        ...(runtime.loadPolicy ? { loadPolicy: runtime.loadPolicy } : {}),
    });
}

type ReactNativeBundlePlatformFamily = Readonly<{
    pluginId: string;
    contributionId: string;
    contributions: readonly ResolvedReactNativeBundleContribution[];
}>;

/**
 * NATIVE-PIPELINE / LEDGER DEC-6 follow-up (item 1): group the registry's
 * `reactNativeBundles` array — which can now legally hold multiple entries
 * sharing the SAME logical `id` as long as each declares a different
 * `bundle.platform` (see `resolvePluginReactNativeBundleRegistryId`) — into one
 * family per `pluginId:id`. This is the ONE place a placement's `renderer`
 * (which references a bare `contributionId`, platform-agnostic by design) gets
 * resolved down to a concrete per-platform bundle.
 */
function groupReactNativeBundleContributionsByLogicalId(
    contributions: readonly ResolvedReactNativeBundleContribution[],
): readonly ReactNativeBundlePlatformFamily[] {
    const familiesByKey = new Map<string, {
        pluginId: string;
        contributionId: string;
        contributions: ResolvedReactNativeBundleContribution[];
    }>();
    const order: string[] = [];
    for (const contribution of contributions) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const key = `${pluginId}:${contribution.definition.id}`;
        let family = familiesByKey.get(key);
        if (!family) {
            family = { pluginId, contributionId: contribution.definition.id, contributions: [] };
            familiesByKey.set(key, family);
            order.push(key);
        }
        family.contributions.push(contribution);
    }
    return Object.freeze(order.map((key) => {
        const family = familiesByKey.get(key)!;
        return Object.freeze({
            pluginId: family.pluginId,
            contributionId: family.contributionId,
            contributions: Object.freeze([...family.contributions].sort(
                (left, right) => left.definition.bundle.platform.localeCompare(right.definition.bundle.platform),
            )),
        });
    }));
}

/**
 * Selects the sibling contribution matching the connecting client's own
 * reported runtime platform (`hostRuntimeContext.hostRuntime.platform` —
 * populated per-request from the client's `reactNativeHostRuntimeIdentity`,
 * see `apps/cli/src/plugins/projection/registry/ui/hostRuntime.ts`). A family
 * with exactly one declared platform resolves unambiguously regardless of
 * whether the client has reported its platform yet (unchanged, pre-existing
 * single-platform behavior — most plugins declare only one). A family with
 * MULTIPLE declared platforms can only resolve when the connecting platform is
 * known and matches one of them; otherwise selection is genuinely ambiguous
 * and `unresolved: true` signals the caller to fail the runtime decision
 * closed instead of guessing.
 */
function selectReactNativeBundleContributionForConnectingPlatform(
    family: ReactNativeBundlePlatformFamily,
    connectingPlatform: string | undefined,
): Readonly<{ contribution: ResolvedReactNativeBundleContribution; unresolved: boolean }> {
    if (family.contributions.length <= 1) {
        return Object.freeze({ contribution: family.contributions[0]!, unresolved: false });
    }
    const matching = connectingPlatform
        ? family.contributions.find((candidate) => candidate.definition.bundle.platform === connectingPlatform)
        : undefined;
    if (matching) {
        return Object.freeze({ contribution: matching, unresolved: false });
    }
    return Object.freeze({ contribution: family.contributions[0]!, unresolved: true });
}

function projectReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext,
    v2OwnedContributionKeys: ReadonlySet<string> = new Set(),
): void {
    const uiArtifacts = registry.uiArtifacts ?? [];
    const connectingPlatform = hostRuntimeContext?.hostRuntime?.platform;
    const families = groupReactNativeBundleContributionsByLogicalId(registry.reactNativeBundles ?? []);
    for (const family of families) {
        if (v2OwnedContributionKeys.has(`${family.pluginId}\0${family.contributionId}`)) {
            continue;
        }
        const { contribution, unresolved } = selectReactNativeBundleContributionForConnectingPlatform(
            family,
            connectingPlatform,
        );
        const id = `reactNativeBundle:${family.pluginId}:${family.contributionId}`;
        addEntry(entriesById, {
            id,
            pluginId: family.pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: family.contributionId,
            bundle: contribution.definition.bundle,
            entry: contribution.definition.entry,
            compatibility: contribution.definition.compatibility,
            hostApi: contribution.definition.hostApi,
            nativeCapabilities: contribution.definition.nativeCapabilities,
            fallback: contribution.definition.fallback,
            display: contribution.definition.display,
            policy: contribution.definition.policy,
            // Diagnosable, not authoritative: the platforms this logical surface
            // declares a bundle for. `bundle.platform` above is the one actually
            // selected/evaluated for the connecting client.
            availablePlatforms: family.contributions.map((sibling) => sibling.definition.bundle.platform),
            runtime: projectReactNativeRuntime({
                contribution,
                uiArtifacts,
                generation,
                hostRuntimeContext,
                platformUnresolved: unresolved,
            }),
        });
    }
}

function generatedReactNativeRuntimeResult(params: Readonly<{
    state: 'loadable' | 'fallback' | 'blocked';
    reason: string;
    diagnostics: readonly string[];
    cacheIdentity?: ReactNativeBundleCacheIdentity;
}>): Readonly<Record<string, unknown>> {
    return Object.freeze({
        state: params.state,
        diagnostics: Object.freeze([...params.diagnostics]),
        decision: Object.freeze({
            state: params.state === 'loadable' ? 'load' : params.state,
            reason: params.reason,
            diagnostics: Object.freeze([...params.diagnostics]),
        }),
        ...(params.cacheIdentity
            ? {
                cacheKey: deriveReactNativeBundleRuntimeCacheKey(params.cacheIdentity),
                cacheIdentity: params.cacheIdentity,
                loadPolicy: Object.freeze({ source: 'installedArtifact' as const }),
            }
            : {}),
    });
}

function generatedReactNativeCompatibilityFailure(params: Readonly<{
    entry: PluginUiArtifactsManifestEntryV1;
    hostRuntime: Partial<ReactNativeBundleHostRuntime> | undefined;
}>): string | null {
    const host = params.hostRuntime;
    if (!host) return 'generated_react_native_host_runtime_unavailable';
    if (params.entry.hostUiApiVersion !== host.hostUiApiVersion) {
        return 'generated_react_native_host_api_mismatch';
    }
    if (params.entry.compat.react !== host.reactVersion
        || params.entry.compat.reactNative !== host.reactNativeVersion
        || (params.entry.compat.expoRuntime ?? '') !== (host.expoRuntimeVersion ?? '')
        || (params.entry.compat.hermes ?? '') !== (host.hermesVersion ?? '')) {
        return 'generated_react_native_runtime_mismatch';
    }
    return null;
}

function projectGeneratedReactNativeBundles(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    generation: number,
    hostRuntimeContext?: ReactNativeBundleProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const ownedContributionKeys = new Set<string>();
    for (const owner of collectResolvedGeneratedReactNativeArtifactOwners(registry)) {
        const pluginId = owner.pluginId;
        const contributionId = owner.contributionId;
        ownedContributionKeys.add(`${pluginId}\0${contributionId}`);

        const resolved = findGeneratedReactNativeArtifactEntry({
            owner,
            platform: hostRuntimeContext?.hostRuntime?.platform,
        });
        const compatibilityFailure = resolved.entry
            ? generatedReactNativeCompatibilityFailure({
                entry: resolved.entry,
                hostRuntime: hostRuntimeContext?.hostRuntime,
            })
            : null;
        const failure = resolved.failure ?? compatibilityFailure;
        const entry = resolved.entry;
        const featureEnabled = hostRuntimeContext?.featureEnabled === true;
        const loaderBackendAvailable = hostRuntimeContext?.loaderBackendAvailable === true;
        const hostRuntime = hostRuntimeContext?.hostRuntime;
        const cacheIdentity: ReactNativeBundleCacheIdentity | undefined =
            entry && entry.platform && !failure && featureEnabled && loaderBackendAvailable && hostRuntime
            ? Object.freeze({
                pluginId,
                contributionId,
                artifactDigest: entry.digest,
                hostAppVersion: hostRuntime.hostAppVersion ?? '0.0.0',
                hostUiApiVersion: entry.hostUiApiVersion,
                reactVersion: entry.compat.react,
                reactNativeVersion: entry.compat.reactNative ?? '',
                ...(entry.compat.expoRuntime ? { expoRuntimeVersion: entry.compat.expoRuntime } : {}),
                ...(entry.compat.hermes ? { hermesVersion: entry.compat.hermes } : {}),
                platform: entry.platform,
                channel: hostRuntime.channel ?? 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest([]),
                projectionGeneration: hostRuntime.projectionGeneration ?? generation,
            })
            : undefined;
        const runtime = failure
            ? generatedReactNativeRuntimeResult({
                state: 'blocked',
                reason: failure,
                diagnostics: [failure],
            })
            : !featureEnabled
                ? generatedReactNativeRuntimeResult({
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                })
                : !loaderBackendAvailable
                    ? generatedReactNativeRuntimeResult({
                        state: 'fallback',
                        reason: 'loader_backend_unavailable',
                        diagnostics: hostRuntimeContext?.loaderBackendDiagnostics?.length
                            ? hostRuntimeContext.loaderBackendDiagnostics
                            : ['loader_backend_unavailable'],
                    })
                    : generatedReactNativeRuntimeResult({
                        state: 'loadable',
                        reason: 'compatible',
                        diagnostics: [],
                        cacheIdentity,
                    });

        addEntry(entriesById, {
            id: `reactNativeBundle:${pluginId}:${contributionId}`,
            pluginId,
            pluginVersion: owner.pluginVersion ?? '0.0.0',
            contributionKind: 'reactNativeBundle',
            contributionId,
            generatedV2: true,
            generatedOwnerKind: owner.kind,
            requiredHostMethods: owner.requiredHostMethods,
            bundle: Object.freeze({
                platform: entry?.platform ?? hostRuntimeContext?.hostRuntime?.platform ?? 'web',
                channel: hostRuntimeContext?.hostRuntime?.channel ?? 'internal',
                ...(entry ? { integrity: Object.freeze({ digest: entry.digest }) } : {}),
            }),
            entry: entry?.repack
                ? Object.freeze({
                    containerName: entry.repack.containerName,
                    modulePath: entry.repack.modulePath,
                    exportName: entry.repack.exportName,
                })
                : Object.freeze({ exportName: 'renderSurface' as const }),
            compatibility: entry
                ? Object.freeze({
                    hostUiApiVersion: entry.hostUiApiVersion,
                    reactVersion: entry.compat.react,
                    reactNativeVersion: entry.compat.reactNative,
                    ...(entry.compat.expoRuntime ? { expoRuntimeVersion: entry.compat.expoRuntime } : {}),
                    ...(entry.compat.hermes ? { hermesVersion: entry.compat.hermes } : {}),
                    supportedPlatforms: Object.freeze([entry.platform]),
                    supportedChannels: Object.freeze([hostRuntimeContext?.hostRuntime?.channel ?? 'internal']),
                    requiredNativeCapabilities: Object.freeze([]),
                })
                : undefined,
            hostApi: Object.freeze({
                minVersion: entry?.hostUiApiVersion ?? '1.0.0',
                methods: Object.freeze([...owner.requiredHostMethods]),
            }),
            fallback: Object.freeze({ kind: 'unavailable' as const }),
            ...(entry ? { artifactGraph: entry } : {}),
            runtime,
        });
    }
    return ownedContributionKeys;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? Object.freeze(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))
        : Object.freeze([]);
}

function resolveRendererProjectionEntry(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): PluginUiProjectedEntry | null {
    const contributionId = typeof params.renderer.contributionId === 'string'
        ? params.renderer.contributionId.trim()
        : '';
    if (contributionId.length === 0) {
        return null;
    }
    if (params.renderer.kind === 'hostedWeb') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`hostedWeb:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    if (params.renderer.kind === 'reactNative') {
        return params.entriesById[contributionId]
            ?? params.entriesById[`reactNativeBundle:${params.pluginId}:${contributionId}`]
            ?? null;
    }
    return null;
}

function projectSurfaceAvailability(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    if (params.renderer.kind === 'host') {
        // PR-12: a `{kind:'host'}` renderer reports `available` only when its
        // renderer id is in the pure protocol set the UI host can actually render
        // through its renderer-id dispatch table. Otherwise it falls back, so
        // projection-availability and the real render path cannot disagree.
        const rendererId = typeof params.renderer.rendererId === 'string'
            ? params.renderer.rendererId
            : null;
        if (isRenderableHostRendererId(rendererId)) {
            return Object.freeze({
                state: 'available',
                reason: 'available',
                diagnostics: Object.freeze([]),
            });
        }
        return Object.freeze({
            state: 'fallback',
            reason: 'host_renderer_unavailable',
            diagnostics: Object.freeze(['host_renderer_unavailable']),
        });
    }

    if (params.renderer.kind === 'declarative') {
        // Source-authored declarative nodes are not an evaluated runtime model:
        // action enabled/currentness and settings values remain daemon-owned.
        // Project the bounded renderer shape for the host, but keep the surface
        // inert until the canonical stable declarative model is supplied.
        return Object.freeze({
            state: 'fallback',
            reason: 'declarative_model_unavailable',
            diagnostics: Object.freeze(['declarative_model_unavailable']),
        });
    }

    const entry = resolveRendererProjectionEntry(params);
    if (!entry) {
        return Object.freeze({
            state: 'fallback',
            reason: 'renderer_unavailable',
            diagnostics: Object.freeze(['renderer_unavailable']),
        });
    }

    const runtime = readRecord(entry.runtime);
    const decision = readRecord(runtime?.decision);
    const decisionState = typeof decision?.state === 'string' ? decision.state : '';
    const decisionReason = typeof decision?.reason === 'string' && decision.reason.trim().length > 0
        ? decision.reason
        : 'unknown';
    const diagnostics = readStringArray(decision?.diagnostics);
    if (decisionState === 'render' || decisionState === 'load') {
        return Object.freeze({
            state: 'available',
            reason: 'available',
            diagnostics,
        });
    }
    if (decisionState === 'blocked' || decisionState === 'disabled') {
        return Object.freeze({
            state: decisionState,
            reason: decisionReason,
            diagnostics,
        });
    }
    return Object.freeze({
        state: 'fallback',
        reason: decisionReason,
        diagnostics,
    });
}

const RIGHT_SIDEBAR_RESERVED_TAB_IDS = new Set([
    'git',
    'files',
    'agents',
    'terminal',
    'browser',
    'services',
]);

/**
 * Supported-placement gate (#2.4 / §10 "no silent placeholder"), derived from the
 * Surface Registry (FINALIZATION-PLAN §16 / §10 "no surface knowledge outside the
 * registry"). The registry is the SINGLE SOURCE OF TRUTH: a placement KIND is only
 * honestly mounted when `PLUGIN_SURFACE_REGISTRY` holds a descriptor for it whose
 * `rendererSet` binds at least one live runtime host. There is no parallel
 * hand-maintained placement list — adding/removing a mounted placement is a registry
 * edit, and the projection gate follows automatically.
 *
 * Any schema-accepted-but-UNMOUNTED kind (a future placement enum value with no
 * registry descriptor, or a descriptor whose modes are all excluded so its
 * `rendererSet` is empty) still gates `disabled` + `placement_unmounted` (no silent
 * drop).
 *
 * The gate only ever receives `surfacePlacement` placement kinds (schema-bounded to
 * `PluginSurfacePlacementKindV1`); the registry's two non-placement surface types
 * (`session.headerAction`, `session.structuredMessage`) are projected by their own
 * families and never reach this gate, so deriving from the full registry is
 * behaviorally identical to the prior hand-maintained 16-kind set.
 */
export function isUiMountedSurfacePlacementKind(placement: string): boolean {
    const descriptor = PLUGIN_SURFACE_REGISTRY.get(placement);
    return descriptor !== undefined && Object.keys(descriptor.rendererSet).length > 0;
}

function isRightSidebarPlacement(placement: string): boolean {
    return placement === 'session.rightSidebarTab'
        || placement === 'project.rightSidebarTab'
        || placement === 'app.rightSidebarTab';
}

function rightSidebarScopeForPlacement(placement: string): 'session' | 'project' | 'app' | null {
    if (placement === 'session.rightSidebarTab') return 'session';
    if (placement === 'project.rightSidebarTab') return 'project';
    if (placement === 'app.rightSidebarTab') return 'app';
    return null;
}

function normalizeRightSidebarTabSlug(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
}

function readRightSidebarTabId(value: unknown, fallback: string): string | null {
    const metadata = readRecord(value);
    const tabId = typeof metadata?.tabId === 'string'
        ? normalizeRightSidebarTabSlug(metadata.tabId)
        : null;
    return tabId ?? normalizeRightSidebarTabSlug(fallback);
}

function rightSidebarTabCollisionKey(
    contribution: ResolvedSurfacePlacementContribution,
): string | null {
    const pluginId = readPluginId(contribution);
    const scope = rightSidebarScopeForPlacement(contribution.definition.placement);
    const tabId = readRightSidebarTabId(
        contribution.definition.rightSidebar,
        contribution.definition.id,
    );
    return pluginId && scope && tabId ? `${scope}:${pluginId}:${tabId}` : null;
}

function collectDuplicateRightSidebarTabKeys(
    contributions: readonly ResolvedSurfacePlacementContribution[],
): ReadonlySet<string> {
    const counts = new Map<string, number>();
    for (const contribution of contributions) {
        const key = rightSidebarTabCollisionKey(contribution);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key));
}

/**
 * REG-1: the renderer KIND a surface placement declares maps 1:1 to a Surface
 * Registry runtime MODE. This is the bridge that lets reject-at-projection check
 * the declared render mode against the surface descriptor's `supportedRuntimeModes`.
 */
function resolveRendererProvidedMode(renderer: Readonly<Record<string, unknown>>): PluginSurfaceRuntimeModeV1 | null {
    switch (renderer.kind) {
        case 'host':
            return 'host';
        case 'hostedWeb':
            return 'hostedWeb';
        case 'reactNative':
            return 'reactNative';
        default:
            return null;
    }
}

function projectSurfacePlacementAvailability(params: Readonly<{
    pluginId: string;
    placement: string;
    descriptorId: string;
    definition: Readonly<Record<string, unknown>>;
    rightSidebar: unknown;
    rightSidebarCollisionKey: string | null;
    duplicateRightSidebarCollisionKeys: ReadonlySet<string>;
    renderer: Readonly<Record<string, unknown>>;
    entriesById: Readonly<Record<string, PluginUiProjectedEntry>>;
}>): Readonly<{
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: readonly string[];
}> {
    // Supported-placement gate (#2.4): reject accepted-but-unmounted placement
    // kinds before any renderer evaluation so a declared placement the UI does
    // not mount surfaces a diagnostic instead of being silently dropped.
    if (!isUiMountedSurfacePlacementKind(params.placement)) {
        return Object.freeze({
            state: 'disabled',
            reason: 'placement_unmounted',
            diagnostics: Object.freeze(['placement_unmounted']),
        });
    }

    // REG-1: reject-at-projection through the Surface Registry SSOT. The placement
    // contribution is re-validated against the descriptor's `contributionSchema`
    // AND its declared renderer mode against `supportedRuntimeModes`. A schema or
    // mode mismatch surfaces a `surface_contribution_rejected` diagnostic instead
    // of mounting an illegal surface — the registry is the single reject chokepoint
    // (no per-family ad-hoc validation).
    const providedMode = resolveRendererProvidedMode(params.renderer);
    const registryProjection = PLUGIN_SURFACE_REGISTRY.projectContribution(
        params.placement,
        params.definition,
        providedMode ? { providedModes: [providedMode] } : undefined,
    );
    if (registryProjection.status === 'rejected') {
        return Object.freeze({
            state: 'disabled',
            reason: 'surface_contribution_rejected',
            diagnostics: Object.freeze([
                registryProjection.reason,
                ...registryProjection.diagnostics,
            ]),
        });
    }

    if (isRightSidebarPlacement(params.placement)) {
        const tabId = readRightSidebarTabId(params.rightSidebar, params.descriptorId);
        if (tabId && RIGHT_SIDEBAR_RESERVED_TAB_IDS.has(tabId)) {
            return Object.freeze({
                state: 'disabled',
                reason: 'right_sidebar_tab_id_reserved',
                diagnostics: Object.freeze(['right_sidebar_tab_id_reserved']),
            });
        }
        if (
            params.rightSidebarCollisionKey
            && params.duplicateRightSidebarCollisionKeys.has(params.rightSidebarCollisionKey)
        ) {
            return Object.freeze({
                state: 'disabled',
                reason: 'right_sidebar_tab_id_duplicate',
                diagnostics: Object.freeze(['right_sidebar_tab_id_duplicate']),
            });
        }
    }

    return projectSurfaceAvailability({
        pluginId: params.pluginId,
        renderer: params.renderer,
        entriesById: params.entriesById,
    });
}

function projectSurfacePlacements(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    v2OwnedViewKeys: ReadonlySet<string> = new Set(),
): void {
    const surfacePlacements = registry.surfacePlacements ?? [];
    const duplicateRightSidebarCollisionKeys = collectDuplicateRightSidebarTabKeys(surfacePlacements);
    for (const contribution of surfacePlacements) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        if (v2OwnedViewKeys.has(`${pluginId}\0${contribution.definition.id}`)) {
            continue;
        }
        const rightSidebarCollisionKey = rightSidebarTabCollisionKey(contribution);
        const id = `surfacePlacement:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'surfacePlacement',
            descriptorId: contribution.definition.id,
            placement: contribution.definition.placement,
            target: contribution.definition.target,
            renderer: contribution.definition.renderer,
            display: contribution.definition.display,
            visibility: contribution.definition.visibility,
            enabled: contribution.definition.enabled,
            featureGate: contribution.definition.featureGate,
            order: contribution.definition.order,
            badge: contribution.definition.badge,
            actions: contribution.definition.actions,
            hostActions: contribution.definition.hostActions,
            fallback: contribution.definition.fallback,
            compatibility: contribution.definition.compatibility,
            rightSidebar: contribution.definition.rightSidebar,
            availability: projectSurfacePlacementAvailability({
                pluginId,
                placement: contribution.definition.placement,
                descriptorId: contribution.definition.id,
                definition: contribution.definition as Readonly<Record<string, unknown>>,
                rightSidebar: contribution.definition.rightSidebar,
                rightSidebarCollisionKey,
                duplicateRightSidebarCollisionKeys,
                renderer: contribution.definition.renderer as Readonly<Record<string, unknown>>,
                entriesById,
            }),
        });
    }
}

function generatedViewTarget(placement: string): Readonly<Record<string, unknown>> {
    if (placement.startsWith('session.')) return Object.freeze({ kind: 'session' as const });
    if (placement.startsWith('workspace.')) return Object.freeze({ kind: 'workspace' as const });
    if (placement.startsWith('project.')) return Object.freeze({ kind: 'project' as const });
    if (placement.startsWith('browser.')) {
        return Object.freeze({ kind: 'browser' as const, browserViewIdPath: '/browserViewId' });
    }
    if (placement.startsWith('services.')) return Object.freeze({ kind: 'services' as const });
    return Object.freeze({ kind: 'app' as const });
}

function generatedViewDisplay(view: ResolvedUiViewV2Contribution): Readonly<Record<string, unknown>> {
    const title = view.definition.title;
    if (typeof title === 'string') {
        return Object.freeze({
            titleKey: view.definition.id,
            developerFallback: title,
        });
    }
    if (title) {
        return Object.freeze({
            titleKey: title.key,
            developerFallback: title.fallback,
        });
    }
    return Object.freeze({
        titleKey: view.definition.id,
        developerFallback: view.definition.id,
    });
}

function generatedRightSidebarMetadata(placement: string): Readonly<Record<string, unknown>> | undefined {
    const scope = rightSidebarScopeForPlacement(placement);
    if (!scope) return undefined;
    return Object.freeze({
        scope,
        section: 'plugin' as const,
        lifecycle: Object.freeze({
            retention: 'unmountOnDisable' as const,
            unmountOnGenerationChange: true,
        }),
        disabledPolicy: 'hide' as const,
        collisionPolicy: 'reject' as const,
    });
}

function projectGeneratedUiViews(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
    declarativeHostRuntime?: DeclarativeProjectionHostRuntimeContext,
): ReadonlySet<string> {
    const renderersByKey = new Map<string, ResolvedUiRendererV2Contribution>();
    for (const renderer of registry.uiRenderersV2 ?? []) {
        renderersByKey.set(`${renderer.pluginId}\0${renderer.definition.id}`, renderer);
    }
    const ownedViewKeys = new Set<string>();
    for (const view of registry.uiViewsV2 ?? []) {
        const renderer = renderersByKey.get(`${view.pluginId}\0${view.definition.renderer}`);
        if (!renderer) continue;
        const pluginId = view.pluginId;
        const descriptorId = view.definition.id;
        ownedViewKeys.add(`${pluginId}\0${descriptorId}`);
        const target = generatedViewTarget(view.definition.placement);
        const requiredHostMethods = Object.freeze([...(renderer.definition.requiredHostMethods ?? [])]);
        const declarativeModel = renderer.definition.kind === 'declarative'
            ? declarativeHostRuntime?.modelsByRendererKey?.[`${pluginId}\0${renderer.definition.id}`]
            : undefined;
        const rendererRef = renderer.definition.kind === 'reactNative'
            ? Object.freeze({
                kind: 'reactNative' as const,
                contributionId: renderer.definition.id,
            })
            : renderer.definition.kind === 'hostedWeb'
                ? Object.freeze({
                    kind: 'hostedWeb' as const,
                    contributionId: renderer.definition.id,
                    source: renderer.definition.source,
                    requiredHostMethods,
                })
                : Object.freeze({
                    kind: 'declarative' as const,
                    contributionId: renderer.definition.id,
                    ...(declarativeModel ? { model: declarativeModel } : {}),
                });
        const registryRendererRef = renderer.definition.kind === 'hostedWeb'
            ? Object.freeze({
                kind: 'hostedWeb' as const,
                contributionId: renderer.definition.id,
            })
            : rendererRef;
        const display = generatedViewDisplay(view);
        const rightSidebar = generatedRightSidebarMetadata(view.definition.placement);
        const definition = Object.freeze({
            id: descriptorId,
            placement: view.definition.placement,
            target,
            renderer: rendererRef,
            display,
            actions: Object.freeze([]),
            hostActions: Object.freeze([]),
            ...(rightSidebar ? { rightSidebar } : {}),
        });
        const rightSidebarCollisionKey = rightSidebar
            ? `${rightSidebarScopeForPlacement(view.definition.placement)}:${pluginId}:${descriptorId}`
            : null;
        addEntry(entriesById, {
            id: `surfacePlacement:${pluginId}:${descriptorId}`,
            pluginId,
            pluginVersion: view.pluginVersion ?? renderer.pluginVersion ?? '0.0.0',
            contributionKind: 'surfacePlacement',
            descriptorId,
            generatedV2: true,
            placement: view.definition.placement,
            target,
            renderer: rendererRef,
            display,
            actions: Object.freeze([]),
            hostActions: Object.freeze([]),
            fallbackRenderers: view.definition.fallbackRenderers,
            ...(rightSidebar ? { rightSidebar } : {}),
            availability: renderer.definition.kind === 'declarative'
                ? declarativeModel?.visible === true
                    ? Object.freeze({
                        state: 'available' as const,
                        reason: 'available',
                        diagnostics: Object.freeze([]),
                    })
                    : Object.freeze({
                        state: 'fallback' as const,
                        reason: declarativeModel?.visible === false
                            ? 'declarative_model_hidden'
                            : 'declarative_model_unavailable',
                        diagnostics: Object.freeze([
                            declarativeModel?.visible === false
                                ? 'declarative_model_hidden'
                                : 'declarative_model_unavailable',
                        ]),
                    })
                : projectSurfacePlacementAvailability({
                    pluginId,
                    placement: view.definition.placement,
                    descriptorId,
                    definition: registryRendererRef === rendererRef
                        ? definition
                        : Object.freeze({ ...definition, renderer: registryRendererRef }),
                    rightSidebar,
                    rightSidebarCollisionKey,
                    duplicateRightSidebarCollisionKeys: new Set(),
                    renderer: registryRendererRef,
                    entriesById,
                }),
        });
    }
    return ownedViewKeys;
}

function projectUiArtifacts(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (!pluginId) {
            continue;
        }
        const id = `uiArtifact:${pluginId}:${contribution.definition.id}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'uiArtifact',
            artifactId: contribution.definition.id,
            contributionId: contribution.definition.contributionId,
            contributionFamily: contribution.definition.contributionFamily,
            artifactKind: contribution.definition.artifactKind,
            platform: contribution.definition.platform,
            channel: contribution.definition.channel,
            integrity: contribution.definition.integrity,
            compatibility: contribution.definition.compatibility,
            byteSize: contribution.definition.byteSize,
            contentType: contribution.definition.contentType,
            assetPath: contribution.definition.assetPath,
            url: contribution.definition.url,
            cacheKey: contribution.definition.cacheKey,
        });
    }
}

function addDigestEntries(
    registry: ResolvedContributionRegistry,
    entriesById: Record<string, PluginUiProjectedEntry>,
): void {
    const byPluginId = new Map<string, {
        translations: Array<ResolvedUiTranslationsContribution | ResolvedUiTranslationBundleV2Contribution>;
        structuredMessages: ResolvedStructuredMessageContribution[];
        sessionHeaderActions: ResolvedSessionHeaderActionContribution[];
        surfacePlacements: ResolvedSurfacePlacementContribution[];
        hostedWeb: ResolvedHostedWebContribution[];
        reactNativeBundles: ResolvedReactNativeBundleContribution[];
        uiArtifacts: ResolvedUiArtifactContribution[];
    }>();

    function bucket(pluginId: string) {
        const existing = byPluginId.get(pluginId);
        if (existing) {
            return existing;
        }
        const created = {
            translations: [],
            structuredMessages: [],
            sessionHeaderActions: [],
            surfacePlacements: [],
            hostedWeb: [],
            reactNativeBundles: [],
            uiArtifacts: [],
        };
        byPluginId.set(pluginId, created);
        return created;
    }

    const v2TranslationPluginIds = new Set<string>();
    for (const contribution of registry.uiTranslationsV2 ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) {
            v2TranslationPluginIds.add(pluginId);
            bucket(pluginId).translations.push(contribution);
        }
    }
    for (const contribution of registry.uiTranslations ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId && !v2TranslationPluginIds.has(pluginId)) {
            bucket(pluginId).translations.push(contribution);
        }
    }
    for (const contribution of registry.structuredMessages ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).structuredMessages.push(contribution);
    }
    for (const contribution of registry.sessionHeaderActions ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).sessionHeaderActions.push(contribution);
    }
    for (const contribution of registry.surfacePlacements ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).surfacePlacements.push(contribution);
    }
    for (const contribution of registry.hostedWeb ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).hostedWeb.push(contribution);
    }
    for (const contribution of registry.reactNativeBundles ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).reactNativeBundles.push(contribution);
    }
    for (const contribution of registry.uiArtifacts ?? []) {
        const pluginId = readPluginId(contribution);
        if (pluginId) bucket(pluginId).uiArtifacts.push(contribution);
    }

    for (const [pluginId, contributions] of [...byPluginId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const id = `digest:${pluginId}`;
        addEntry(entriesById, {
            id,
            pluginId,
            contributionKind: 'digest',
            digest: digestJson(contributions),
            families: Object.fromEntries(
                Object.entries(contributions).map(([family, familyContributions]) => [
                    family,
                    digestJson(familyContributions),
                ]),
            ),
        });
    }
}

export const pluginUiProjectionFamily = definePluginProjectionFamilyV2({
    family: 'pluginUi',
    project({ registry, generation, pluginUiHostRuntime }) {
        const hostRuntime = pluginUiHostRuntime as PluginUiProjectionHostRuntimeContext | undefined;
        const entriesById: Record<string, PluginUiProjectedEntry> = {};
        projectTranslations(registry, entriesById);
        projectStructuredMessages(registry, entriesById, hostRuntime?.structuredMessages);
        projectSessionHeaderActions(registry, entriesById);
        const v2OwnedHostedWebContributionKeys = projectGeneratedHostedWebRenderers(
            registry,
            entriesById,
            hostRuntime?.hostedWeb,
        );
        projectHostedWeb(registry, entriesById, hostRuntime?.hostedWeb, v2OwnedHostedWebContributionKeys);
        const v2OwnedReactNativeContributionKeys = projectGeneratedReactNativeBundles(
            registry,
            entriesById,
            generation,
            hostRuntime?.reactNativeBundles,
        );
        projectReactNativeBundles(
            registry,
            entriesById,
            generation,
            hostRuntime?.reactNativeBundles,
            v2OwnedReactNativeContributionKeys,
        );
        const v2OwnedViewKeys = projectGeneratedUiViews(registry, entriesById, hostRuntime?.declarative);
        projectSurfacePlacements(registry, entriesById, v2OwnedViewKeys);
        projectUiArtifacts(registry, entriesById);
        addDigestEntries(registry, entriesById);

        return {
            family: 'pluginUi',
            entriesById,
        };
    },
});
