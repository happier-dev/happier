import * as React from 'react';

import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol';
import {
    buildPluginHostedWebStaticAssetPreviewId,
    PLUGIN_SURFACE_REGISTRY,
    PluginUiArtifactsManifestEntryV1Schema,
    PluginUiFallbackRefV1Schema,
    PluginUiHostApiMethodV1Schema,
    resolvePluginUiSurfaceContextPlacement,
    type PluginSurfaceRuntimeModeV1,
    type PluginUiChannelV1,
    type PluginUiFallbackRefV1,
    type PluginUiHostApiMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiPlatformV1,
    type PluginUiSurfaceContextV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiRenderContext,
    PluginUiSurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import { useUnistyles } from 'react-native-unistyles';

import { PluginHostedWebPane } from '@/components/plugins/hostedWeb/PluginHostedWebPane';
import {
    fetchReactNativeInstalledArtifactBytesViaMachineRpc,
    getInstalledPluginReactNativeBundleCache,
    preloadReactNativeInstalledArtifactBytes,
    type PluginReactNativeBundleCacheIdentity,
} from '@/components/plugins/reactNative/bundleCache';
import {
    PluginReactNativeSurface,
    type PluginReactNativeSurfaceModule,
} from '@/components/plugins/reactNative/PluginReactNativeSurface';
import type { PluginReactNativeCompatibilityDecision } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    createDefaultRepackScriptManagerBackend,
    loadPluginReactNativeBundleModule,
    type PluginReactNativeLoaderBackend,
    type RepackInstalledArtifactModuleReference,
} from '@/components/plugins/reactNative/loader';
import { loadPluginReactNativeDevServerModule } from '@/components/plugins/reactNative/devLoader';
import { resolveDefaultReactNativeLoaderBackend } from '@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend';
import type { PluginReactNativeLoaderPolicyInput } from '@/components/plugins/reactNative/loaderPolicy';
import {
    createCanonicalPluginReactNativeHostApiAdapter,
    createPluginReactNativeHostApiAdapter,
} from '@/components/plugins/reactNative/hostApi';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { getPreferredLanguage, t } from '@/text';
import {
    resolvePluginHostRendererComponent,
    type PluginHostRendererDescriptorDisplay,
} from '@/components/plugins/surfaces/hostRenderers';
import { resolvePluginDisplayString } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import {
    selectLocalServicePreviewByBrowserTarget,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { resolvePluginUiTranslationText } from '@/sync/domains/plugins/ui/i18n';
import { createPluginSurfaceHostApi } from '@happier-dev/plugin-ui';
import {
    canRenderPluginUiProjectionEntry,
    createPluginUiPolicyEvaluationContext,
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import { resolveResourceScope } from '@/sync/domains/plugins/ui/scope/resolveResourceScope';
import { resolvePluginUiProjectionContributionId } from '@/sync/domains/plugins/ui/projectionRefs';
import { reportReactNativeCrashDisableViaMachineRpc } from '@/sync/domains/plugins/ui/reactNativeCrashReports';
import { useHighContrastPreference } from '@/hooks/ui/useHighContrastPreference';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useScreenReaderEnabled } from '@/hooks/ui/useScreenReaderEnabled';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
} from '@/sync/domains/state/storage';
import { DeclarativePluginSurface } from './DeclarativePluginSurface';

type PluginSurfaceScope = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
}>;

type PluginSurfaceHostDescriptor = PluginUiSurfacePlacementProjection;

export type PluginSurfaceHostApi = Readonly<{
    platform: PluginUiPlatformV1;
    channel: PluginUiChannelV1;
    handleRequest: (
        request: PluginUiHostApiRequestEnvelopeV1,
    ) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readFallbackRef(value: unknown): PluginUiFallbackRefV1 | undefined {
    const parsed = PluginUiFallbackRefV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
}

function readReactNativeAllowedHostApiMethods(
    contribution: Readonly<Record<string, unknown>> | null,
): readonly PluginUiHostApiMethodV1[] {
    const hostApi = readRecord(contribution?.hostApi);
    if (!hostApi) {
        return Object.freeze([]);
    }
    if (!Array.isArray(hostApi.methods)) {
        return Object.freeze([]);
    }
    const methods: PluginUiHostApiMethodV1[] = [];
    for (const method of hostApi.methods) {
        const parsed = PluginUiHostApiMethodV1Schema.safeParse(method);
        if (!parsed.success) {
            return Object.freeze([]);
        }
        methods.push(parsed.data);
    }
    return Object.freeze(methods);
}

function readHostRendererId(renderer: Readonly<Record<string, unknown>>): string | null {
    if (renderer.kind !== 'host') {
        return null;
    }
    return readOptionalString(renderer.rendererId) ?? null;
}

function readHostRendererDisplay(
    descriptor: PluginSurfaceHostDescriptor,
): PluginHostRendererDescriptorDisplay | null {
    const display = readRecord(descriptor.display);
    if (!display) {
        return null;
    }
    return {
        ...(readOptionalString(display.titleKey) ? { titleKey: readOptionalString(display.titleKey) } : {}),
        ...(readOptionalString(display.descriptionKey) ? { descriptionKey: readOptionalString(display.descriptionKey) } : {}),
        ...(readOptionalString(display.labelKey) ? { labelKey: readOptionalString(display.labelKey) } : {}),
        ...(readOptionalString(display.developerFallback)
            ? { developerFallback: readOptionalString(display.developerFallback) }
            : {}),
    };
}

function createHostRendererDisplayKeyResolver(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
}>): ((key: string) => string | null) | undefined {
    if (!params.projection) {
        return undefined;
    }
    return (key: string) => resolvePluginUiTranslationText({
        projection: params.projection,
        pluginId: params.pluginId,
        key,
        locale: getPreferredLanguage(),
    });
}

function readReactNativeBundleCacheIdentity(value: unknown): PluginReactNativeBundleCacheIdentity | null {
    const identity = readRecord(value);
    if (!identity) {
        return null;
    }

    const pluginId = readOptionalString(identity.pluginId);
    const contributionId = readOptionalString(identity.contributionId);
    const artifactDigest = readOptionalString(identity.artifactDigest);
    const hostAppVersion = readOptionalString(identity.hostAppVersion);
    const hostUiApiVersion = readOptionalString(identity.hostUiApiVersion);
    const reactVersion = readOptionalString(identity.reactVersion);
    const reactNativeVersion = readOptionalString(identity.reactNativeVersion);
    const platform = readOptionalString(identity.platform);
    const channel = readOptionalString(identity.channel);
    const nativeCapabilitiesDigest = readOptionalString(identity.nativeCapabilitiesDigest);
    const projectionGeneration = typeof identity.projectionGeneration === 'number'
        && Number.isInteger(identity.projectionGeneration)
        && identity.projectionGeneration >= 0
        ? identity.projectionGeneration
        : null;

    if (
        !pluginId
        || !contributionId
        || !artifactDigest
        || !hostAppVersion
        || !hostUiApiVersion
        || !reactVersion
        || !reactNativeVersion
        || !platform
        || !channel
        || !nativeCapabilitiesDigest
        || projectionGeneration === null
    ) {
        return null;
    }

    const expoRuntimeVersion = readOptionalString(identity.expoRuntimeVersion);
    const hermesVersion = readOptionalString(identity.hermesVersion);
    return Object.freeze({
        pluginId,
        contributionId,
        artifactDigest,
        hostAppVersion,
        hostUiApiVersion,
        reactVersion,
        reactNativeVersion,
        ...(expoRuntimeVersion ? { expoRuntimeVersion } : {}),
        ...(hermesVersion ? { hermesVersion } : {}),
        platform,
        channel,
        nativeCapabilitiesDigest,
        projectionGeneration,
    });
}

function readGeneratedReactNativeArtifactGraph(
    contribution: Readonly<Record<string, unknown>> | null,
): PluginUiArtifactsManifestEntryV1 | null {
    if (contribution?.generatedV2 !== true) return null;
    const parsed = PluginUiArtifactsManifestEntryV1Schema.safeParse(contribution.artifactGraph);
    return parsed.success ? parsed.data : null;
}

function createCanonicalPluginUiSurfaceContext(input: Readonly<{
    placement: string;
    platform: string;
    sessionId?: string | null;
    direction: PluginUiSurfaceContext['direction'];
    colorScheme: PluginUiSurfaceContext['colorScheme'];
    contrast: PluginUiSurfaceContext['contrast'];
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    safeAreaInsets: PluginUiSurfaceContext['safeAreaInsets'];
}>): PluginUiSurfaceContext {
    const platform = input.platform === 'ios'
        || input.platform === 'android'
        || input.platform === 'desktop'
        || input.platform === 'web'
        ? input.platform
        : 'web';
    const locale = getPreferredLanguage();
    return Object.freeze({
        placement: input.placement as PluginUiSurfaceContext['placement'],
        platform,
        locale,
        direction: input.direction,
        colorScheme: input.colorScheme,
        contrast: input.contrast,
        textScale: input.textScale,
        reducedMotion: input.reducedMotion,
        screenReaderEnabled: input.screenReaderEnabled,
        safeAreaInsets: Object.freeze({
            top: input.safeAreaInsets.top,
            right: input.safeAreaInsets.right,
            bottom: input.safeAreaInsets.bottom,
            left: input.safeAreaInsets.left,
        }),
        ...(input.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
    });
}

function sanitizeReactNativeFederatedIdentifier(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^A-Za-z0-9_$]/gu, '_')
        .replace(/^[^A-Za-z_$]+/u, '');
    return normalized || 'pluginReactNativeBundle';
}

function readReactNativeModuleReference(params: Readonly<{
    pluginId: string;
    contributionId: string;
    entry: unknown;
}>): RepackInstalledArtifactModuleReference {
    const entry = readRecord(params.entry);
    const containerName = readOptionalString(entry?.containerName)
        ?? sanitizeReactNativeFederatedIdentifier(`${params.pluginId}_${params.contributionId}`);
    const modulePath = readOptionalString(entry?.modulePath) ?? './renderSurface';
    const exportName = readOptionalString(entry?.exportName) ?? 'renderSurface';
    return Object.freeze({
        containerName,
        modulePath,
        exportName,
    });
}

function readGeneratedReactNativeModuleReference(
    graph: PluginUiArtifactsManifestEntryV1 | null,
): RepackInstalledArtifactModuleReference | undefined {
    if (!graph || graph.platform === 'web' || !graph.repack) return undefined;
    return Object.freeze({
        containerName: graph.repack.containerName,
        modulePath: graph.repack.modulePath,
        exportName: graph.repack.exportName,
    });
}

function createReactNativeInstalledArtifactLoad(
    identity: PluginReactNativeBundleCacheIdentity,
    moduleReference: RepackInstalledArtifactModuleReference | undefined,
    hostPlatform: string,
    scope?: PluginSurfaceScope,
    backend?: PluginReactNativeLoaderBackend,
    artifactGraph?: PluginUiArtifactsManifestEntryV1,
): () => Promise<PluginReactNativeSurfaceModule> {
    return async () => {
        const cache = getInstalledPluginReactNativeBundleCache();
        const machineId = readOptionalString(scope?.machineId);
        if (machineId) {
            const preload = await preloadReactNativeInstalledArtifactBytes({
                cache,
                identity,
                ...(artifactGraph ? { artifactGraph } : {}),
                fetchArtifactBytes: () => fetchReactNativeInstalledArtifactBytesViaMachineRpc({
                    machineId,
                    serverId: scope?.serverId ?? null,
                    identity,
                }),
            });
            if (!preload.ok) {
                throw Object.assign(new Error(preload.code), {
                    code: preload.code,
                    diagnostics: preload.diagnostics,
                });
            }
        }

        const result = await loadPluginReactNativeBundleModule({
            cache,
            identity,
            hostPlatform,
            ...(moduleReference ? { moduleReference } : {}),
            ...(backend ? { backend } : {}),
        });
        if (result.ok) {
            return result.module;
        }

        throw Object.assign(new Error(result.code), {
            code: result.code,
            diagnostics: result.diagnostics,
        });
    };
}

/**
 * RN-2: the dev-hot-reload LOAD path. A development-channel, locally-sourced surface
 * served by a local Re.Pack/Metro dev server loads straight from the projected dev
 * URL with no materialized artifact (every mount re-fetches). The cli projection has
 * already enforced the `plugins.ui.reactNativeBundles.devHotReload` + local +
 * development gate before emitting the `devHotReload` source.
 */
function createReactNativeDevServerLoad(
    input: Readonly<{
        devUrl: string;
        pluginId: string;
        contributionId: string;
        moduleReference: RepackInstalledArtifactModuleReference;
    }>,
    backend?: PluginReactNativeLoaderBackend,
): () => Promise<PluginReactNativeSurfaceModule> {
    return async () => {
        const result = await loadPluginReactNativeDevServerModule({
            devUrl: input.devUrl,
            pluginId: input.pluginId,
            contributionId: input.contributionId,
            moduleReference: input.moduleReference,
            backend: backend ?? createDefaultRepackScriptManagerBackend(),
        });
        if (result.ok) {
            return result.module;
        }

        throw Object.assign(new Error(result.code), {
            code: result.code,
            diagnostics: result.diagnostics,
        });
    };
}

function PluginReactNativeSurfaceHost(props: Readonly<{
    surfaceId: string;
    snapshotTitle: string;
    surface?: PluginUiSurfaceContextV1;
    decision: PluginReactNativeCompatibilityDecision;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    cacheIdentity: PluginReactNativeBundleCacheIdentity | null;
    load?: () => Promise<PluginReactNativeSurfaceModule>;
    hostApi?: PluginSurfaceHostApi;
    interactionEnabled: boolean;
    canonicalRenderIdentity?: Readonly<{
        pluginId: string;
        pluginVersion: string;
        viewId: string;
        placement: PluginUiRenderContext['view']['placement'];
        generation: string;
        platform: string;
        sessionId?: string | null;
    }>;
    allowedHostApiMethods?: readonly PluginUiHostApiMethodV1[];
    onCrashDisable?: (event: Readonly<{
        surfaceId: string;
        cacheIdentity: PluginReactNativeBundleCacheIdentity;
        disabledReason: 'render_error_threshold' | 'startup_ack_timeout_threshold';
        crashCount: number;
        startupFailureCount: number;
    }>) => void | Promise<void>;
}>): React.ReactElement {
    const { theme, rt } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const screenReaderEnabled = useScreenReaderEnabled();
    const highContrast = useHighContrastPreference();
    const canonicalIdentity = props.canonicalRenderIdentity;
    const canonicalRenderIdentity = React.useMemo(() => {
        if (!canonicalIdentity) {
            return undefined;
        }
        return Object.freeze({
            pluginId: canonicalIdentity.pluginId,
            pluginVersion: canonicalIdentity.pluginVersion,
            viewId: canonicalIdentity.viewId,
            placement: canonicalIdentity.placement,
            generation: canonicalIdentity.generation,
            platform: canonicalIdentity.platform,
            sessionId: canonicalIdentity.sessionId,
            surface: createCanonicalPluginUiSurfaceContext({
                placement: canonicalIdentity.placement,
                platform: canonicalIdentity.platform,
                sessionId: canonicalIdentity.sessionId,
                direction: rt.rtl ? 'rtl' : 'ltr',
                colorScheme: theme.dark ? 'dark' : 'light',
                contrast: highContrast ? 'high' : 'normal',
                textScale: rt.fontScale,
                reducedMotion,
                screenReaderEnabled,
                safeAreaInsets: rt.insets,
            }),
        });
    }, [
        canonicalIdentity?.generation,
        canonicalIdentity?.placement,
        canonicalIdentity?.platform,
        canonicalIdentity?.pluginId,
        canonicalIdentity?.pluginVersion,
        canonicalIdentity?.sessionId,
        canonicalIdentity?.viewId,
        highContrast,
        reducedMotion,
        rt.fontScale,
        rt.insets.bottom,
        rt.insets.left,
        rt.insets.right,
        rt.insets.top,
        rt.rtl,
        screenReaderEnabled,
        theme.dark,
    ]);
    const legacyHostApiAdapter = React.useMemo(() => {
        if (canonicalRenderIdentity) {
            return null;
        }
        if (!props.interactionEnabled || !props.hostApi || !props.surface) {
            return null;
        }
        return createPluginReactNativeHostApiAdapter({
            surface: props.surface,
            requestIdPrefix: `rn:${props.surface.pluginId}:${props.surface.surfaceId}`,
            handleRequest: props.hostApi.handleRequest,
            ...(props.allowedHostApiMethods !== undefined ? { allowedMethods: props.allowedHostApiMethods } : {}),
        });
    }, [canonicalRenderIdentity, props.allowedHostApiMethods, props.hostApi, props.interactionEnabled, props.surface]);

    const canonicalHostApiAdapter = React.useMemo(() => {
        if (!props.interactionEnabled || !canonicalRenderIdentity || !props.hostApi || !props.surface) {
            return null;
        }
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalRenderIdentity.surface,
            legacySurface: props.surface,
            requestIdPrefix: `rn-v2:${canonicalRenderIdentity.pluginId}:${canonicalRenderIdentity.viewId}`,
            handleRequest: props.hostApi.handleRequest,
        });
    }, [canonicalRenderIdentity, props.hostApi, props.interactionEnabled, props.surface]);
    const abortController = React.useMemo(
        () => new AbortController(),
        [canonicalRenderIdentity?.generation, canonicalRenderIdentity?.viewId],
    );
    const canonicalRenderContext = React.useMemo<PluginUiRenderContext | undefined>(() => {
        const identity = canonicalRenderIdentity;
        if (!identity || !canonicalHostApiAdapter) return undefined;
        return Object.freeze({
            plugin: Object.freeze({ id: identity.pluginId, version: identity.pluginVersion }),
            view: Object.freeze({ id: identity.viewId, placement: identity.placement }),
            surface: identity.surface,
            hostApi: canonicalHostApiAdapter.api,
            signal: abortController.signal,
        });
    }, [abortController.signal, canonicalHostApiAdapter, canonicalRenderIdentity]);

    React.useLayoutEffect(() => () => {
        legacyHostApiAdapter?.dispose();
        canonicalHostApiAdapter?.dispose();
    }, [canonicalHostApiAdapter, legacyHostApiAdapter]);
    React.useLayoutEffect(() => () => {
        abortController.abort();
    }, [abortController]);

    return (
        <PluginReactNativeSurface
            surfaceId={props.surfaceId}
            snapshotTitle={props.snapshotTitle}
            surface={props.surface}
            decision={props.decision}
            loadPolicy={props.loadPolicy}
            cacheKey={props.cacheKey}
            cacheIdentity={props.cacheIdentity}
            load={props.load}
            hostApi={legacyHostApiAdapter?.api}
            renderContext={canonicalRenderContext}
            interactionEnabled={props.interactionEnabled}
            onCrashDisable={props.onCrashDisable}
        />
    );
}

function readReactNativeRuntimeState(entry: Readonly<Record<string, unknown>> | null): Readonly<{
    decision: PluginReactNativeCompatibilityDecision;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    cacheIdentity?: PluginReactNativeBundleCacheIdentity;
}> | null {
    const runtime = readRecord(entry?.runtime);
    const decision = readRecord(runtime?.decision);
    if (!runtime || !decision) {
        return null;
    }

    const state = decision.state;
    const reason = decision.reason;
    if (
        (state !== 'load' && state !== 'fallback' && state !== 'disabled' && state !== 'blocked')
        || typeof reason !== 'string'
    ) {
        return null;
    }

    const loadPolicy = readRecord(runtime.loadPolicy);
    const source = loadPolicy?.source;
    // RN-2: propagate the dev-hot-reload `devUrl` (the local dev-server `AccessEndpoint`)
    // from the cli projection through to the host loader policy so the dev LOAD path
    // is reachable. Without it, a `devHotReload` source can never resolve loadable.
    const devUrl = readOptionalString(loadPolicy?.devUrl);
    const cacheKey = runtime.cacheKey;
    const cacheIdentity = readReactNativeBundleCacheIdentity(runtime.cacheIdentity);
    return Object.freeze({
        decision: Object.freeze({
            state,
            reason: reason as PluginReactNativeCompatibilityDecision['reason'],
            diagnostics: Object.freeze(readStringArray(decision.diagnostics)),
            ...(readFallbackRef(decision.fallback) ? { fallback: readFallbackRef(decision.fallback) } : {}),
        }),
        ...(source === 'installedArtifact' || source === 'devHotReload'
            ? {
                loadPolicy: Object.freeze({
                    source,
                    ...(source === 'devHotReload' && devUrl ? { devUrl } : {}),
                }) as PluginReactNativeLoaderPolicyInput,
            }
            : {}),
        ...(typeof cacheKey === 'string' && cacheKey.trim().length > 0 ? { cacheKey } : {}),
        ...(cacheIdentity ? { cacheIdentity } : {}),
    });
}

function readBrowserViewTarget(value: unknown): BrowserViewTargetV1 | null {
    const result = BrowserViewTargetV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readSurfaceBrowserTarget(params: Readonly<{
    resourceBrowserTarget?: unknown;
    descriptor: PluginSurfaceHostDescriptor;
}>): BrowserViewTargetV1 | null {
    return readBrowserViewTarget(params.resourceBrowserTarget)
        ?? readBrowserViewTarget(params.descriptor.browserTarget);
}

/**
 * Phase 6.1: the daemon static-asset server registers a local-service preview
 * under the canonical `plugin-static:<pluginId>:<contributionId>:<sessionId>:<machineId>`
 * id when it serves a plugin's installed hosted-web bundle. When the projected hosted-web
 * entry resolves to the `installedStaticAssets` runtime mode and the mount does
 * not already carry an explicit browser target, synthesize the matching
 * `localServicePreview` target so the existing preview correlation resolves the
 * real served loopback endpoint. Availability stays truthful: if no preview row
 * exists (the daemon is not serving), the lookup returns null → fallback.
 */
function resolveHostedWebStaticAssetBrowserTarget(params: Readonly<{
    contribution: Readonly<Record<string, unknown>> | null;
    sessionId: string | null | undefined;
    machineId: string | null | undefined;
}>): BrowserViewTargetV1 | null {
    const runtimeMode = readRecord(params.contribution?.runtimeMode);
    if (runtimeMode?.kind !== 'installedStaticAssets') {
        return null;
    }
    const pluginId = readOptionalString(params.contribution?.pluginId);
    const contributionId = readOptionalString(params.contribution?.contributionId);
    const sessionId = readOptionalString(params.sessionId);
    const machineId = readOptionalString(params.machineId);
    if (!pluginId || !contributionId || !sessionId || !machineId) {
        return null;
    }
    return {
        kind: 'localServicePreview',
        targetId: buildPluginHostedWebStaticAssetPreviewId({
            pluginId,
            contributionId,
            sessionId,
            machineId,
        }),
        sessionId,
        machineId,
    };
}

function resolveDescriptorSurfaceContextPlacement(
    descriptor: PluginSurfaceHostDescriptor,
) {
    return resolvePluginUiSurfaceContextPlacement(descriptor.placement);
}

/**
 * Resolve the `{ targetKind, resourceScope }` for a surface descriptor's declared
 * `target` (Phase 1.2). Only `surfacePlacement` descriptors carry a `target`;
 * other descriptor kinds fall back to the fail-closed `app` resolution. The same
 * scope is used for ALL render modes (host/embedded/RN/hosted-web) — scope is a
 * property of the surface target, not the renderer (§13.5.7).
 */
function resolveSurfaceResourceScope(descriptor: PluginSurfaceHostDescriptor) {
    return resolveResourceScope(readRecord((descriptor as Readonly<Record<string, unknown>>).target));
}

/**
 * Build the canonical surface context for a descriptor (Phase 1.2 scope + the
 * descriptor identity/placement).
 */
function buildSurfaceContext(
    descriptor: PluginSurfaceHostDescriptor,
    platform: LocalServicePreviewPlatform | undefined,
): PluginUiSurfaceContextV1 {
    const record = descriptor as Readonly<Record<string, unknown>>;
    return {
        pluginId: descriptor.pluginId,
        contributionId: readOptionalString(record.contributionId)
            ?? readOptionalString(record.descriptorId)
            ?? descriptor.id,
        surfaceId: descriptor.id,
        placement: resolveDescriptorSurfaceContextPlacement(descriptor),
        platform: platform ?? 'web',
        channel: 'internal',
        resourceScope: [...resolveSurfaceResourceScope(descriptor).resourceScope],
        diagnostics: [],
    };
}

/**
 * The canonical host API for a surface (Phase 1.3). When the mount supplies a
 * richer host API (e.g. the browser panel), it is preferred; otherwise every
 * surface still gets a scope-aware host API that answers `getSurfaceContext`
 * (finding #10) and fails closed for side-effecting methods until a concrete
 * handler is wired.
 */
function resolveSurfaceHostApi(
    descriptor: PluginSurfaceHostDescriptor,
    platform: LocalServicePreviewPlatform | undefined,
    provided: PluginSurfaceHostApi | undefined,
): PluginSurfaceHostApi {
    if (provided) {
        return provided;
    }
    return createPluginSurfaceHostApi({ surfaceContext: buildSurfaceContext(descriptor, platform) });
}

/**
 * REG-2: map a declared renderer `kind` to its Surface Registry runtime MODE. This
 * mirrors the projection-side `resolveRendererProvidedMode` (cli projection.ts) so
 * the mount switch and reject-at-projection both reason about modes through the
 * registry's single mode vocabulary.
 */
function rendererKindToRuntimeMode(kind: unknown): PluginSurfaceRuntimeModeV1 | null {
    switch (kind) {
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

/**
 * REG-2: a cross-mode `fallback` renderer ref implies a SECOND supported runtime
 * mode for the surface — a `descriptor` fallback resolves to the `host` mode, a
 * `hostedWeb` fallback resolves to the `hostedWeb` mode. `unavailable`/`none`
 * fallbacks (and the within-mode `structuredMessage` ref) imply no extra mode.
 */
function fallbackRefToRuntimeMode(fallback: unknown): PluginSurfaceRuntimeModeV1 | null {
    const ref = readRecord(fallback);
    if (!ref) {
        return null;
    }
    if (ref.kind === 'descriptor') {
        return 'host';
    }
    if (ref.kind === 'hostedWeb') {
        return 'hostedWeb';
    }
    return null;
}

/**
 * REG-2: the ordered set of runtime modes a surface placement PROVIDES — the
 * declared renderer mode first, then any distinct cross-mode `fallback` mode. This
 * is the `providedModes` input to `PLUGIN_SURFACE_REGISTRY.selectRuntimeMode`, so
 * the registry (not a hardcoded mount switch) is the single source of truth for
 * which mode mounts.
 */
export function resolveSurfaceMountProvidedModes(
    renderer: Readonly<Record<string, unknown>>,
): readonly PluginSurfaceRuntimeModeV1[] {
    const modes: PluginSurfaceRuntimeModeV1[] = [];
    const declared = rendererKindToRuntimeMode(renderer.kind);
    if (declared) {
        modes.push(declared);
    }
    const fallbackMode = fallbackRefToRuntimeMode(renderer.fallback);
    if (fallbackMode && !modes.includes(fallbackMode)) {
        modes.push(fallbackMode);
    }
    return Object.freeze(modes);
}

export type ResolveSurfaceMountModeInput = Readonly<{
    surfaceId: string;
    renderer: Readonly<Record<string, unknown>>;
    providedModes?: readonly PluginSurfaceRuntimeModeV1[];
    isRuntimeAvailable?: (mode: PluginSurfaceRuntimeModeV1) => boolean;
    isTrustCompatible?: (mode: PluginSurfaceRuntimeModeV1) => boolean;
}>;

/**
 * REG-2: pick the mount runtime MODE through the Surface Registry SSOT. The
 * registry walks `supportedRuntimeModes` in priority order (RN → hostedWeb → host
 * for a panel) and returns the first PROVIDED mode that is both runtime-available
 * and trust-compatible — so a surface whose declared mode's runtime is unavailable
 * (or trust-incompatible) cross-falls to a provided fallback mode without a second
 * mount switch. Returns null when nothing is selectable (fail-closed).
 */
export function resolveSurfaceMountMode(
    input: ResolveSurfaceMountModeInput,
): PluginSurfaceRuntimeModeV1 | null {
    const providedModes = input.providedModes ?? resolveSurfaceMountProvidedModes(input.renderer);
    if (providedModes.length === 0) {
        return null;
    }
    return PLUGIN_SURFACE_REGISTRY.selectRuntimeMode(input.surfaceId, {
        providedModes,
        ...(input.isRuntimeAvailable ? { isRuntimeAvailable: input.isRuntimeAvailable } : {}),
        ...(input.isTrustCompatible ? { isTrustCompatible: input.isTrustCompatible } : {}),
    });
}

function appendRuntimeMode(
    modes: PluginSurfaceRuntimeModeV1[],
    mode: PluginSurfaceRuntimeModeV1 | null | undefined,
): void {
    if (mode && !modes.includes(mode)) {
        modes.push(mode);
    }
}

/**
 * REG-2: resolve the cross-mode HOST fallback descriptor a placement's renderer
 * declares via `fallback: { kind: 'descriptor', descriptorId }`. The fallback
 * descriptor is a SEPARATE `surfacePlacement` projection entry (a `{kind:'host'}`
 * renderer); it is keyed either by its qualified projection id or its descriptorId.
 */
function resolveHostFallbackDescriptor(params: Readonly<{
    pluginId: string;
    descriptorId: string;
    surfacePlacementsById: Readonly<Record<string, PluginSurfaceHostDescriptor>>;
}>): PluginSurfaceHostDescriptor | null {
    const qualifiedId = `surfacePlacement:${params.pluginId}:${params.descriptorId}`;
    const candidate = params.surfacePlacementsById[qualifiedId]
        ?? Object.values(params.surfacePlacementsById).find(
            (entry) => entry.pluginId === params.pluginId && entry.descriptorId === params.descriptorId,
        )
        ?? null;
    if (!candidate) {
        return null;
    }
    return readHostRendererId(candidate.renderer) ? candidate : null;
}

function resolveHostFallbackForRef(params: Readonly<{
    pluginId: string;
    fallbackRef: Readonly<Record<string, unknown>> | null;
    surfacePlacementsById: Readonly<Record<string, PluginSurfaceHostDescriptor>>;
}>): Readonly<{ descriptor: PluginSurfaceHostDescriptor; rendererId: string }> | null {
    if (params.fallbackRef?.kind !== 'descriptor') {
        return null;
    }
    const fallbackDescriptorId = readOptionalString(params.fallbackRef.descriptorId);
    if (!fallbackDescriptorId) {
        return null;
    }
    const fallbackDescriptor = resolveHostFallbackDescriptor({
        pluginId: params.pluginId,
        descriptorId: fallbackDescriptorId,
        surfacePlacementsById: params.surfacePlacementsById,
    });
    const fallbackRendererId = fallbackDescriptor
        ? readHostRendererId(fallbackDescriptor.renderer)
        : null;
    return fallbackDescriptor && fallbackRendererId
        ? Object.freeze({ descriptor: fallbackDescriptor, rendererId: fallbackRendererId })
        : null;
}

function resolveHostedWebProjectionMount(params: Readonly<{
    pluginId: string;
    contributionId: unknown;
    entriesById: Readonly<Record<string, unknown>>;
}>): Readonly<{
    contributionId: string;
    contribution: Readonly<Record<string, unknown>> | null;
}> | null {
    const contributionId = resolvePluginUiProjectionContributionId({
        family: 'hostedWeb',
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        entriesById: params.entriesById,
    });
    if (!contributionId) {
        return null;
    }
    return Object.freeze({
        contributionId,
        contribution: readRecord(params.entriesById[contributionId]),
    });
}

function isHostedWebRuntimeAvailable(
    contribution: Readonly<Record<string, unknown>> | null,
    policyContext?: PluginUiPolicyEvaluationContext,
): boolean {
    if (!contribution) {
        return false;
    }
    if (policyContext && !canRenderPluginUiProjectionEntry(contribution, policyContext)) {
        return false;
    }
    const runtime = readRecord(contribution.runtime);
    const decision = readRecord(runtime?.decision);
    return runtime?.state === 'available'
        && (decision?.state === 'render' || decision?.state === 'load');
}

type CrossModeFallbackMount =
    | Readonly<{ kind: 'host'; descriptor: PluginSurfaceHostDescriptor; rendererId: string }>
    | Readonly<{
        kind: 'hostedWeb';
        contributionId: string;
        contribution: Readonly<Record<string, unknown>> | null;
    }>;

/**
 * REG-2: decide whether to mount a cross-mode fallback instead of the declared
 * primary mode. The declared primary keeps priority while available; once it is
 * runtime-unavailable, the registry's `selectRuntimeMode` chooses among the
 * fallback modes that are actually mountable.
 */
function resolveCrossModeFallbackMount(params: Readonly<{
    descriptor: PluginSurfaceHostDescriptor;
    renderer: Readonly<Record<string, unknown>>;
    pluginUiProjection?: PluginUiProjectionModel | null;
    policyContext: PluginUiPolicyEvaluationContext;
}>): CrossModeFallbackMount | null {
    const renderer = params.renderer;
    const declaredMode = rendererKindToRuntimeMode(renderer.kind);
    const fallbackRef = readRecord(renderer.fallback);
    const fallbackMode = fallbackRefToRuntimeMode(fallbackRef);
    if (!declaredMode || declaredMode === 'host' || !fallbackRef || !fallbackMode || fallbackMode === declaredMode) {
        return null;
    }

    const declaredAvailable = isDeclaredRendererRuntimeAvailable({
        renderer,
        descriptor: params.descriptor,
        pluginUiProjection: params.pluginUiProjection,
    });
    if (declaredAvailable) {
        return null;
    }

    const hostedWebFallback = fallbackRef.kind === 'hostedWeb'
        ? resolveHostedWebProjectionMount({
            pluginId: params.descriptor.pluginId,
            contributionId: fallbackRef.contributionId,
            entriesById: params.pluginUiProjection?.hostedWebById ?? {},
        })
        : null;
    const hostedWebAvailable = Boolean(
        hostedWebFallback
        && isHostedWebRuntimeAvailable(hostedWebFallback.contribution, params.policyContext),
    );
    const hostedWebFallbackRef = hostedWebFallback?.contribution
        ? readRecord(hostedWebFallback.contribution.fallback)
        : null;
    const hostFallback = resolveHostFallbackForRef({
        pluginId: params.descriptor.pluginId,
        fallbackRef,
        surfacePlacementsById: params.pluginUiProjection?.surfacePlacementsById ?? {},
    }) ?? (
        hostedWebAvailable
            ? null
            : resolveHostFallbackForRef({
                pluginId: params.descriptor.pluginId,
                fallbackRef: hostedWebFallbackRef,
                surfacePlacementsById: params.pluginUiProjection?.surfacePlacementsById ?? {},
            })
    );
    const hostAvailable = Boolean(
        hostFallback
        && canRenderPluginSurfaceDescriptor(hostFallback.descriptor, params.policyContext),
    );
    const providedModes = [...resolveSurfaceMountProvidedModes(renderer)];
    appendRuntimeMode(providedModes, hostFallback ? 'host' : null);

    // REG-2: trust-compatibility (runtime-version + `nativeCapabilitiesDigest`
    // checks) is already FOLDED INTO each mode's projected runtime decision — a
    // trust-denied contribution projects `fallback`, never `render`/`load`, so
    // `isDeclaredRendererRuntimeAvailable` returns false. We do NOT add a parallel
    // `isTrustCompatible` here (that would duplicate the trust logic the cli
    // projection already owns); the single trust signal flows through the decision.
    const selectedMode = resolveSurfaceMountMode({
        surfaceId: params.descriptor.placement,
        renderer,
        providedModes,
        isRuntimeAvailable: (mode) => {
            if (mode === declaredMode) {
                return false;
            }
            if (mode === 'host') {
                return hostAvailable;
            }
            if (mode === 'hostedWeb') {
                return hostedWebAvailable;
            }
            return false;
        },
    });

    if (selectedMode === 'host' && hostFallback) {
        return Object.freeze({ kind: 'host', ...hostFallback });
    }
    if (selectedMode === 'hostedWeb' && hostedWebFallback) {
        return Object.freeze({ kind: 'hostedWeb', ...hostedWebFallback });
    }
    return null;
}

/**
 * REG-2: is the declared renderer's runtime available for mount? hostedWeb is
 * available when its contribution projects an available/render runtime decision;
 * RN/embedded are available when their runtime decision is loadable. A renderer
 * whose contribution is absent or whose decision is fallback/blocked/disabled is
 * runtime-unavailable → the registry may cross-fall to the host mode.
 */
function isDeclaredRendererRuntimeAvailable(params: Readonly<{
    renderer: Readonly<Record<string, unknown>>;
    descriptor: PluginSurfaceHostDescriptor;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): boolean {
    const renderer = params.renderer;
    if (renderer.kind === 'hostedWeb') {
        const hostedWebMount = resolveHostedWebProjectionMount({
            pluginId: params.descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: params.pluginUiProjection?.hostedWebById ?? {},
        });
        return isHostedWebRuntimeAvailable(hostedWebMount?.contribution ?? null);
    }
    if (renderer.kind === 'reactNative') {
        const contributionId = resolvePluginUiProjectionContributionId({
            family: 'reactNativeBundle',
            pluginId: params.descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: params.pluginUiProjection?.reactNativeBundlesById ?? {},
        });
        const contribution = contributionId
            ? params.pluginUiProjection?.reactNativeBundlesById[contributionId] ?? null
            : null;
        const runtime = readReactNativeRuntimeState(contribution ?? null);
        return runtime?.decision.state === 'load';
    }
    return false;
}

type PluginSurfaceRenderGateDecision =
    | Readonly<{ canRender: true }>
    | Readonly<{ canRender: false; reason: string }>;

function firstDiagnosticOrReason(
    diagnostics: readonly string[],
    fallback: string,
): string {
    const diagnostic = diagnostics.find((entry) => entry.trim().length > 0);
    return diagnostic ?? fallback;
}

function normalizeUnavailableReason(reason: string): string {
    return reason === 'feature_gate_disabled' ? 'feature_disabled' : reason;
}

function resolvePluginSurfaceDescriptorRenderGate(
    descriptor: PluginSurfaceHostDescriptor,
    policyContext: PluginUiPolicyEvaluationContext,
): PluginSurfaceRenderGateDecision {
    const policyDecision = evaluatePluginUiPolicy(descriptor, policyContext);
    if (!policyDecision.visible) {
        return {
            canRender: false,
            reason: normalizeUnavailableReason(firstDiagnosticOrReason(
                policyDecision.diagnostics,
                'policy_unavailable',
            )),
        };
    }
    if (descriptor.contributionKind !== 'surfacePlacement') {
        return { canRender: true };
    }
    const availability = readRecord(descriptor.availability);
    if (availability?.state !== 'available') {
        return {
            canRender: false,
            reason: normalizeUnavailableReason(
                readOptionalString(availability?.reason)
                    ?? firstDiagnosticOrReason(readStringArray(availability?.diagnostics), 'surface_unavailable'),
            ),
        };
    }
    return { canRender: true };
}

function resolveProjectionEntryUnavailableReason(
    entry: Readonly<Record<string, unknown>> | null | undefined,
    policyContext: PluginUiPolicyEvaluationContext,
    fallback: string,
): string | null {
    if (!entry) {
        return fallback;
    }
    const policyDecision = evaluatePluginUiPolicy(entry, policyContext);
    if (policyDecision.visible) {
        return null;
    }
    return normalizeUnavailableReason(firstDiagnosticOrReason(
        policyDecision.diagnostics,
        fallback,
    ));
}

function renderPluginSurfaceUnavailable(reason: string): React.ReactElement {
    return (
        <PluginSurfaceFallback
            testID="plugin-surface-unavailable"
            reason={`${t('common.unavailable')}: ${reason}`}
        />
    );
}

function canRenderPluginSurfaceDescriptor(
    descriptor: PluginSurfaceHostDescriptor,
    policyContext: PluginUiPolicyEvaluationContext,
): boolean {
    return resolvePluginSurfaceDescriptorRenderGate(descriptor, policyContext).canRender;
}

export function PluginSurfaceHost(props: Readonly<{
    descriptor: PluginSurfaceHostDescriptor;
    renderer: Readonly<Record<string, unknown>>;
    resourceBrowserTarget?: unknown;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
    hostApi?: PluginSurfaceHostApi;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
}>): React.ReactElement | null {
    const descriptor = props.descriptor;
    const renderer = props.renderer;
    const endpointStatus = useEndpointStatus();
    const machineCliDetectionTarget = useMachineCliDetectionTarget(props.machineId ?? null);
    const daemonInteractionEnabled = endpointStatus === 'online'
        && machineCliDetectionTarget.isOnline
        && props.projectionInteractionEnabled !== false;
    const policyContext = createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform: props.platform ?? props.hostApi?.platform ?? 'web',
            channel: props.hostApi?.channel ?? 'internal',
        },
    );
    const renderGate = resolvePluginSurfaceDescriptorRenderGate(descriptor, policyContext);
    if (!renderGate.canRender) {
        return renderPluginSurfaceUnavailable(renderGate.reason);
    }
    // Phase 1.3: every executable surface gets a scope-aware host API. The mount
    // may supply a richer one (browser panel); otherwise the canonical factory
    // builds a default that answers getSurfaceContext + fails closed elsewhere.
    const resolvedHostApi = resolveSurfaceHostApi(descriptor, props.platform, props.hostApi);

    if (renderer.kind === 'declarative') {
        const model = readRecord(renderer.model);
        const modelIdentity = readRecord(model?.identity);
        if (
            !model
            || model.visible !== true
            || modelIdentity?.pluginId !== descriptor.pluginId
            || !readOptionalString(modelIdentity.generation)
            || !readRecord(model.root)
        ) {
            return renderPluginSurfaceUnavailable('declarative_model_unavailable');
        }
        return (
            <DeclarativePluginSurface
                pluginId={descriptor.pluginId}
                model={model}
                machineId={props.machineId}
                serverId={props.serverId}
                interactionEnabled={daemonInteractionEnabled}
                authorityGeneration={machineCliDetectionTarget.daemonStateVersion}
            />
        );
    }

    // REG-2: cross-mode runtime selection through the Surface Registry SSOT. When
    // the placement's declared renderer mode is unavailable at runtime (e.g. a
    // hostedWeb surface whose served endpoint has not been minted) but a registry-
    // supported cross-mode `host` fallback IS available, the registry selects the
    // `host` mode and we mount the fallback HOST descriptor instead of rendering
    // the dead primary. The within-mode `fallback` ref stays the secondary path
    // for modes the primary itself can still render (handled per-renderer below).
    const renderHostedWebPane = (
        surfaceDescriptor: PluginSurfaceHostDescriptor,
        contributionId: string,
        contribution: Readonly<Record<string, unknown>> | null,
    ) => {
        // Phase 6.1: an explicit mount target wins; otherwise an installed
        // static-asset hosted-web surface derives its served endpoint from the
        // daemon-registered local-service preview keyed by the canonical id.
        const browserTarget = readSurfaceBrowserTarget({
            resourceBrowserTarget: props.resourceBrowserTarget,
            descriptor: surfaceDescriptor,
        }) ?? resolveHostedWebStaticAssetBrowserTarget({
            contribution,
            sessionId: props.sessionId,
            machineId: props.machineId,
        });
        const preview = props.localServicePreviewState && browserTarget?.kind === 'localServicePreview'
            ? selectLocalServicePreviewByBrowserTarget(props.localServicePreviewState, browserTarget)
            : null;
        return (
            <PluginHostedWebPane
                contributionId={contributionId}
                surfaceId={surfaceDescriptor.id}
                pluginUiProjection={props.pluginUiProjection}
                endpointUrl={preview?.accessUrl ?? null}
                expiresAt={preview?.expiresAt ?? null}
                platform={props.platform}
                sessionId={props.sessionId}
                surfacePlacement={resolveDescriptorSurfaceContextPlacement(surfaceDescriptor)}
                resourceScope={resolveSurfaceResourceScope(surfaceDescriptor).resourceScope}
                nowMs={props.nowMs}
                hostApi={resolvedHostApi}
                interactionEnabled={Boolean(props.hostApi) && daemonInteractionEnabled}
                policyContext={policyContext}
            />
        );
    };

    const crossModeFallback = resolveCrossModeFallbackMount({
        descriptor,
        renderer,
        pluginUiProjection: props.pluginUiProjection,
        policyContext,
    });
    if (crossModeFallback?.kind === 'host') {
        const HostRenderer = resolvePluginHostRendererComponent(crossModeFallback.rendererId);
        if (HostRenderer) {
            return (
                <HostRenderer
                    surfaceId={crossModeFallback.descriptor.id}
                    display={readHostRendererDisplay(crossModeFallback.descriptor)}
                    resolveDisplayKey={createHostRendererDisplayKeyResolver({
                        projection: props.pluginUiProjection,
                        pluginId: crossModeFallback.descriptor.pluginId,
                    })}
                    testID={`plugin-host-renderer-${crossModeFallback.rendererId}`}
                />
            );
        }
        return (
            <PluginSurfaceFallback
                testID={`plugin-surface-placement-${crossModeFallback.rendererId}`}
            />
        );
    }
    if (crossModeFallback?.kind === 'hostedWeb') {
        return renderHostedWebPane(descriptor, crossModeFallback.contributionId, crossModeFallback.contribution);
    }

    const hostRendererId = readHostRendererId(renderer);
    if (hostRendererId) {
        // PR-12 (Seam 2): a `{kind:'host', rendererId}` placement renders through the
        // renderer-id → React component map when the id is in the pure protocol set;
        // an unregistered id stays a host-owned fallback (fail-closed). The component
        // receives descriptor-DECLARED display content only — never raw handles.
        const HostRenderer = resolvePluginHostRendererComponent(hostRendererId);
        if (HostRenderer) {
            return (
                <HostRenderer
                    surfaceId={descriptor.id}
                    display={readHostRendererDisplay(descriptor)}
                    resolveDisplayKey={createHostRendererDisplayKeyResolver({
                        projection: props.pluginUiProjection,
                        pluginId: descriptor.pluginId,
                    })}
                    testID={`plugin-host-renderer-${hostRendererId}`}
                />
            );
        }
        return (
            <PluginSurfaceFallback
                testID={`plugin-surface-placement-${hostRendererId}`}
            />
        );
    }
    if (renderer.kind === 'host') {
        return (
            <PluginSurfaceFallback
                testID="plugin-surface-placement-unavailable"
            />
        );
    }
    if (renderer.kind === 'hostedWeb') {
        const hostedWebMount = resolveHostedWebProjectionMount({
            pluginId: descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: props.pluginUiProjection?.hostedWebById ?? {},
        });
        return renderHostedWebPane(
            descriptor,
            hostedWebMount?.contributionId ?? '',
            hostedWebMount?.contribution ?? null,
        );
    }

    if (renderer.kind === 'reactNative') {
        const contributionId = resolvePluginUiProjectionContributionId({
            family: 'reactNativeBundle',
            pluginId: descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: props.pluginUiProjection?.reactNativeBundlesById ?? {},
        });
        const contribution = contributionId
            ? props.pluginUiProjection?.reactNativeBundlesById[contributionId] ?? null
            : null;
        const runtime = readReactNativeRuntimeState(contribution ?? null);
        const cacheIdentity = runtime?.cacheIdentity ?? null;
        const resolvedRnContributionId = contribution?.contributionId
            ? String(contribution.contributionId)
            : contributionId ?? '';
        const artifactGraph = readGeneratedReactNativeArtifactGraph(contribution);
        const generatedV2 = contribution?.generatedV2 === true;
        const moduleReference = generatedV2
            ? readGeneratedReactNativeModuleReference(artifactGraph)
            : readReactNativeModuleReference({
                pluginId: descriptor.pluginId,
                contributionId: resolvedRnContributionId,
                entry: contribution?.entry,
            });
        const generatedArtifactAdmissionSatisfied = !generatedV2 || (
            artifactGraph !== null
            && cacheIdentity !== null
            && props.pluginUiProjection?.generation !== null
            && props.pluginUiProjection?.generation !== undefined
            && cacheIdentity.projectionGeneration === props.pluginUiProjection.generation
            && cacheIdentity.artifactDigest === artifactGraph.digest
            && cacheIdentity.platform === artifactGraph.platform
            && (artifactGraph.platform === 'web' || moduleReference !== undefined)
        );
        // RN-WEB-LOADER: resolve the backend explicitly here — the ONE place
        // that picks Re.Pack (native) vs the web-module backend (web) — so a
        // web-rendered reactNative surface never silently falls through to
        // loader.ts's internal repack-only default (which fails closed on
        // web by design, per `nativeRepackClientResolver.ts`). Tests/callers
        // may still override via `props.reactNativeLoaderBackend`.
        const effectiveReactNativeLoaderBackend =
            props.reactNativeLoaderBackend ?? resolveDefaultReactNativeLoaderBackend();
        const installedArtifactLoad = runtime?.decision.state === 'load'
            && runtime.loadPolicy?.source === 'installedArtifact'
            && cacheIdentity
            && generatedArtifactAdmissionSatisfied
            ? createReactNativeInstalledArtifactLoad(cacheIdentity, moduleReference, props.platform ?? 'web', {
                machineId: props.machineId,
                serverId: props.serverId,
            }, effectiveReactNativeLoaderBackend, artifactGraph ?? undefined)
            : undefined;
        // RN-2: a `devHotReload` source loads from the projected local dev-server URL
        // (no installed artifact, no machine RPC). REG-2 owns the mount-mode switch;
        // this branch is the RN-owned dev LOAD path mounted on top of it.
        const devServerLoad = runtime?.decision.state === 'load'
            && runtime.loadPolicy?.source === 'devHotReload'
            && runtime.loadPolicy.devUrl
            && moduleReference
            ? createReactNativeDevServerLoad({
                devUrl: runtime.loadPolicy.devUrl,
                pluginId: descriptor.pluginId,
                contributionId: resolvedRnContributionId,
                moduleReference,
            }, effectiveReactNativeLoaderBackend)
            : undefined;
        const load = installedArtifactLoad ?? devServerLoad;
        const onCrashDisable = props.machineId && cacheIdentity
            ? async (event: Readonly<{
                surfaceId: string;
                cacheIdentity: PluginReactNativeBundleCacheIdentity;
                disabledReason: 'render_error_threshold' | 'startup_ack_timeout_threshold';
                crashCount: number;
                startupFailureCount: number;
            }>) => {
                await reportReactNativeCrashDisableViaMachineRpc({
                    machineId: props.machineId ?? '',
                    serverId: props.serverId,
                    surfaceId: event.surfaceId,
                    cacheIdentity: event.cacheIdentity,
                    disabledReason: event.disabledReason,
                    crashCount: event.crashCount,
                    startupFailureCount: event.startupFailureCount,
                    observedAtMs: props.nowMs?.() ?? Date.now(),
                    diagnostics: [event.disabledReason],
                });
            }
            : undefined;
        const surface = contributionId ? {
            pluginId: descriptor.pluginId,
            contributionId: contribution?.contributionId ?? contributionId,
            surfaceId: descriptor.id,
            placement: resolveDescriptorSurfaceContextPlacement(descriptor),
            platform: props.platform ?? 'web',
            channel: 'internal' as const,
            resourceScope: [...resolveSurfaceResourceScope(descriptor).resourceScope],
            diagnostics: [],
        } : undefined;
        const canonicalRenderIdentity = generatedV2 && artifactGraph
            ? {
                pluginId: descriptor.pluginId,
                pluginVersion: readOptionalString(contribution?.pluginVersion) ?? '0.0.0',
                viewId: descriptor.descriptorId,
                placement: descriptor.placement as PluginUiRenderContext['view']['placement'],
                generation: String(props.pluginUiProjection?.generation ?? cacheIdentity?.projectionGeneration ?? 0),
                platform: props.platform ?? resolvedHostApi.platform,
                sessionId: props.sessionId,
            }
            : undefined;
        const descriptorDisplayRecord = readRecord(descriptor.display);
        const descriptorDisplay = readHostRendererDisplay(descriptor);
        const snapshotTitle = resolvePluginDisplayString({
            developerFallback: descriptorDisplay?.developerFallback,
            keys: [descriptorDisplay?.labelKey, descriptorDisplay?.titleKey],
            resolveKey: createHostRendererDisplayKeyResolver({
                projection: props.pluginUiProjection,
                pluginId: descriptor.pluginId,
            }),
        })
            ?? readOptionalString(descriptorDisplayRecord?.label)
            ?? readOptionalString(descriptorDisplayRecord?.title)
            ?? descriptor.id;
        return (
            <PluginReactNativeSurfaceHost
                surfaceId={descriptor.id}
                snapshotTitle={snapshotTitle}
                surface={surface}
                decision={runtime?.decision ?? {
                    state: 'fallback',
                    reason: contributionId ? 'feature_disabled' : 'unknown',
                    diagnostics: contributionId ? ['react_native_loader_unavailable'] : ['react_native_contribution_unavailable'],
                    fallback: readFallbackRef(descriptor.fallback),
                }}
                loadPolicy={runtime?.loadPolicy}
                cacheKey={runtime?.cacheKey}
                cacheIdentity={cacheIdentity}
                load={load}
                hostApi={resolvedHostApi}
                interactionEnabled={Boolean(props.hostApi)
                    && daemonInteractionEnabled
                    && generatedArtifactAdmissionSatisfied}
                canonicalRenderIdentity={canonicalRenderIdentity}
                allowedHostApiMethods={readReactNativeAllowedHostApiMethods(contribution)}
                onCrashDisable={onCrashDisable}
            />
        );
    }

    return null;
}

export function PluginSurfacePlacementHost(props: Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    resourceBrowserTarget?: unknown;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
    hostApi?: PluginSurfaceHostApi;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
}>): React.ReactElement | null {
    return (
        <PluginSurfaceHost
            descriptor={props.placement}
            renderer={props.placement.renderer}
            resourceBrowserTarget={props.resourceBrowserTarget}
            machineId={props.machineId}
            serverId={props.serverId}
            sessionId={props.sessionId}
            pluginUiProjection={props.pluginUiProjection}
            localServicePreviewState={props.localServicePreviewState}
            platform={props.platform}
            nowMs={props.nowMs}
            hostApi={props.hostApi}
            projectionInteractionEnabled={props.projectionInteractionEnabled}
            policyContext={props.policyContext}
            reactNativeLoaderBackend={props.reactNativeLoaderBackend}
        />
    );
}
