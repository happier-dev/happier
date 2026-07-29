import * as React from 'react';
import type { PluginUiRenderContext } from '@happier-dev/plugin-sdk/ui';

import type { DaemonPluginReactNativeCrashReportReasonV1 } from '@happier-dev/protocol';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginReactNativeBundleCacheIdentity,
    PluginReactNativeCompatibilityDecision,
} from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    resolvePluginReactNativeLoaderPolicy,
    type PluginReactNativeLoaderPolicyInput,
} from './loaderPolicy';
import {
    createPluginReactNativeSurfaceRenderContext,
    type PluginReactNativeHostApiV1,
} from './hostApi';
import { getInstalledPluginReactNativeModuleRegistry } from './moduleRegistry';
import { PluginReactNativeUnavailable } from './PluginReactNativeUnavailable';
import { PluginUiBoundary } from './PluginUiBoundary';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import {
    createPluginReactNativeWatchdog,
    type PluginReactNativeWatchdog,
    type PluginReactNativeWatchdogState,
} from './watchdog';
import { createDefaultPluginReactNativeWatchdogPersistence } from './watchdogPersistence';

export type PluginReactNativeSurfaceRenderContext = Readonly<{
    surface?: PluginUiSurfaceContextV1;
    hostApi?: PluginReactNativeHostApiV1;
}>;

export type PluginReactNativeSurfaceModule = Readonly<{
    renderSurface: (
        context: PluginReactNativeSurfaceRenderContext | PluginUiRenderContext,
    ) => React.ReactElement | null;
    acknowledgeHostRuntime?: (input: Readonly<{
        surfaceId: string;
        cacheKey?: string;
    }>) => void | Promise<void>;
}>;

export type PluginReactNativeCrashDisableEvent = Readonly<{
    surfaceId: string;
    cacheKey: string;
    cacheIdentity: PluginReactNativeBundleCacheIdentity;
    disabledReason: DaemonPluginReactNativeCrashReportReasonV1;
    crashCount: number;
    startupFailureCount: number;
}>;

function isPluginReactNativeSurfaceModule(value: unknown): value is PluginReactNativeSurfaceModule {
    return Boolean(value)
        && typeof value === 'object'
        && typeof (value as { renderSurface?: unknown }).renderSurface === 'function';
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
    snapshotTitle?: string;
    surface?: PluginUiSurfaceContextV1;
    decision: PluginReactNativeCompatibilityDecision;
    module?: PluginReactNativeSurfaceModule | null;
    load?: () => PluginReactNativeSurfaceModule | Promise<PluginReactNativeSurfaceModule>;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    cacheIdentity?: PluginReactNativeBundleCacheIdentity | null;
    hostApi?: PluginReactNativeHostApiV1 | null;
    renderContext?: PluginUiRenderContext;
    interactionEnabled?: boolean;
    loadTimeoutMs?: number;
    onCrash?: (surfaceId: string, error: Error) => void;
    onCrashDisable?: (event: PluginReactNativeCrashDisableEvent) => void | Promise<void>;
    watchdog?: PluginReactNativeWatchdog;
}>;

type LoadedPluginReactNativeModuleState = Readonly<{
    cacheKey: string | undefined;
    module: PluginReactNativeSurfaceModule | null;
}>;

type PluginReactNativeAcknowledgmentAttempt = Readonly<{
    ackKey: string;
    module: PluginReactNativeSurfaceModule;
    token: number;
}>;

const DEFAULT_LOAD_TIMEOUT_MS = 5000;
const DEFAULT_WATCHDOG_CRASH_THRESHOLD = 2;
const loadedModuleRegistry = getInstalledPluginReactNativeModuleRegistry();
const defaultWatchdog = createPluginReactNativeWatchdog({
    ackTimeoutMs: DEFAULT_LOAD_TIMEOUT_MS,
    crashThreshold: DEFAULT_WATCHDOG_CRASH_THRESHOLD,
    nowMs: Date.now,
    persistence: createDefaultPluginReactNativeWatchdogPersistence(),
});

type PluginReactNativeSurfaceRendererProps = Readonly<{
    module: PluginReactNativeSurfaceModule;
    renderContext: PluginReactNativeSurfaceRenderContext | PluginUiRenderContext;
    onRendered: (module: PluginReactNativeSurfaceModule) => void;
}>;

function PluginReactNativeSurfaceRenderer({
    module,
    onRendered,
    renderContext,
}: PluginReactNativeSurfaceRendererProps): React.ReactElement | null {
    const element = React.useMemo(
        () => module.renderSurface(renderContext),
        [module, renderContext],
    );
    React.useEffect(() => {
        onRendered(module);
    }, [module, onRendered]);
    return element;
}

function isPluginReactNativeHostApi(value: unknown): value is PluginReactNativeHostApiV1 {
    return Boolean(value)
        && typeof value === 'object'
        && Object.isFrozen(value)
        && (value as { version?: unknown }).version === PLUGIN_UI_HOST_API_VERSION_V1
        && typeof (value as { getSurfaceContext?: unknown }).getSurfaceContext === 'function'
        && typeof (value as { request?: unknown }).request === 'function'
        && typeof (value as { requestSessionResource?: unknown }).requestSessionResource === 'function'
        && typeof (value as { subscribeResource?: unknown }).subscribeResource === 'function'
        && typeof (value as { dispatchAction?: unknown }).dispatchAction === 'function'
        && typeof (value as { openSurface?: unknown }).openSurface === 'function'
        && typeof (value as { logDiagnostic?: unknown }).logDiagnostic === 'function'
        && typeof (value as { copy?: unknown }).copy === 'function'
        && typeof (value as { openExternal?: unknown }).openExternal === 'function';
}

function isCanonicalPluginUiRenderContext(value: unknown): value is PluginUiRenderContext {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
    const context = value as Partial<PluginUiRenderContext>;
    const hostApi = context.hostApi as Partial<PluginUiRenderContext['hostApi']> | undefined;
    return Boolean(context.plugin?.id)
        && Boolean(context.plugin?.version)
        && Boolean(context.view?.id)
        && Boolean(context.view?.placement)
        && Boolean(context.surface)
        && context.signal instanceof AbortSignal
        && Boolean(hostApi)
        && typeof hostApi?.version === 'function'
        && typeof hostApi?.context === 'function'
        && typeof hostApi?.watchContext === 'function'
        && typeof hostApi?.executeAction === 'function'
        && typeof hostApi?.readResource === 'function'
        && typeof hostApi?.watchResource === 'function'
        && typeof hostApi?.openSurface === 'function'
        && typeof hostApi?.diagnostic === 'function'
        && typeof hostApi?.readClipboard === 'function'
        && typeof hostApi?.writeClipboard === 'function'
        && typeof hostApi?.openExternalLink === 'function';
}

export function PluginReactNativeSurface(props: PluginReactNativeSurfaceProps): React.ReactElement {
    const [loadedModuleState, setLoadedModuleState] = React.useState<LoadedPluginReactNativeModuleState>(() => ({
        cacheKey: props.cacheKey,
        module: loadedModuleRegistry.read(props.cacheKey),
    }));
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [loadFailureDiagnostics, setLoadFailureDiagnostics] = React.useState<readonly string[]>([]);
    const [, refreshWatchdogState] = React.useReducer((value: number) => value + 1, 0);
    const acknowledgmentTokenRef = React.useRef(0);
    const acknowledgedModuleRef = React.useRef<PluginReactNativeAcknowledgmentAttempt | null>(null);
    const reportedCrashDisableKeysRef = React.useRef(new Set<string>());
    const acknowledgmentTimeoutsRef = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const loadPolicy = props.load && !props.loadPolicy
        ? Object.freeze({
            canLoad: false,
            diagnostics: Object.freeze(['authoritative_load_policy_missing']),
        })
        : resolvePluginReactNativeLoaderPolicy(props.loadPolicy);
    const watchdog = props.watchdog ?? defaultWatchdog;
    const watchdogCacheKey = props.cacheKey ?? props.surfaceId;
    const watchdogState = watchdog.readState(props.surfaceId);
    const watchdogDisabled = watchdogState?.cacheKey === watchdogCacheKey && watchdogState.disabled === true;
    const reportCrashDisable = React.useCallback((
        state: PluginReactNativeWatchdogState,
        disabledReason: DaemonPluginReactNativeCrashReportReasonV1,
    ) => {
        const cacheIdentity = props.cacheIdentity;
        const report = props.onCrashDisable;
        if (!state.disabled || state.cacheKey !== watchdogCacheKey || !cacheIdentity || !report) {
            return;
        }
        const reportKey = [
            state.surfaceId,
            state.cacheKey,
            disabledReason,
            state.crashCount,
            state.startupFailureCount,
        ].join(':');
        if (reportedCrashDisableKeysRef.current.has(reportKey)) {
            return;
        }
        reportedCrashDisableKeysRef.current.add(reportKey);
        try {
            const result = report({
                surfaceId: state.surfaceId,
                cacheKey: state.cacheKey,
                cacheIdentity,
                disabledReason,
                crashCount: state.crashCount,
                startupFailureCount: state.startupFailureCount,
            });
            if (result && typeof (result as PromiseLike<void>).then === 'function') {
                void Promise.resolve(result).catch(() => undefined);
            }
        } catch {
            // Crash containment remains local even when the daemon report path is unavailable.
        }
    }, [props.cacheIdentity, props.onCrashDisable, watchdogCacheKey]);

    const clearAcknowledgmentTimeouts = React.useCallback(() => {
        for (const timeout of acknowledgmentTimeoutsRef.current.values()) {
            clearTimeout(timeout);
        }
        acknowledgmentTimeoutsRef.current.clear();
    }, []);

    React.useLayoutEffect(() => {
        acknowledgmentTokenRef.current += 1;
        acknowledgedModuleRef.current = null;
        setLoadFailed(false);
        setLoadFailureDiagnostics([]);

        return () => {
            clearAcknowledgmentTimeouts();
            watchdog.cancel({
                surfaceId: props.surfaceId,
                cacheKey: watchdogCacheKey,
            });
            acknowledgmentTokenRef.current += 1;
            acknowledgedModuleRef.current = null;
        };
    }, [clearAcknowledgmentTimeouts, props.surfaceId, watchdog, watchdogCacheKey]);

    React.useEffect(() => {
        if (props.decision.state !== 'load' || props.module || !props.load || !loadPolicy.canLoad || watchdogDisabled) {
            return undefined;
        }

        let cancelled = false;
        let timedOut = false;
        watchdog.start({
            surfaceId: props.surfaceId,
            cacheKey: watchdogCacheKey,
        });
        const timeout = setTimeout(() => {
            if (!cancelled) {
                timedOut = true;
                const expired = watchdog.collectExpired();
                if (expired.some((entry) => entry.surfaceId === props.surfaceId && entry.cacheKey === watchdogCacheKey)) {
                    const state = watchdog.readState(props.surfaceId);
                    if (state) {
                        reportCrashDisable(state, 'startup_ack_timeout_threshold');
                    }
                }
                refreshWatchdogState();
                setLoadFailed(true);
            }
        }, props.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);

        Promise.resolve()
            .then(() => props.load?.())
            .then((nextModule) => {
                if (!cancelled && !timedOut && isPluginReactNativeSurfaceModule(nextModule)) {
                    clearTimeout(timeout);
                    loadedModuleRegistry.write(props.cacheKey, nextModule);
                    setLoadFailureDiagnostics([]);
                    setLoadedModuleState({
                        cacheKey: props.cacheKey,
                        module: nextModule,
                    });
                } else if (!cancelled && !timedOut) {
                    clearTimeout(timeout);
                    watchdog.cancel({
                        surfaceId: props.surfaceId,
                        cacheKey: watchdogCacheKey,
                    });
                    setLoadFailureDiagnostics(['invalid_surface_module']);
                    setLoadFailed(true);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled && !timedOut) {
                    clearTimeout(timeout);
                    watchdog.cancel({
                        surfaceId: props.surfaceId,
                        cacheKey: watchdogCacheKey,
                    });
                    setLoadFailureDiagnostics(readLoaderErrorDiagnostics(error));
                    setLoadFailed(true);
                }
            });

        return () => {
            cancelled = true;
            clearTimeout(timeout);
            watchdog.cancel({
                surfaceId: props.surfaceId,
                cacheKey: watchdogCacheKey,
            });
        };
    }, [
        loadPolicy.canLoad,
        props.cacheKey,
        props.decision.state,
        props.load,
        props.loadTimeoutMs,
        props.module,
        reportCrashDisable,
        props.surfaceId,
        watchdog,
        watchdogCacheKey,
        watchdogDisabled,
    ]);

    const acknowledgeRenderedModule = React.useCallback((module: PluginReactNativeSurfaceModule) => {
        if (props.decision.state !== 'load' || !loadPolicy.canLoad || watchdogDisabled) {
            return;
        }
        const ackKey = `${props.surfaceId}:${props.cacheKey ?? ''}`;
        const currentAttempt = acknowledgedModuleRef.current;
        if (currentAttempt?.ackKey === ackKey && currentAttempt.module === module) {
            return;
        }
        const token = acknowledgmentTokenRef.current + 1;
        acknowledgmentTokenRef.current = token;
        acknowledgedModuleRef.current = Object.freeze({ ackKey, module, token });
        const previousTimeout = acknowledgmentTimeoutsRef.current.get(ackKey);
        if (previousTimeout !== undefined) {
            clearTimeout(previousTimeout);
            acknowledgmentTimeoutsRef.current.delete(ackKey);
        }
        watchdog.cancel({
            surfaceId: props.surfaceId,
            cacheKey: watchdogCacheKey,
        });
        watchdog.start({
            surfaceId: props.surfaceId,
            cacheKey: watchdogCacheKey,
        });
        const timeout = setTimeout(() => {
            if (
                acknowledgmentTimeoutsRef.current.get(ackKey) !== timeout
                || acknowledgedModuleRef.current?.token !== token
            ) {
                return;
            }
            acknowledgmentTimeoutsRef.current.delete(ackKey);
            const expired = watchdog.collectExpired();
            if (expired.some((entry) => entry.surfaceId === props.surfaceId && entry.cacheKey === watchdogCacheKey)) {
                const state = watchdog.readState(props.surfaceId);
                if (state) {
                    reportCrashDisable(state, 'startup_ack_timeout_threshold');
                }
            }
            refreshWatchdogState();
            setLoadFailed(true);
        }, props.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
        acknowledgmentTimeoutsRef.current.set(ackKey, timeout);

        const completeAcknowledgment = () => {
            if (
                acknowledgmentTimeoutsRef.current.get(ackKey) !== timeout
                || acknowledgedModuleRef.current?.token !== token
            ) {
                return;
            }
            clearTimeout(timeout);
            acknowledgmentTimeoutsRef.current.delete(ackKey);
            if (watchdog.readState(props.surfaceId)?.disabled === true) {
                refreshWatchdogState();
                setLoadFailed(true);
                return;
            }
            watchdog.acknowledge({ surfaceId: props.surfaceId });
            refreshWatchdogState();
        };

        try {
            if (typeof module.acknowledgeHostRuntime !== 'function') {
                return;
            }
            const result = module.acknowledgeHostRuntime({
                surfaceId: props.surfaceId,
                ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
            });
            if (result && typeof (result as PromiseLike<void>).then === 'function') {
                void Promise.resolve(result).then(
                    completeAcknowledgment,
                    () => undefined,
                );
            } else {
                completeAcknowledgment();
            }
        } catch {
            // Keep the startup acknowledgment pending so the watchdog records a no-ack timeout.
        }
    }, [
        loadPolicy.canLoad,
        props.cacheKey,
        props.decision.state,
        props.loadTimeoutMs,
        reportCrashDisable,
        props.surfaceId,
        watchdog,
        watchdogCacheKey,
        watchdogDisabled,
    ]);

    const handleCrash = React.useCallback((surfaceId: string, error: Error) => {
        const state = watchdog.recordRenderError({
            surfaceId,
            cacheKey: watchdogCacheKey,
        });
        reportCrashDisable(state, 'render_error_threshold');
        refreshWatchdogState();
        props.onCrash?.(surfaceId, error);
    }, [props.onCrash, reportCrashDisable, watchdog, watchdogCacheKey]);
    const renderHostApi = isPluginReactNativeHostApi(props.hostApi) ? props.hostApi : undefined;
    const legacyRenderContext = React.useMemo(() => createPluginReactNativeSurfaceRenderContext({
        surface: props.surface,
        ...(renderHostApi ? { hostApi: renderHostApi } : {}),
    }), [renderHostApi, props.surface]);
    const currentRenderContext = isCanonicalPluginUiRenderContext(props.renderContext)
        ? props.renderContext
        : legacyRenderContext;
    const interactionEnabled = props.interactionEnabled ?? Boolean(renderHostApi || props.renderContext);
    const lastInteractiveRenderContextRef = React.useRef<
        PluginReactNativeSurfaceRenderContext | PluginUiRenderContext
    >(currentRenderContext);
    React.useLayoutEffect(() => {
        if (interactionEnabled) {
            lastInteractiveRenderContextRef.current = currentRenderContext;
        }
    }, [currentRenderContext, interactionEnabled]);
    const renderContext = interactionEnabled
        ? currentRenderContext
        : lastInteractiveRenderContextRef.current;

    const unavailableDiagnostics = Object.freeze([
        ...props.decision.diagnostics,
        ...loadPolicy.diagnostics,
        ...loadFailureDiagnostics,
        ...(watchdogDisabled ? ['crash_threshold_reached'] : []),
    ]);

    if (props.decision.state !== 'load' || loadFailed || !loadPolicy.canLoad || watchdogDisabled) {
        return <PluginReactNativeUnavailable diagnostics={unavailableDiagnostics} />;
    }

    const loadedModule = loadedModuleState.cacheKey === props.cacheKey
        ? loadedModuleState.module
        : loadedModuleRegistry.read(props.cacheKey);
    const module = isPluginReactNativeSurfaceModule(props.module) ? props.module : loadedModule;
    if (!module) {
        return <PluginReactNativeUnavailable diagnostics={unavailableDiagnostics} />;
    }

    return (
        <PluginUiBoundary surfaceId={props.surfaceId} resetKey={watchdogCacheKey} onCrash={handleCrash}>
            <PluginSurfaceInteractionBoundary
                surfaceId={props.surfaceId}
                snapshotTitle={props.snapshotTitle ?? props.surface?.contributionId ?? props.surfaceId}
                enabled={interactionEnabled}
            >
                <PluginReactNativeSurfaceRenderer
                    module={module}
                    renderContext={renderContext}
                    onRendered={acknowledgeRenderedModule}
                />
            </PluginSurfaceInteractionBoundary>
        </PluginUiBoundary>
    );
}
