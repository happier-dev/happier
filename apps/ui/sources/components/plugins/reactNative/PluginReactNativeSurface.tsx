import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    createPluginUiHostApiResourceClient,
    createPluginUiResourceStore,
    type PluginUiResourceAccountLifetime,
    type PluginUiResourceStore,
} from '@happier-dev/plugin-ui/advanced';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PluginUiMountContextV1Schema,
    PluginUiTargetedContributionsV1Schema,
    type PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginReactNativeCompatibilityDecision,
} from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    resolvePluginReactNativeLoaderPolicy,
    type PluginReactNativeLoaderPolicyInput,
} from './loaderPolicy';
import {
    getInstalledPluginReactNativeModuleRegistry,
    type PluginReactNativeModuleRegistryWriteFence,
} from './moduleRegistry';
import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';
import type { SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    PluginSurfaceFallback,
    resolvePluginSurfaceStateAction,
} from '@/components/sessions/panes/PluginSurfaceFallback';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { PluginUiBoundary } from './PluginUiBoundary';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import {
    logPluginSurfaceDiagnostic,
    readPluginSurfaceDiagnosticError,
} from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    createPluginReactNativeWatchdog,
    type PluginReactNativeWatchdog,
} from './watchdog';
import { PLUGIN_UI_PRIVATE_SURFACE_ENTRY_PROVIDER_KEY } from '@/components/plugins/pluginUiPrivateCarrierKeys';
import { useWidgetFrameResourceStoreActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';

type PluginReactNativeLocalFailure = 'render_error' | 'invalid_surface_module' | 'load_error';

/**
 * Cooperative host-private carrier bindings for the bundled `defineUiSurface`
 * entry provider. They stay outside the public RenderContext ABI and are
 * installed only after `renderSurface` returns the conventional provider
 * element. This is not provenance or an authorization boundary: bundled
 * plugins are trusted participants in the convention.
 */
export type PluginReactNativeSurfacePrivateHostBindings = Readonly<{
    accountLifetime?: unknown;
    resourceStoreGeneration?: unknown;
    resourceStore?: PluginUiResourceStore;
    /** Host-selected Composer mount ref for the cooperative carrier; never part of RenderContext. */
    composerRef?: unknown;
    presentationHost?: unknown;
    /** Presentation-only visibility; does not narrow author or Resource activity. */
    presentationActive?: boolean;
    dataClient?: unknown;
    /** In-process Account+plugin+immutable-generation scope; absent means unavailable. */
    ephemeralSharedScope?: unknown;
}>;

export type PluginReactNativeSurfaceModule = Readonly<{
    renderSurface: (context: RenderContext) => React.ReactElement | null;
}>;

function isPluginReactNativeSurfaceModule(value: unknown): value is PluginReactNativeSurfaceModule {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as { renderSurface?: unknown }).renderSurface === 'function';
}

/**
 * A noncanonical RenderContext is refused at the mount boundary, so diagnostics
 * must read its plugin identity defensively rather than assume the ABI held.
 */
function readRenderContextPluginId(renderContext: RenderContext): string | null {
    const plugin = (renderContext as Partial<RenderContext> | null | undefined)?.plugin;
    return typeof plugin?.id === 'string' && plugin.id.length > 0 ? plugin.id : null;
}

function readLoaderErrorDiagnostics(error: unknown): readonly string[] {
    const diagnostics = error && typeof error === 'object'
        ? (error as { diagnostics?: unknown }).diagnostics
        : null;
    if (Array.isArray(diagnostics)) {
        return Object.freeze(diagnostics.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0));
    }
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    return typeof code === 'string' && code.trim().length > 0 ? Object.freeze([code]) : Object.freeze([]);
}

type PluginReactNativeSurfaceProps = Readonly<{
    surfaceId: string;
    /** Resolver-stamped ephemeral mount identity; never a watchdog persistence key. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Existing host-owned mount/catalog identity that permits a fresh render attempt. */
    boundaryResetKey?: string;
    snapshotTitle?: string;
    decision: PluginReactNativeCompatibilityDecision;
    module?: PluginReactNativeSurfaceModule | null;
    load?: () => PluginReactNativeSurfaceModule | Promise<PluginReactNativeSurfaceModule>;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    renderContext: RenderContext;
    privateHostBindings?: PluginReactNativeSurfacePrivateHostBindings;
    interactionEnabled?: boolean;
    /** Layout/route presentation eligibility; distinct from availability. */
    focusEligible?: boolean;
    /**
     * Exact host-admitted bytes identity. It is stamped only on the enabled
     * boundary below, after the verified loader has produced a renderable
     * module, so diagnostics can distinguish a projected candidate from the
     * artifact response the browser actually adopted.
     */
    loadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        occurrenceId: string;
        artifactDigest: `sha256:${string}`;
        machineId?: string | null;
        serverId?: string | null;
    }>;
    /** Targeted caller fallback, consumed only for a contributor render crash. */
    targetedFallback?: React.ReactNode;
    onCrash?: (surfaceId: string, error: Error) => void;
    watchdog?: PluginReactNativeWatchdog;
    /** Existing route-owned recovery callback for settings/update/enable actions. */
    recoveryAction?: SurfaceStateAction;
}>;

type LoadedPluginReactNativeModuleState = Readonly<{
    cacheKey: string | undefined;
    module: PluginReactNativeSurfaceModule | null;
}>;
type PendingPluginReactNativeModuleState = LoadedPluginReactNativeModuleState & Readonly<{
    writeFence: PluginReactNativeModuleRegistryWriteFence | null;
}>;

const loadedModuleRegistry = getInstalledPluginReactNativeModuleRegistry();
let nextPluginReactNativeMountOwnerId = 0;
const defaultWatchdog = createPluginReactNativeWatchdog();

const resetFeedbackStyles = StyleSheet.create({
    surface: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
    },
    retainedStatus: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 8,
    },
    retainedStatusTitle: {
        ...Typography.rowTitle(),
    },
    retainedStatusReason: {
        ...Typography.rowMeta(),
    },
    retainedStatusAction: {
        alignSelf: 'flex-start',
    },
    pendingCandidate: {
        ...StyleSheet.absoluteFillObject,
    },
});

type PluginReactNativeSurfaceRendererProps = Readonly<{
    module: PluginReactNativeSurfaceModule;
    renderContext: RenderContext;
    privateHostBindings?: PluginReactNativeSurfacePrivateHostBindings;
}>;

/**
 * Cooperative host-private carrier marker for trusted generated artifacts.
 * It selects the conventional injection target; it is not unforgeable
 * provenance or an authority grant.
 */
const PLUGIN_UI_COOPERATIVE_HOST_PRIVATE_ENTRY_PROVIDER_KEY =
    PLUGIN_UI_PRIVATE_SURFACE_ENTRY_PROVIDER_KEY;

function isPluginUiCooperativeHostPrivateEntryProviderElement(element: React.ReactElement): boolean {
    const type = element.type;
    if (
        (typeof type !== 'function' && typeof type !== 'object')
        || type === null
    ) {
        return false;
    }
    return Reflect.get(type, PLUGIN_UI_COOPERATIVE_HOST_PRIVATE_ENTRY_PROVIDER_KEY) === true;
}

function installPluginUiPrivateHostBindings(
    element: React.ReactElement | null,
    bindings: PluginReactNativeSurfacePrivateHostBindings | undefined,
): React.ReactElement | null {
    if (!element || !bindings || !isPluginUiCooperativeHostPrivateEntryProviderElement(element)) {
        return element;
    }
    const privateProviderProps: Record<string, unknown> = {};
    if (bindings.accountLifetime !== undefined) {
        privateProviderProps.accountLifetime = bindings.accountLifetime;
    }
    if (bindings.resourceStoreGeneration !== undefined) {
        privateProviderProps.resourceStoreGeneration = bindings.resourceStoreGeneration;
    }
    if (bindings.resourceStore !== undefined) {
        privateProviderProps.resourceStore = bindings.resourceStore;
    }
    if (bindings.composerRef !== undefined) {
        privateProviderProps.composerRef = bindings.composerRef;
    }
    if (bindings.presentationHost !== undefined) {
        privateProviderProps.presentationHost = bindings.presentationHost;
    }
    if (bindings.presentationActive !== undefined) {
        privateProviderProps.presentationActive = bindings.presentationActive;
    }
    if (bindings.dataClient !== undefined) {
        privateProviderProps.dataClient = bindings.dataClient;
    }
    if (bindings.ephemeralSharedScope !== undefined) {
        privateProviderProps.ephemeralSharedScope = bindings.ephemeralSharedScope;
    }
    if (Object.keys(privateProviderProps).length === 0) {
        return element;
    }
    return React.cloneElement(
        element as React.ReactElement<Record<string, unknown>>,
        privateProviderProps,
    );
}

function PluginReactNativeSurfaceRenderer({
    module,
    renderContext,
    privateHostBindings,
}: PluginReactNativeSurfaceRendererProps): React.ReactElement | null {
    const element = React.useMemo(
        () => module.renderSurface(renderContext),
        [module, renderContext],
    );
    const bindings = useNativeResourceHostBindings(privateHostBindings, renderContext, element);
    return React.useMemo(
        () => installPluginUiPrivateHostBindings(element, bindings),
        [element, bindings],
    );
}

/** Narrow the existing trusted host-private facade, never Account identity or an author-supplied token. */
function isResourceAccountLifetime(value: unknown): value is PluginUiResourceAccountLifetime {
    return value !== null && typeof value === 'object'
        && 'isCurrent' in value && typeof value.isCurrent === 'function'
        && 'onRetire' in value && typeof value.onRetire === 'function';
}

function useNativeResourceHostBindings(
    bindings: PluginReactNativeSurfacePrivateHostBindings | undefined,
    renderContext: RenderContext,
    element: React.ReactElement | null,
) {
    const hasProvider = element !== null && isPluginUiCooperativeHostPrivateEntryProviderElement(element);
    const accountLifetime = bindings?.accountLifetime;
    const fallback = React.useMemo(() => {
        if (!hasProvider || bindings?.resourceStore) return undefined;
        if (accountLifetime !== undefined && accountLifetime !== null && !isResourceAccountLifetime(accountLifetime)) return undefined;
        // Use the incumbent provider fallback's exact L1 factory and inputs. Injecting it means the provider creates no second store.
        return createPluginUiResourceStore({
            client: createPluginUiHostApiResourceClient(renderContext.hostApi),
            accountLifetime: accountLifetime ?? null,
            pluginId: renderContext.plugin.id,
        });
    }, [accountLifetime, bindings?.resourceStore, bindings?.resourceStoreGeneration, hasProvider, renderContext.hostApi, renderContext.plugin.id]);
    React.useEffect(() => fallback ? () => fallback.dispose() : undefined, [fallback]);
    const resourceStore = useWidgetFrameResourceStoreActivity(bindings?.resourceStore ?? fallback);
    return React.useMemo(() => resourceStore && resourceStore !== bindings?.resourceStore
        ? { ...bindings, resourceStore } : bindings, [bindings, resourceStore]);
}

function PluginReactNativeCandidateRenderer(props: PluginReactNativeSurfaceRendererProps & Readonly<{
    onReady: () => void;
}>): React.ReactElement | null {
    const element = props.module.renderSurface(props.renderContext);
    const bindings = useNativeResourceHostBindings(props.privateHostBindings, props.renderContext, element);
    React.useLayoutEffect(props.onReady, [props.onReady]);
    return installPluginUiPrivateHostBindings(element, bindings);
}

/**
 * EU-1: a canonical render context is recognised by its host API VERSION
 * discriminant, never by counting installed methods. The installed set is a
 * FACT about the mount (UI-D02) and is legitimately narrow, so counting it would
 * reject a correct context; and an unrecognised context must fail the mount with
 * the returned diagnostic rather than using an alternate public context shape.
 */
function readCanonicalPluginUiRenderContextDiagnostic(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
        return 'render_context_not_canonical';
    }
    const context = value as Partial<RenderContext>;
    if (!context.plugin?.id || !context.plugin?.version) return 'render_context_plugin_identity_missing';
    if ('view' in context) return 'render_context_view_removed';
    if (!context.surface) return 'render_context_surface_missing';
    if (!PluginUiMountContextV1Schema.safeParse(context.surface.mount).success) {
        return 'render_context_surface_mount_invalid';
    }
    if (context.surface.targetedContributions !== undefined
        && !PluginUiTargetedContributionsV1Schema.safeParse(context.surface.targetedContributions).success) {
        return 'render_context_targeted_contributions_invalid';
    }
    if (!(context.signal instanceof AbortSignal)) return 'render_context_signal_missing';
    const hostApi = context.hostApi as Partial<RenderContext['hostApi']> | undefined;
    if (!hostApi || typeof hostApi.version !== 'function') return 'render_context_host_api_missing';
    let version: ReturnType<RenderContext['hostApi']['version']>;
    try {
        version = hostApi.version();
    } catch {
        return 'render_context_host_api_version_unreadable';
    }
    if (version?.wireVersion !== PLUGIN_UI_HOST_API_WIRE_VERSION_V1
        || version.apiVersion !== PLUGIN_UI_HOST_API_VERSION_V1) {
        return 'render_context_host_api_version_unsupported';
    }
    return null;
}

export function PluginReactNativeSurface(props: PluginReactNativeSurfaceProps): React.ReactElement {
    const [mountOwnerId] = React.useState(() => {
        nextPluginReactNativeMountOwnerId += 1;
        return nextPluginReactNativeMountOwnerId;
    });
    const [loadedModuleState, setLoadedModuleState] = React.useState<LoadedPluginReactNativeModuleState>(() => ({
        cacheKey: props.cacheKey,
        module: loadedModuleRegistry.read(props.cacheKey),
    }));
    const [pendingModuleState, setPendingModuleState] = React.useState<PendingPluginReactNativeModuleState | null>(null);
    const cachedModule = loadedModuleState.cacheKey === props.cacheKey
        ? loadedModuleState.module
        : loadedModuleRegistry.read(props.cacheKey);
    const retainedModule = loadedModuleState.cacheKey !== props.cacheKey
        ? loadedModuleState.module
        : null;
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [targetedFallbackMountAttemptId, setTargetedFallbackMountAttemptId] = React.useState<string | null>(null);
    const [loadFailureDiagnostics, setLoadFailureDiagnostics] = React.useState<readonly string[]>([]);
    const [retryGeneration, setRetryGeneration] = React.useState(0);
    const [retrying, setRetrying] = React.useState(false);
    const loadPolicy = props.load && !props.loadPolicy
        ? Object.freeze({
            canLoad: false,
            diagnostics: Object.freeze(['authoritative_load_policy_missing']),
        })
        : resolvePluginReactNativeLoaderPolicy(props.loadPolicy);
    const watchdog = props.watchdog ?? defaultWatchdog;
    const artifactDigest = props.loadedRuntimeIdentity?.artifactDigest;
    const pluginId = readRenderContextPluginId(props.renderContext);
    const loadRef = React.useRef(props.load);
    const hasLoader = Boolean(props.load);
    React.useLayoutEffect(() => {
        loadRef.current = props.load;
    }, [props.load]);
    const watchdogCacheKey = props.cacheKey ?? props.surfaceId;
    const mountAttemptId = React.useMemo(() => [
        'plugin-rn-mount',
        mountOwnerId,
        props.surfaceId,
        watchdogCacheKey,
        props.mountInstanceKey ?? '',
        props.boundaryResetKey ?? '',
        artifactDigest ?? '',
        retryGeneration,
    ].join('\u0000'), [
        artifactDigest,
        mountOwnerId,
        props.boundaryResetKey,
        props.mountInstanceKey,
        props.surfaceId,
        retryGeneration,
        watchdogCacheKey,
    ]);
    const resetMountAttemptIdRef = React.useRef(mountAttemptId);
    const pendingQuarantine = artifactDigest
        ? watchdog.isContained({ artifactDigest })
        : false;

    React.useLayoutEffect(() => {
        const changedMountAttempt = resetMountAttemptIdRef.current !== mountAttemptId;
        resetMountAttemptIdRef.current = mountAttemptId;
        if (changedMountAttempt) {
            setLoadFailed(false);
            setTargetedFallbackMountAttemptId(null);
            setLoadFailureDiagnostics([]);
        }
    }, [mountAttemptId]);

    React.useLayoutEffect(() => {
        // An externally supplied mount or artifact replacement is a new
        // lifecycle, not a pending retry from the previous one.
        setRetrying(false);
    }, [artifactDigest, props.boundaryResetKey, props.mountInstanceKey, props.surfaceId, watchdogCacheKey]);

    const recordLocalFailure = React.useCallback((
        failure: PluginReactNativeLocalFailure,
        error?: unknown,
    ) => {
        logPluginSurfaceDiagnostic(
            {
                pluginId,
                contributionId: null,
                surfaceId: props.surfaceId,
            },
            {
                surfaceFailure: failure,
                error: readPluginSurfaceDiagnosticError(error),
            },
        );
        if (artifactDigest) {
            watchdog.recordFailure({ artifactDigest });
        }
    }, [
        artifactDigest,
        pluginId,
        props.surfaceId,
        watchdog,
    ]);

    React.useEffect(() => {
        if (
            props.decision.state !== 'load'
            || props.module
            || !hasLoader
            || !loadPolicy.canLoad
            || cachedModule !== null
            || pendingModuleState?.cacheKey === props.cacheKey
            || loadFailed
            || pendingQuarantine
        ) {
            return undefined;
        }

        let cancelled = false;
        // Acquisition belongs to this Artifact/mount attempt. Fresh host
        // closures and presentation contexts do not replace that lifecycle.
        const load = loadRef.current;
        // The registry—not this consumer—owns active projection currentness.
        // Capture its key-local admission before the loader can settle.
        const moduleWriteFence = loadedModuleRegistry.captureWriteFence(props.cacheKey);
        // The Artifact loader owns acquisition and its transport failures.
        // Its async phases do not share the byte RPC's start time: another
        // renderer timer could discard a valid result while that owner is live.
        Promise.resolve()
            .then(() => load?.())
            .then((nextModule) => {
                if (!cancelled && isPluginReactNativeSurfaceModule(nextModule)) {
                    setLoadFailureDiagnostics([]);
                    setLoadFailed(false);
                    setPendingModuleState({
                        cacheKey: props.cacheKey,
                        module: nextModule,
                        writeFence: moduleWriteFence,
                    });
                    setRetrying(false);
                } else if (!cancelled) {
                    recordLocalFailure('invalid_surface_module');
                    setLoadFailureDiagnostics(['invalid_surface_module']);
                    setLoadFailed(true);
                    setRetrying(false);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    recordLocalFailure('load_error', error);
                    setLoadFailureDiagnostics(readLoaderErrorDiagnostics(error));
                    setLoadFailed(true);
                    setRetrying(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        loadPolicy.canLoad,
        loadFailed,
        mountAttemptId,
        cachedModule,
        props.cacheKey,
        props.decision.state,
        hasLoader,
        props.module,
        recordLocalFailure,
        pendingQuarantine,
        pendingModuleState?.cacheKey,
    ]);

    const retryCurrentMountLocalFailure = React.useCallback(() => {
        if (artifactDigest) watchdog.clear({ artifactDigest });
        setLoadedModuleState((current) => current.cacheKey === props.cacheKey
            ? { cacheKey: props.cacheKey, module: null }
            : current);
        setPendingModuleState(null);
        setLoadFailureDiagnostics([]);
        setLoadFailed(false);
        setRetrying(true);
        setRetryGeneration((generation) => generation + 1);
    }, [
        artifactDigest,
        props.cacheKey,
        watchdog,
    ]);

    const handleRetry = React.useCallback(() => {
        if (retrying) {
            return;
        }
        retryCurrentMountLocalFailure();
    }, [retryCurrentMountLocalFailure, retrying]);

    const handleCrash = React.useCallback((surfaceId: string, error: Error) => {
        recordLocalFailure('render_error', error);
        if (props.targetedFallback !== undefined) {
            setTargetedFallbackMountAttemptId(mountAttemptId);
        }
        setLoadFailed(true);
        setRetrying(false);
        props.onCrash?.(surfaceId, error);
    }, [mountAttemptId, props.onCrash, props.targetedFallback, recordLocalFailure]);

    const pendingModuleSnapshot = pendingModuleState;
    const pendingModule = pendingModuleSnapshot === null || pendingModuleSnapshot.cacheKey !== props.cacheKey
        ? null
        : pendingModuleSnapshot.module;
    const commitPendingModule = React.useCallback(() => {
        const pending = pendingModuleState;
        if (!pending || pending.cacheKey !== props.cacheKey || !pending.module) return;
        if (pending.writeFence) {
            loadedModuleRegistry.write(props.cacheKey, pending.module, pending.writeFence);
        }
        setLoadedModuleState({ cacheKey: pending.cacheKey, module: pending.module });
        setPendingModuleState(null);
        setLoadFailureDiagnostics([]);
        setLoadFailed(false);
        setRetrying(false);
    }, [pendingModuleState, props.cacheKey]);
    const failPendingModule = React.useCallback((surfaceId: string, error: Error) => {
        setPendingModuleState(null);
        handleCrash(surfaceId, error);
    }, [handleCrash]);

    const canonicalRenderContextDiagnostic = readCanonicalPluginUiRenderContextDiagnostic(props.renderContext);
    const currentRenderContext = props.renderContext;
    const interactionEnabled = props.interactionEnabled ?? true;
    // The retained offline tree is one mounted generation. Its public context
    // and its host-only entry bindings are therefore one pair: updating either
    // half while interaction is unavailable would combine an old controller
    // with a successor Resource scope. Host visibility remains a current
    // presentation fact even while that mounted generation is retained.
    const lastInteractiveRenderStateRef = React.useRef<Readonly<{
        renderContext: RenderContext;
        privateHostBindings?: PluginReactNativeSurfacePrivateHostBindings;
    }>>({
        renderContext: currentRenderContext,
        privateHostBindings: props.privateHostBindings,
    });
    React.useLayoutEffect(() => {
        if (interactionEnabled) {
            lastInteractiveRenderStateRef.current = Object.freeze({
                renderContext: currentRenderContext,
                ...(props.privateHostBindings === undefined
                    ? {}
                    : { privateHostBindings: props.privateHostBindings }),
            });
        }
    }, [currentRenderContext, interactionEnabled, props.privateHostBindings]);
    const renderState = interactionEnabled
        ? { renderContext: currentRenderContext, privateHostBindings: props.privateHostBindings }
        : lastInteractiveRenderStateRef.current;
    const renderContext = renderState.renderContext;
    const retainedPrivateHostBindings = renderState.privateHostBindings;
    const presentationActive = props.privateHostBindings?.presentationActive;
    const privateHostBindings = React.useMemo(() => (
        presentationActive === undefined
            ? retainedPrivateHostBindings
            : { ...retainedPrivateHostBindings, presentationActive }
    ), [presentationActive, retainedPrivateHostBindings]);
    // A replacement launch input is a new render request for the same mounted
    // contributor, not a new mount. Keep its stateful tree alive when healthy,
    // but let a targeted child retry after its caller gives it new input.
    const launchInputResetKey = renderContext.launchInput === undefined
        ? 'absent'
        : `present:${stableJsonStringify(renderContext.launchInput)}`;
    const renderBoundaryResetKey = props.boundaryResetKey === undefined
        ? `${watchdogCacheKey}\u0000${launchInputResetKey}`
        : `${props.boundaryResetKey}\u0000${watchdogCacheKey}\u0000${launchInputResetKey}`;
    const launchInputResetKeyRef = React.useRef(launchInputResetKey);
    React.useLayoutEffect(() => {
        const launchInputChanged = launchInputResetKeyRef.current !== launchInputResetKey;
        launchInputResetKeyRef.current = launchInputResetKey;
        if (!launchInputChanged || targetedFallbackMountAttemptId !== mountAttemptId) {
            return;
        }
        // This is only the targeted render-failure latch. Loader and daemon
        // fault state retain their existing owner/currentness rules.
        setTargetedFallbackMountAttemptId(null);
        setLoadFailed(false);
        setLoadFailureDiagnostics([]);
        setRetrying(false);
    }, [launchInputResetKey, mountAttemptId, targetedFallbackMountAttemptId]);

    const unavailableDiagnostics = Object.freeze([
        ...loadFailureDiagnostics,
        ...(pendingQuarantine ? ['local_artifact_failure'] : []),
        ...props.decision.diagnostics,
        ...loadPolicy.diagnostics,
        ...(canonicalRenderContextDiagnostic ? [canonicalRenderContextDiagnostic] : []),
    ]);
    const canRetryCurrentArtifact = props.decision.state === 'load'
        && loadPolicy.canLoad
        && (Boolean(props.load) || isPluginReactNativeSurfaceModule(props.module));
    const shouldOfferRetry = canRetryCurrentArtifact
        && (loadFailed || pendingQuarantine);
    const animationEnabled = props.renderContext.surface.reducedMotion !== true;
    // Content settles in with one calm opacity fade the first time this mount
    // has something to draw, so the loading placeholder never hard-cuts to the
    // plugin's page. Reduced motion paints it immediately.
    const hasRenderableModule = isPluginReactNativeSurfaceModule(props.module)
        || cachedModule !== null
        || retainedModule !== null;
    const contentReveal = useSharedValue(animationEnabled ? 0 : 1);
    React.useEffect(() => {
        if (!hasRenderableModule) return;
        if (!animationEnabled) {
            cancelAnimation(contentReveal);
            contentReveal.value = 1;
            return;
        }
        contentReveal.value = withTiming(1, {
            duration: reanimatedMotionTokens.durationMs.base,
            easing: reanimatedMotionTokens.easing.standard,
        });
    }, [animationEnabled, contentReveal, hasRenderableModule]);
    const contentRevealStyle = useAnimatedStyle(() => ({ opacity: contentReveal.value }));
    const hasCurrentTargetedFallback = props.targetedFallback !== undefined
        && targetedFallbackMountAttemptId === mountAttemptId;
    const candidateProbe = pendingModule ? (
        <View style={resetFeedbackStyles.pendingCandidate}>
            <PluginUiBoundary
                surfaceId={props.surfaceId}
                resetKey={`${renderBoundaryResetKey}\u0000candidate`}
                mountInstanceKey={props.mountInstanceKey}
                fallback={null}
                onCrash={failPendingModule}
            >
                <PluginReactNativeCandidateRenderer
                    module={pendingModule}
                    renderContext={renderContext}
                    privateHostBindings={privateHostBindings}
                    onReady={commitPendingModule}
                />
            </PluginUiBoundary>
        </View>
    ) : null;

    if (canonicalRenderContextDiagnostic) {
        return <PluginReactNativeUnavailable diagnostics={unavailableDiagnostics} recoveryAction={props.recoveryAction} />;
    }
    if (hasCurrentTargetedFallback) {
        return <>{props.targetedFallback}</>;
    }
    if (
        props.decision.state !== 'load'
        || (loadFailed && !retainedModule)
        || !loadPolicy.canLoad
        || pendingQuarantine
    ) {
        return (
            <>
            <PluginReactNativeUnavailable
                diagnostics={unavailableDiagnostics}
                onRetry={shouldOfferRetry ? handleRetry : undefined}
                retrying={retrying}
                animationEnabled={animationEnabled}
                recoveryAction={props.recoveryAction}
            />
            {candidateProbe}
            </>
        );
    }

    const module = isPluginReactNativeSurfaceModule(props.module)
        ? props.module
        : cachedModule ?? retainedModule;
    if (!module) {
        // The first load (or a candidate still proving itself) is not a failure:
        // show the destination-shaped placeholder, not an "unavailable" card. A
        // user-pressed retry keeps its acknowledgement on the card it came from.
        const initialLoadInFlight = !retrying && (Boolean(props.load) || pendingModule !== null);
        return (
            <>
            {initialLoadInFlight ? (
                <PluginSurfaceFallback testID="plugin-rn-ui-loading" state="loading" />
            ) : (
                <PluginReactNativeUnavailable
                    diagnostics={unavailableDiagnostics}
                    retrying={retrying}
                    animationEnabled={animationEnabled}
                    recoveryAction={props.recoveryAction}
                />
            )}
            {candidateProbe}
            </>
        );
    }

    const surface = (
        <PluginUiBoundary
            key={mountAttemptId}
            surfaceId={props.surfaceId}
            resetKey={renderBoundaryResetKey}
            mountInstanceKey={props.mountInstanceKey}
            fallback={props.targetedFallback === undefined ? (
                <PluginReactNativeUnavailable
                    diagnostics={unavailableDiagnostics}
                    onRetry={shouldOfferRetry ? handleRetry : undefined}
                    retrying={retrying}
                    animationEnabled={animationEnabled}
                    recoveryAction={props.recoveryAction}
                />
            ) : props.targetedFallback}
            onCrash={handleCrash}
        >
            <PluginSurfaceInteractionBoundary
                surfaceId={props.surfaceId}
                snapshotTitle={props.snapshotTitle ?? props.surfaceId}
                enabled={interactionEnabled}
                focusEligible={props.focusEligible}
                loadedRuntimeIdentity={props.loadedRuntimeIdentity}
            >
                <Animated.View style={[resetFeedbackStyles.surface, contentRevealStyle]}>
                    <PluginReactNativeSurfaceRenderer
                        module={module}
                        renderContext={renderContext}
                        privateHostBindings={privateHostBindings}
                    />
                </Animated.View>
            </PluginSurfaceInteractionBoundary>
        </PluginUiBoundary>
    );
    if (!loadFailed || !retainedModule) return <>{surface}{candidateProbe}</>;

    const retainedPresentation = resolvePluginSurfaceStatePresentation({
        state: 'failedRetry',
        reasonCode: unavailableDiagnostics[0],
        hasRetainedContent: true,
    });
    const retainedNotice = retainedPresentation.contentNotice;
    if (!retainedNotice) return surface;
    const retainedAction = resolvePluginSurfaceStateAction({
        recoveryAction: retainedPresentation.recoveryAction,
        onRetry: shouldOfferRetry ? handleRetry : undefined,
        manageAction: props.recoveryAction,
    });
    return (
        <>
            <View
                testID="plugin-rn-ui-retained-status"
                accessibilityRole="text"
                accessibilityLiveRegion="polite"
                style={resetFeedbackStyles.retainedStatus}
                {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
            >
                <Text style={resetFeedbackStyles.retainedStatusTitle}>{retainedNotice.title}</Text>
                <Text style={resetFeedbackStyles.retainedStatusReason}>{retainedNotice.reason}</Text>
                {retainedAction ? (
                    <View style={resetFeedbackStyles.retainedStatusAction}>
                        <RoundButton
                            testID="plugin-rn-ui-retained-status-action"
                            size="small"
                            title={retainedAction.label}
                            accessibilityLabel={retainedAction.label}
                            action={() => Promise.resolve(retainedAction.onPress())}
                        />
                    </View>
                ) : null}
            </View>
            {surface}
            {candidateProbe}
        </>
    );
}
