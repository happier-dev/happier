import * as React from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    isSameDaemonPluginReactNativeCrashBindingV1,
    type DaemonPluginReactNativeCrashBindingTokenV1,
    type DaemonPluginReactNativeCrashFailureV1,
} from '@happier-dev/protocol';

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
import { getInstalledPluginReactNativeModuleRegistry } from './moduleRegistry';
import {
    PluginReactNativeUnavailable,
    type PluginReactNativeUnavailableResetStatus,
} from './PluginReactNativeUnavailable';
import { PluginUiBoundary } from './PluginUiBoundary';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import {
    logPluginSurfaceDiagnostic,
    readPluginSurfaceDiagnosticError,
} from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    createPluginReactNativeWatchdog,
    type PluginReactNativePendingFailure,
    type PluginReactNativeWatchdog,
} from './watchdog';
import { createDefaultPluginReactNativeWatchdogPersistence } from './watchdogPersistence';
import type { ReactNativeCrashReportResult } from '@/sync/domains/plugins/ui/reactNativeCrashReports';

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
    /** Host-selected Composer mount ref for the cooperative carrier; never part of RenderContext. */
    composerRef?: unknown;
    presentationHost?: unknown;
    dataClient?: unknown;
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
    loadTimeoutMs?: number;
    /** Targeted caller fallback, consumed only for a contributor render crash. */
    targetedFallback?: React.ReactNode;
    onCrash?: (surfaceId: string, error: Error) => void;
    watchdog?: PluginReactNativeWatchdog;
    /** Daemon-issued binding/epoch fact for the current executable artifact. */
    crashStateToken?: DaemonPluginReactNativeCrashBindingTokenV1;
    /** Exact current server/machine/Account target for local pending quarantine. */
    crashReportScopeKey?: string;
    /** Daemon-owned disabled fact for that exact binding/epoch. */
    crashStateDisabled?: boolean;
    /**
     * Whether the projection carrying `crashStateDisabled` is the daemon's
     * current truth rather than a retained offline snapshot. Absent means the
     * host does not track projection currentness for this mount, which is read
     * as current so an untracking host keeps its existing behavior.
     */
    crashStateProjectionCurrent?: boolean;
    /** The surface reports only its already-durable UI pending occurrence. */
    reportFailure?: (failure: PluginReactNativePendingFailure) => Promise<ReactNativeCrashReportResult>;
    /** Explicit same-digest recovery remains a daemon operation. */
    resetCrashState?: () => Promise<ReactNativeCrashReportResult>;
}>;

type LoadedPluginReactNativeModuleState = Readonly<{
    cacheKey: string | undefined;
    loadPolicySource: PluginReactNativeLoaderPolicyInput['source'] | null;
    module: PluginReactNativeSurfaceModule | null;
}>;

function readCrashStateTokenMountIdentity(
    token: DaemonPluginReactNativeCrashBindingTokenV1 | undefined,
): string | undefined {
    if (!token) return undefined;
    const mount = token.mount;
    switch (mount.kind) {
        case 'destination':
            return ['destination', mount.destination.pluginId, mount.destination.localId].join('\u0000');
        case 'targetedSurface':
            return [
                'targetedSurface',
                mount.target.pluginId,
                mount.target.immutableGenerationId,
                mount.point.pointId,
                mount.point.protocol.id,
                mount.point.protocol.version,
                mount.contributor.pluginId,
                mount.contributor.contributionId,
                mount.contributor.immutableGenerationId,
                mount.role,
                mount.presentation,
            ].join('\u0000');
        case 'composer':
            return [
                'composer',
                mount.contribution.pluginId,
                mount.contribution.localId,
                mount.immutableGenerationId,
                mount.role,
            ].join('\u0000');
    }
}

/**
 * Diagnostics describe the mount category, not the raw binding identity. The
 * exact target/generation identity remains daemon-owned and is not useful in
 * the concise unavailable-surface card.
 */
function readCrashStateTokenMountDiagnosticKind(
    token: DaemonPluginReactNativeCrashBindingTokenV1 | undefined,
): 'destination' | 'targeted_surface' | 'composer' | null {
    if (!token) return null;
    switch (token.mount.kind) {
        case 'destination':
            return 'destination';
        case 'targetedSurface':
            return 'targeted_surface';
        case 'composer':
            return 'composer';
    }
}

function readCrashStateTokenLifecycleVersion(
    token: DaemonPluginReactNativeCrashBindingTokenV1 | undefined,
    crashReportScopeKey: string | undefined,
): string {
    if (!token) return crashReportScopeKey ?? '';
    return [
        readCrashStateTokenMountIdentity(token),
        token.renderer.pluginId,
        token.renderer.localId,
        token.artifactDigest,
        token.crashStateEpoch,
        crashReportScopeKey ?? '',
    ].join('\u0000');
}

function isExpectedCrashResetProjection(
    requested: DaemonPluginReactNativeCrashBindingTokenV1,
    received: DaemonPluginReactNativeCrashBindingTokenV1,
): boolean {
    return isSameDaemonPluginReactNativeCrashBindingV1(requested, received)
        && requested.artifactDigest === received.artifactDigest
        && received.crashStateEpoch === requested.crashStateEpoch + 1;
}

type PluginReactNativeCrashResetStatus =
    | 'idle'
    | 'reset_requested'
    | 'reset_failed'
    | 'awaiting_new_projection'
    | 'reset_complete';

type PluginReactNativeCrashResetFailure =
    | Extract<ReactNativeCrashReportResult, { ok: false }>['reason']
    | 'binding_token_mismatch'
    /** The daemon accepted reset, but no new current projection arrived in the existing load budget. */
    | 'projection_timeout';

type PluginReactNativeCrashResetFeedback = Readonly<{
    status: PluginReactNativeCrashResetStatus;
    attempts: number;
    failure: PluginReactNativeCrashResetFailure | null;
    result: 'not_requested' | 'request_pending' | 'failed' | 'accepted' | 'projection_current';
    requestedToken: DaemonPluginReactNativeCrashBindingTokenV1 | null;
    requestedScopeKey: string | null;
}>;

type PluginReactNativeCrashResetDiagnosticFacts = Readonly<{
    status: PluginReactNativeCrashResetStatus;
    plugin: string | null;
    renderer: string | null;
    mount: string | null;
    contributor: string | null;
    failure: PluginReactNativeCrashResetFailure | null;
    disabled: boolean;
    epoch: number | null;
    result: PluginReactNativeCrashResetFeedback['result'];
}>;

const MAX_CRASH_RESET_DIAGNOSTIC_FIELD_CODE_POINTS = 256;
// Match the existing passive recovery-toast window. This is presentation-only:
// daemon projection remains the completion authority.
const RESET_COMPLETE_TOAST_HIDE_DELAY_MS = 4000;
const INITIAL_CRASH_RESET_FEEDBACK: PluginReactNativeCrashResetFeedback = Object.freeze({
    status: 'idle',
    attempts: 0,
    failure: null,
    result: 'not_requested',
    requestedToken: null,
    requestedScopeKey: null,
});

/**
 * The reset owner projects only finite identity/state facts into the incumbent
 * diagnostic testID channel. This deliberately excludes Error values, stacks,
 * provider descriptors, raw binding tokens, and arbitrary plugin data from UI
 * diagnostics.
 */
function projectCrashResetDiagnosticField(value: string | number | boolean | null): string {
    if (value === null) return 'none';
    const bounded = Array.from(String(value))
        .slice(0, MAX_CRASH_RESET_DIAGNOSTIC_FIELD_CODE_POINTS)
        .join('');
    return encodeURIComponent(bounded);
}

function projectCrashResetDiagnostic(
    facts: PluginReactNativeCrashResetDiagnosticFacts,
): string | null {
    if (facts.result === 'not_requested') return null;
    return `crash_reset_context:${[
        `status=${projectCrashResetDiagnosticField(facts.status)}`,
        `plugin=${projectCrashResetDiagnosticField(facts.plugin)}`,
        `renderer=${projectCrashResetDiagnosticField(facts.renderer)}`,
        `mount=${projectCrashResetDiagnosticField(facts.mount)}`,
        `contributor=${projectCrashResetDiagnosticField(facts.contributor)}`,
        `failure=${projectCrashResetDiagnosticField(facts.failure)}`,
        `disabled=${projectCrashResetDiagnosticField(facts.disabled)}`,
        `epoch=${projectCrashResetDiagnosticField(facts.epoch)}`,
        `result=${projectCrashResetDiagnosticField(facts.result)}`,
    ].join(';')}`;
}

const DEFAULT_LOAD_TIMEOUT_MS = 5000;
const loadedModuleRegistry = getInstalledPluginReactNativeModuleRegistry();
let nextPluginReactNativeMountOwnerId = 0;
const defaultWatchdog = createPluginReactNativeWatchdog({
    persistence: createDefaultPluginReactNativeWatchdogPersistence(),
});

const resetFeedbackStyles = StyleSheet.create({
    surface: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
    },
    completionToast: {
        position: 'absolute',
        top: 12,
        left: 16,
        right: 16,
        alignItems: 'center',
        zIndex: 1,
    },
});

/**
 * A passive, non-blocking confirmation only after the daemon projects the
 * fresh epoch. It is deliberately not a second overlay, focus, or crash-state
 * owner; the parent controls its bounded lifetime with existing feedback.
 */
function PluginReactNativeResetCompleteToast(): React.ReactElement {
    const presentation = resolvePluginSurfaceStatePresentation({
        state: 'available',
        copyVariant: 'pluginReactNativeResetComplete',
    });
    const notice = presentation.contentNotice;
    if (!notice) {
        throw new Error('plugin_react_native_reset_complete_presentation_missing_notice');
    }
    const accessibilityLabel = `${notice.title}. ${notice.reason}`;

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;
        try {
            AccessibilityInfo.announceForAccessibility?.(accessibilityLabel);
        } catch {
            // Native announcements are best effort; the live region remains
            // available to the platform accessibility tree.
        }
    }, [accessibilityLabel]);

    return (
        <View
            testID="plugin-rn-ui-reset-complete"
            pointerEvents="none"
            accessibilityRole="text"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
            style={resetFeedbackStyles.completionToast}
        >
            <StatusPill
                variant="success"
                label={notice.title}
                labelVariant="phrase"
                accessibilityLabel={accessibilityLabel}
            />
        </View>
    );
}

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
const PLUGIN_UI_COOPERATIVE_HOST_PRIVATE_ENTRY_PROVIDER_KEY = Symbol.for(
    'happier.pluginUi.privateSurfaceEntryProvider.v1',
);

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
    if (bindings.composerRef !== undefined) {
        privateProviderProps.composerRef = bindings.composerRef;
    }
    if (bindings.presentationHost !== undefined) {
        privateProviderProps.presentationHost = bindings.presentationHost;
    }
    if (bindings.dataClient !== undefined) {
        privateProviderProps.dataClient = bindings.dataClient;
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
    return React.useMemo(
        () => installPluginUiPrivateHostBindings(element, privateHostBindings),
        [element, privateHostBindings],
    );
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
    if (!PluginUiTargetedContributionsV1Schema.safeParse(context.surface.targetedContributions).success) {
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
    // Only immutable installed artifacts participate in the process-global
    // module registry. Dev hot reload intentionally re-fetches every mount.
    const loadPolicySource = props.loadPolicy?.source ?? null;
    const reusesProcessGlobalModule = loadPolicySource === 'installedArtifact';
    const [mountOwnerId] = React.useState(() => {
        nextPluginReactNativeMountOwnerId += 1;
        return nextPluginReactNativeMountOwnerId;
    });
    const [loadedModuleState, setLoadedModuleState] = React.useState<LoadedPluginReactNativeModuleState>(() => ({
        cacheKey: props.cacheKey,
        loadPolicySource,
        module: reusesProcessGlobalModule ? loadedModuleRegistry.read(props.cacheKey) : null,
    }));
    const cachedModule = loadedModuleState.cacheKey === props.cacheKey
        && loadedModuleState.loadPolicySource === loadPolicySource
        ? loadedModuleState.module
        : reusesProcessGlobalModule
            ? loadedModuleRegistry.read(props.cacheKey)
            : null;
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [targetedFallbackMountAttemptId, setTargetedFallbackMountAttemptId] = React.useState<string | null>(null);
    const [loadFailureDiagnostics, setLoadFailureDiagnostics] = React.useState<readonly string[]>([]);
    const [retryGeneration, setRetryGeneration] = React.useState(0);
    const [retrying, setRetrying] = React.useState(false);
    const [watchdogRevision, refreshWatchdogState] = React.useReducer((value: number) => value + 1, 0);
    const [daemonReportedDisabled, setDaemonReportedDisabled] = React.useState(false);
    const loadPolicy = props.load && !props.loadPolicy
        ? Object.freeze({
            canLoad: false,
            diagnostics: Object.freeze(['authoritative_load_policy_missing']),
        })
        : resolvePluginReactNativeLoaderPolicy(props.loadPolicy);
    const watchdog = props.watchdog ?? defaultWatchdog;
    const crashReportScopeKey = props.crashReportScopeKey;
    const crashStateTokenMountIdentity = readCrashStateTokenMountIdentity(props.crashStateToken);
    // This lifecycle consumes the daemon token plus the existing host-selected
    // target scope. It does not create another crash authority: a new exact
    // binding, artifact, reset epoch, or Account/machine target must retire the
    // old boundary before its local quarantine can be consumed.
    const crashStateTokenLifecycleVersion = readCrashStateTokenLifecycleVersion(
        props.crashStateToken,
        crashReportScopeKey,
    );
    const [crashResetFeedback, setCrashResetFeedback] = React.useState<PluginReactNativeCrashResetFeedback>(
        INITIAL_CRASH_RESET_FEEDBACK,
    );
    const watchdogCacheKey = props.cacheKey ?? props.surfaceId;
    // This is process-local attempt bookkeeping only. The UI watchdog owns only
    // a token-qualified pending quarantine; the daemon owns containment.
    const mountAttemptId = React.useMemo(() => [
        'plugin-rn-mount',
        mountOwnerId,
        props.surfaceId,
        watchdogCacheKey,
        props.mountInstanceKey ?? '',
        crashStateTokenLifecycleVersion,
        crashReportScopeKey ?? '',
        retryGeneration,
    ].join('\u0000'), [
        crashStateTokenLifecycleVersion,
        mountOwnerId,
        props.mountInstanceKey,
        props.surfaceId,
        retryGeneration,
        crashReportScopeKey,
        watchdogCacheKey,
    ]);
    const resetMountAttemptIdRef = React.useRef(mountAttemptId);
    const resetRequestSequenceRef = React.useRef(0);
    const currentCrashStateTokenLifecycleVersionRef = React.useRef(crashStateTokenLifecycleVersion);
    currentCrashStateTokenLifecycleVersionRef.current = crashStateTokenLifecycleVersion;
    const pendingFailures = props.crashStateToken && crashReportScopeKey
        ? watchdog.readPending({ token: props.crashStateToken, scopeKey: crashReportScopeKey })
        : Object.freeze([]);
    const pendingQuarantine = pendingFailures.length > 0;
    // A durable quarantine this UI cannot read or write is not an empty one.
    // While the local store cannot speak and the daemon projection behind this
    // binding is a retained offline snapshot rather than current truth, nothing
    // has cleared the cached artifact, so it stays contained. The daemon
    // remains the only owner of counts, thresholds, disablement and reset: its
    // current truth is exactly what releases the mount again.
    const unreconciledQuarantine = props.crashStateToken !== undefined
        && crashReportScopeKey !== undefined
        && watchdog.readDurability() === 'unavailable'
        && props.crashStateProjectionCurrent === false;
    const quarantineHeld = pendingQuarantine || unreconciledQuarantine;
    const crashDisabled = props.crashStateDisabled === true || daemonReportedDisabled;
    React.useLayoutEffect(() => {
        // A daemon-issued replacement/reset token is the only event that can
        // complete recovery. This effect keeps observer feedback current; it
        // neither clears durable daemon state nor creates a second reset owner.
        resetRequestSequenceRef.current += 1;
        setDaemonReportedDisabled(false);
        setCrashResetFeedback((previous) => {
            const currentToken = props.crashStateToken;
            if (
                previous.requestedToken
                && currentToken
                && previous.requestedScopeKey === (crashReportScopeKey ?? null)
                && props.crashStateDisabled !== true
                && isExpectedCrashResetProjection(previous.requestedToken, currentToken)
            ) {
                return Object.freeze({
                    ...previous,
                    status: 'reset_complete',
                    failure: null,
                    result: 'projection_current',
                });
            }
            return previous.status === 'idle'
                ? previous
                : INITIAL_CRASH_RESET_FEEDBACK;
        });
    }, [
        props.crashStateToken?.artifactDigest,
        props.crashStateToken?.crashStateEpoch,
        crashStateTokenMountIdentity,
        props.crashStateToken?.renderer.localId,
        props.crashStateToken?.renderer.pluginId,
        crashReportScopeKey,
    ]);

    React.useEffect(() => {
        // A daemon disable that arrives after a completed reset is a distinct
        // current incident. The durable owner still decides disabled state;
        // this only makes the explicit UI reset affordance available again.
        if (crashDisabled && crashResetFeedback.status === 'reset_complete') {
            setCrashResetFeedback(INITIAL_CRASH_RESET_FEEDBACK);
        }
    }, [crashDisabled, crashResetFeedback.status]);

    React.useEffect(() => {
        if (crashResetFeedback.status !== 'awaiting_new_projection') {
            return undefined;
        }
        // Reuse the existing mount/load deadline rather than introducing a
        // second watchdog. The reset response itself is not recovery: only a
        // fresh daemon projection for the same lifecycle can settle it.
        const requestSequence = resetRequestSequenceRef.current;
        const requestLifecycleVersion = crashStateTokenLifecycleVersion;
        const timeout = setTimeout(() => {
            if (
                resetRequestSequenceRef.current !== requestSequence
                || currentCrashStateTokenLifecycleVersionRef.current !== requestLifecycleVersion
            ) {
                return;
            }
            setCrashResetFeedback((previous) => {
                if (previous.status !== 'awaiting_new_projection') {
                    return previous;
                }
                return Object.freeze({
                    ...previous,
                    status: 'reset_failed',
                    failure: 'projection_timeout',
                    result: 'failed',
                });
            });
        }, props.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
        return () => clearTimeout(timeout);
    }, [
        crashResetFeedback.status,
        crashStateTokenLifecycleVersion,
        props.loadTimeoutMs,
    ]);

    React.useEffect(() => {
        if (crashResetFeedback.status !== 'reset_complete') {
            return undefined;
        }
        const completionLifecycleVersion = crashStateTokenLifecycleVersion;
        const timeout = setTimeout(() => {
            if (currentCrashStateTokenLifecycleVersionRef.current !== completionLifecycleVersion) {
                return;
            }
            setCrashResetFeedback((previous) => previous.status === 'reset_complete'
                ? INITIAL_CRASH_RESET_FEEDBACK
                : previous);
        }, RESET_COMPLETE_TOAST_HIDE_DELAY_MS);
        return () => clearTimeout(timeout);
    }, [crashResetFeedback.status, crashStateTokenLifecycleVersion]);

    React.useEffect(() => {
        const token = props.crashStateToken;
        const reportFailure = props.reportFailure;
        const scopeKey = crashReportScopeKey;
        if (!token || !reportFailure || !scopeKey) {
            return undefined;
        }
        const pending = watchdog.readPending({ token, scopeKey });
        if (pending.length === 0) {
            return undefined;
        }

        let cancelled = false;
        void (async () => {
            for (const failure of pending) {
                let result: ReactNativeCrashReportResult;
                try {
                    result = await reportFailure(failure);
                } catch {
                    return;
                }
                if (cancelled) {
                    return;
                }
                if (!result.ok) {
                    return;
                }
                watchdog.acknowledgeReportedFailure({
                    token: failure.token,
                    scopeKey,
                    failureOccurrenceId: failure.failureOccurrenceId,
                });
                if (result.disabled) {
                    setDaemonReportedDisabled(true);
                }
                refreshWatchdogState();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        props.crashStateToken?.artifactDigest,
        props.crashStateToken?.crashStateEpoch,
        crashStateTokenMountIdentity,
        props.crashStateToken?.renderer.localId,
        props.crashStateToken?.renderer.pluginId,
        crashReportScopeKey,
        props.reportFailure,
        watchdog,
        watchdogRevision,
    ]);

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
    }, [crashStateTokenLifecycleVersion, props.mountInstanceKey, props.surfaceId, watchdogCacheKey]);

    const recordDaemonCrashFailure = React.useCallback((
        failure: DaemonPluginReactNativeCrashFailureV1,
        error?: unknown,
    ) => {
        // Attribution first, and deliberately outside the daemon-token gate
        // below: a surface that fails before the daemon has issued a crash
        // binding is exactly the case that used to name nothing anywhere.
        logPluginSurfaceDiagnostic(
            {
                pluginId: props.crashStateToken?.renderer.pluginId
                    ?? readRenderContextPluginId(props.renderContext),
                contributionId: props.crashStateToken?.renderer.localId ?? null,
                surfaceId: props.surfaceId,
            },
            {
                surfaceFailure: failure,
                error: readPluginSurfaceDiagnosticError(error),
            },
        );
        if (props.crashStateToken && crashReportScopeKey) {
            watchdog.recordFailure({
                token: props.crashStateToken,
                scopeKey: crashReportScopeKey,
                failure,
            });
        }
        refreshWatchdogState();
    }, [
        crashReportScopeKey,
        props.crashStateToken,
        props.renderContext,
        props.surfaceId,
        watchdog,
    ]);

    React.useEffect(() => {
        if (
            props.decision.state !== 'load'
            || props.module
            || !props.load
            || !loadPolicy.canLoad
            || cachedModule !== null
            || quarantineHeld
            || crashDisabled
        ) {
            return undefined;
        }

        let cancelled = false;
        let timedOut = false;
        // The registry—not this consumer—owns active projection currentness.
        // Capture its key-local admission before the loader can settle.
        const moduleWriteFence = reusesProcessGlobalModule
            ? loadedModuleRegistry.captureWriteFence(props.cacheKey)
            : null;
        const timeout = setTimeout(() => {
            if (!cancelled) {
                timedOut = true;
                recordDaemonCrashFailure('load_timeout');
                setLoadFailureDiagnostics(['load_timeout']);
                setLoadFailed(true);
                setRetrying(false);
            }
        }, props.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);

        Promise.resolve()
            .then(() => props.load?.())
            .then((nextModule) => {
                if (!cancelled && !timedOut && isPluginReactNativeSurfaceModule(nextModule)) {
                    clearTimeout(timeout);
                    if (moduleWriteFence) {
                        loadedModuleRegistry.write(props.cacheKey, nextModule, moduleWriteFence);
                    }
                    setLoadFailureDiagnostics([]);
                    setLoadedModuleState({
                        cacheKey: props.cacheKey,
                        loadPolicySource,
                        module: nextModule,
                    });
                    setRetrying(false);
                } else if (!cancelled && !timedOut) {
                    clearTimeout(timeout);
                    recordDaemonCrashFailure('invalid_surface_module');
                    setLoadFailureDiagnostics(['invalid_surface_module']);
                    setLoadFailed(true);
                    setRetrying(false);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled && !timedOut) {
                    clearTimeout(timeout);
                    recordDaemonCrashFailure('load_error', error);
                    setLoadFailureDiagnostics(readLoaderErrorDiagnostics(error));
                    setLoadFailed(true);
                    setRetrying(false);
                }
            });

        return () => {
            cancelled = true;
            clearTimeout(timeout);
        };
    }, [
        loadPolicy.canLoad,
        mountAttemptId,
        cachedModule,
        loadPolicySource,
        props.cacheKey,
        props.decision.state,
        props.load,
        props.loadTimeoutMs,
        props.module,
        recordDaemonCrashFailure,
        reusesProcessGlobalModule,
        quarantineHeld,
        crashDisabled,
    ]);

    const retryCurrentMountLocalFailure = React.useCallback(() => {
        // Durable crash containment is never cleared by a Retry; a new current
        // artifact owns restoration.
        setLoadedModuleState({
            cacheKey: props.cacheKey,
            loadPolicySource,
            module: null,
        });
        setLoadFailureDiagnostics([]);
        setLoadFailed(false);
        setRetrying(true);
        setRetryGeneration((generation) => generation + 1);
        refreshWatchdogState();
    }, [
        loadPolicySource,
        props.cacheKey,
    ]);

    const handleRetry = React.useCallback(() => {
        if (retrying || quarantineHeld || crashDisabled) {
            return;
        }
        retryCurrentMountLocalFailure();
    }, [crashDisabled, quarantineHeld, retryCurrentMountLocalFailure, retrying]);

    const handleCrash = React.useCallback((surfaceId: string, error: Error) => {
        recordDaemonCrashFailure('render_error', error);
        if (props.targetedFallback !== undefined) {
            setTargetedFallbackMountAttemptId(mountAttemptId);
        }
        setLoadFailed(true);
        setRetrying(false);
        props.onCrash?.(surfaceId, error);
    }, [mountAttemptId, props.onCrash, props.targetedFallback, recordDaemonCrashFailure]);

    const handleResetCrashState = React.useCallback(() => {
        const currentToken = props.crashStateToken;
        const canRequestReset = crashResetFeedback.status === 'idle'
            || crashResetFeedback.status === 'reset_failed';
        if (!props.resetCrashState || !currentToken || !canRequestReset) {
            return;
        }
        const requestSequence = resetRequestSequenceRef.current + 1;
        const requestLifecycleVersion = crashStateTokenLifecycleVersion;
        const requestScopeKey = crashReportScopeKey ?? null;
        const attempts = crashResetFeedback.attempts + 1;
        resetRequestSequenceRef.current = requestSequence;
        setCrashResetFeedback(Object.freeze({
            status: 'reset_requested',
            attempts,
            failure: null,
            result: 'request_pending',
            requestedToken: currentToken,
            requestedScopeKey: requestScopeKey,
        }));
        const reportResetRequestFailure = () => {
            if (
                resetRequestSequenceRef.current !== requestSequence
                || currentCrashStateTokenLifecycleVersionRef.current !== requestLifecycleVersion
            ) {
                return;
            }
            setCrashResetFeedback(Object.freeze({
                status: 'reset_failed',
                attempts,
                failure: 'request_failed',
                result: 'failed',
                requestedToken: currentToken,
                requestedScopeKey: requestScopeKey,
            }));
        };
        let resetRequest: Promise<ReactNativeCrashReportResult>;
        try {
            resetRequest = props.resetCrashState();
        } catch {
            reportResetRequestFailure();
            return;
        }
        void resetRequest
            .then((result) => {
                if (
                    resetRequestSequenceRef.current !== requestSequence
                    || currentCrashStateTokenLifecycleVersionRef.current !== requestLifecycleVersion
                ) {
                    return;
                }
                if (!result.ok) {
                    setCrashResetFeedback(Object.freeze({
                        status: 'reset_failed',
                        attempts,
                        failure: result.reason,
                        result: 'failed',
                        requestedToken: currentToken,
                        requestedScopeKey: requestScopeKey,
                    }));
                    return;
                }
                if (result.disabled || !isExpectedCrashResetProjection(currentToken, result.token)) {
                    setCrashResetFeedback(Object.freeze({
                        status: 'reset_failed',
                        attempts,
                        failure: 'binding_token_mismatch',
                        result: 'failed',
                        requestedToken: currentToken,
                        requestedScopeKey: requestScopeKey,
                    }));
                    return;
                }
                setCrashResetFeedback(Object.freeze({
                    status: 'awaiting_new_projection',
                    attempts,
                    failure: null,
                    result: 'accepted',
                    requestedToken: currentToken,
                    requestedScopeKey: requestScopeKey,
                }));
            })
            .catch(() => {
                reportResetRequestFailure();
            });
    }, [
        crashResetFeedback.attempts,
        crashResetFeedback.status,
        crashStateTokenLifecycleVersion,
        crashReportScopeKey,
        props.crashStateToken,
        props.resetCrashState,
    ]);
    const canonicalRenderContextDiagnostic = readCanonicalPluginUiRenderContextDiagnostic(props.renderContext);
    const currentRenderContext = props.renderContext;
    const interactionEnabled = props.interactionEnabled ?? true;
    // The retained offline tree is one mounted generation. Its public context
    // and its host-only entry bindings are therefore one pair: updating either
    // half while interaction is unavailable would combine an old controller
    // with a successor Resource/presentation scope.
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
    const privateHostBindings = renderState.privateHostBindings;
    // A replacement launch input is a new render request for the same mounted
    // contributor, not a new mount. Keep its stateful tree alive when healthy,
    // but let a targeted child retry after its caller gives it new input.
    const launchInputResetKey = renderContext.launchInput === undefined
        ? 'absent'
        : `present:${stableJsonStringify(renderContext.launchInput)}`;
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

    const crashResetFacts = Object.freeze({
        status: crashResetFeedback.status,
        plugin: props.crashStateToken?.renderer.pluginId ?? null,
        renderer: props.crashStateToken?.renderer.localId ?? null,
        mount: readCrashStateTokenMountDiagnosticKind(props.crashStateToken),
        contributor: props.crashStateToken?.mount.kind === 'targetedSurface'
            ? props.crashStateToken.mount.contributor.contributionId
            : null,
        failure: crashResetFeedback.failure,
        disabled: crashDisabled,
        epoch: props.crashStateToken?.crashStateEpoch ?? null,
        result: crashResetFeedback.result,
    });
    const crashResetDiagnostic = projectCrashResetDiagnostic(crashResetFacts);
    const unavailableDiagnostics = Object.freeze([
        ...(crashResetFacts.result === 'not_requested' ? [] : [crashResetFeedback.status]),
        ...(crashResetDiagnostic ? [crashResetDiagnostic] : []),
        ...props.decision.diagnostics,
        ...loadPolicy.diagnostics,
        ...loadFailureDiagnostics,
        ...(pendingQuarantine ? ['crash_reconciliation_pending'] : []),
        ...(unreconciledQuarantine ? ['crash_quarantine_truth_unavailable'] : []),
        ...(crashDisabled ? ['crash_threshold_reached'] : []),
        ...(canonicalRenderContextDiagnostic ? [canonicalRenderContextDiagnostic] : []),
    ]);
    const canRetryCurrentArtifact = props.decision.state === 'load'
        && loadPolicy.canLoad
        && (Boolean(props.load) || isPluginReactNativeSurfaceModule(props.module));
    const shouldOfferRetry = canRetryCurrentArtifact
        && loadFailed
        && !quarantineHeld
        && !crashDisabled;
    const shouldOfferCrashReset = crashDisabled
        && props.resetCrashState !== undefined
        && props.crashStateToken !== undefined
        && (
            crashResetFeedback.status === 'idle'
            || crashResetFeedback.status === 'reset_failed'
        );
    const unavailableResetStatus: PluginReactNativeUnavailableResetStatus | undefined = (
        crashResetFeedback.status === 'reset_requested'
        || crashResetFeedback.status === 'awaiting_new_projection'
        || crashResetFeedback.status === 'reset_failed'
    )
        ? crashResetFeedback.status
        : undefined;
    const animationEnabled = props.renderContext.surface.reducedMotion !== true;
    const hasCurrentTargetedFallback = props.targetedFallback !== undefined
        && targetedFallbackMountAttemptId === mountAttemptId;

    if (canonicalRenderContextDiagnostic) {
        return <PluginReactNativeUnavailable diagnostics={unavailableDiagnostics} />;
    }
    if (hasCurrentTargetedFallback) {
        return <>{props.targetedFallback}</>;
    }
    if (
        props.decision.state !== 'load'
        || loadFailed
        || !loadPolicy.canLoad
        || quarantineHeld
        || crashDisabled
    ) {
        return (
            <PluginReactNativeUnavailable
                diagnostics={unavailableDiagnostics}
                onRetry={shouldOfferRetry ? handleRetry : undefined}
                retrying={retrying}
                onReset={shouldOfferCrashReset ? handleResetCrashState : undefined}
                resetStatus={unavailableResetStatus}
                animationEnabled={animationEnabled}
            />
        );
    }

    const module = isPluginReactNativeSurfaceModule(props.module) ? props.module : cachedModule;
    if (!module) {
        return (
            <PluginReactNativeUnavailable
                diagnostics={unavailableDiagnostics}
                retrying={retrying}
                animationEnabled={animationEnabled}
            />
        );
    }

    return (
        <PluginUiBoundary
            key={mountAttemptId}
            surfaceId={props.surfaceId}
            resetKey={`${watchdogCacheKey}\u0000${launchInputResetKey}`}
            mountInstanceKey={props.mountInstanceKey}
            fallback={props.targetedFallback === undefined ? (
                <PluginReactNativeUnavailable
                    diagnostics={unavailableDiagnostics}
                    onRetry={shouldOfferRetry ? handleRetry : undefined}
                    retrying={retrying}
                    onReset={shouldOfferCrashReset ? handleResetCrashState : undefined}
                    resetStatus={unavailableResetStatus}
                    animationEnabled={animationEnabled}
                />
            ) : props.targetedFallback}
            onCrash={handleCrash}
        >
            <PluginSurfaceInteractionBoundary
                surfaceId={props.surfaceId}
                snapshotTitle={props.snapshotTitle ?? props.surfaceId}
                enabled={interactionEnabled}
                focusEligible={props.focusEligible}
            >
                <View style={resetFeedbackStyles.surface}>
                    <PluginReactNativeSurfaceRenderer
                        module={module}
                        renderContext={renderContext}
                        privateHostBindings={privateHostBindings}
                    />
                    {crashResetFeedback.status === 'reset_complete' ? (
                        <PluginReactNativeResetCompleteToast />
                    ) : null}
                </View>
            </PluginSurfaceInteractionBoundary>
        </PluginUiBoundary>
    );
}
