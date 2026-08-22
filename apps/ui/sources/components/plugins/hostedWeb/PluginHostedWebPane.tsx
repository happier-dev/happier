import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { NavigationContext, usePreventRemove } from '@react-navigation/native';
import {
    PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
    PluginHostedWebSecurityPolicyV1Schema,
    resolvePluginHostedWebNativeArtifactFrameOriginV1,
    type PluginHostedWebSecurityPolicyV1,
    PluginHostedWebBridgeEnvelopeV1,
    PluginUiChannelV1,
    type PluginUiHostMethodV1,
    type PluginUiHostApiWireIdentityV1,
    type PluginUiInstanceKeyV1,
    type PluginUiJsonValueV1,
    type PluginUiLaunchInputV1,
    type ComposerRefV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSubPathV1,
    PluginUiPlatformV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceTarget, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    canRenderPluginUiProjectionEntry,
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiHostedWebProjection,
    PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolveHostedWebRuntimeDiagnostics } from '@/sync/domains/plugins/ui/hostedWebRuntime';
import type { PluginUiArtifactAdoption } from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { BrowserFrameError } from '@/components/browser/frame/BrowserFrameError';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';
import { isLoopbackHostedWebUrl } from '@/components/browser/adapters/HostedPluginTargetSecurity';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    createPluginSurfaceContext,
    getPluginSurfaceTargetAuthorityKey,
    usePluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';

import { PluginHostedWebFrame } from './PluginHostedWebFrame';
import {
    PluginHostedWebUnavailable,
    readPluginHostedWebUnavailableDiagnosticCode,
    type PluginHostedWebUnavailableDiagnosticCode,
} from './PluginHostedWebUnavailable';
import type { PluginHostedWebSandboxPolicy } from './sandbox';
import {
    createPluginHostedWebHostApiBridgeHandler,
    type PluginHostedWebHostApiBridgeHandler,
    type PluginHostedWebCollectionUiQueryBridgeFactory,
    type PluginHostedWebHostApiRequestHandler,
    type PluginHostedWebHostMessageSink,
    type PluginHostedWebComposerSubscriptionPublisher,
} from '@/components/plugins/hostApi/hostedWebAdapter';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';

type PluginHostedWebPanePlatform = 'web' | 'ios' | 'android' | 'desktop';

/**
 * Read-only structural view of the selected Artifact handle's existing
 * revocation seam. The pane consumes this fact; it does not create an
 * Artifact, surface, Account, or bridge lifetime.
 */
type PluginHostedWebArtifactCurrentness = Readonly<{
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
}>;

/**
 * Presentation state for the already-admitted native Artifact frame. The
 * Artifact handle remains the currentness and lifetime owner; this merely
 * selects the established frame state presentation for its native events.
 */
type NativeArtifactFrameLoadState = 'loading' | 'ready' | Readonly<{
    kind: 'error';
    code: string;
}>;

// Renderer adoptions deliberately hide source-handle disposal. Keep that
// public view even when associating local presentation with its identity.
type NativeArtifactFrameHandle = Omit<PluginNativeArtifactResourceHandle, 'dispose'>;

type NativeArtifactFrameLoadStateForHandle = Readonly<{
    handle: NativeArtifactFrameHandle | null;
    state: NativeArtifactFrameLoadState;
}>;

type NativeArtifactHistoryStateForHandle = Readonly<{
    handle: NativeArtifactFrameHandle | null;
    canGoBack: boolean;
}>;

type RouteNavigationDispatch = Readonly<{
    dispatch?: (action: unknown) => void;
}>;

/**
 * Keeps route ownership with React Navigation. This child exists only while a
 * current iOS Artifact guest can navigate back; it neither owns a route nor
 * retains a route action after that guest declines the request.
 */
function NativeArtifactHistoryRouteBackGuard(props: Readonly<{
    active: boolean;
    requestGuestGoBack: () => boolean;
}>): React.ReactElement | null {
    const navigation = React.useContext(NavigationContext);
    // The physical hosted mount has already selected the exact platform in
    // `active`; checking ambient React Native Platform here creates a second
    // platform authority and can disagree with an injected/native renderer.
    if (!props.active || navigation == null) return null;
    return (
        <ActiveNativeArtifactHistoryRouteBackGuard
            navigation={navigation as RouteNavigationDispatch}
            requestGuestGoBack={props.requestGuestGoBack}
        />
    );
}

function ActiveNativeArtifactHistoryRouteBackGuard(props: Readonly<{
    navigation: RouteNavigationDispatch;
    requestGuestGoBack: () => boolean;
}>): null {
    const [pendingRouteAction, setPendingRouteAction] = React.useState<unknown | null>(null);
    const requestGuestGoBackRef = React.useRef(props.requestGuestGoBack);
    requestGuestGoBackRef.current = props.requestGuestGoBack;
    const handlePreventedRemove = React.useCallback((event: Readonly<{
        data: Readonly<{ action: unknown }>;
    }>) => {
        if (requestGuestGoBackRef.current()) return;
        setPendingRouteAction(event.data.action);
    }, []);
    usePreventRemove(pendingRouteAction === null, handlePreventedRemove);

    React.useEffect(() => {
        if (pendingRouteAction === null) return;
        // `usePreventRemove` sees disabled before this effect redispatches the
        // declined action, so route ownership resumes without recursive guard.
        setPendingRouteAction(null);
        props.navigation.dispatch?.(pendingRouteAction);
    }, [pendingRouteAction, props.navigation]);
    return null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readNativeArtifactLoadErrorCode(value: unknown): string {
    const code = readRecord(readRecord(value)?.nativeEvent)?.code;
    return typeof code === 'string' && code.length > 0
        ? code
        : 'hosted_web_artifact_load_failed';
}

function readEndpointUrl(value: string | null | undefined): URL | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null;
    }
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * RN-WEB-LOADER item 6: native blocks ANY loopback hostedWeb endpoint by
 * default (fail-closed trust-boundary stance — a native app rendering
 * arbitrary loopback content is a materially wider attack surface than a
 * browser tab doing the same). The ONE narrow relaxation: a contribution
 * that has ITSELF declared `security.mixedContent: 'devLoopbackOnly'` (the
 * pre-existing author opt-in `HostedPluginTargetSecurity.ts` already
 * recognizes downstream — this wires the pane-level check that runs BEFORE
 * it to stop pre-empting that opt-in), on the `development` channel, in a
 * dev build. All three must hold; missing any one keeps the endpoint
 * blocked exactly as before. This enables an on-device/simulator dev loop
 * for hostedWeb authoring without weakening the default posture for
 * production/store/internal-channel content or release builds.
 */
function canRenderHostedWebEndpoint(params: Readonly<{
    url: URL | null;
    platform: PluginHostedWebPanePlatform;
    security?: PluginHostedWebSecurityPolicyV1 | null;
    channel?: PluginUiChannelV1;
    isDevBuildOverride?: boolean;
}>): boolean {
    if (!params.url) {
        return false;
    }
    if (params.platform !== 'web' && isLoopbackHostedWebUrl(params.url.toString())) {
        if (!params.security || !isLocalTrustedDevLoopbackAllowed({
            security: params.security,
            channel: params.channel,
            isDevBuildOverride: params.isDevBuildOverride,
        })) {
            return false;
        }
    }
    return true;
}

function resolvePlatform(platform: PluginHostedWebPanePlatform | undefined): PluginHostedWebPanePlatform {
    if (platform) {
        return platform;
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
        return Platform.OS;
    }
    return 'web';
}

function readOptionalBoolean(value: unknown): boolean {
    return value === true;
}

function readSandboxPolicy(value: unknown): PluginHostedWebSandboxPolicy | null {
    const record = readRecord(value);
    if (!record) {
        return null;
    }
    return {
        scripts: readOptionalBoolean(record.scripts),
        sameOrigin: readOptionalBoolean(record.sameOrigin),
        popups: readOptionalBoolean(record.popups),
        topNavigation: readOptionalBoolean(record.topNavigation),
        mixedContent: readOptionalBoolean(record.mixedContent),
    };
}

function readSecurityPolicy(value: unknown): PluginHostedWebSecurityPolicyV1 | null {
    const result = PluginHostedWebSecurityPolicyV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readServiceKind(value: unknown): string | null {
    const kind = readRecord(value)?.kind;
    return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

function readAllowedMessageKinds(value: unknown): readonly string[] {
    const allowedMessages = readRecord(value)?.allowedMessages;
    if (!Array.isArray(allowedMessages)) {
        return [];
    }
    return allowedMessages.filter((kind): kind is string => typeof kind === 'string' && kind.length > 0);
}

function canRenderProjectedHostedWebRuntime(
    value: unknown,
    hasExactEndpoint: boolean,
): boolean {
    const runtime = readRecord(value);
    if (runtime?.state === 'available') {
        return true;
    }

    // The Registry truthfully reports that web/desktop installed Artifact
    // bytes have no packaged-frame adapter. A native opaque Artifact handle
    // is the separate exact native-frame source; a legacy daemon Session
    // preview has its own produced HTTP(S) endpoint. Other projection
    // fallbacks (feature, policy, integrity, currentness) remain terminal and
    // cannot be bypassed by an address.
    return hasExactEndpoint
        && readRecord(runtime?.decision)?.reason === 'hosted_web_frame_adapter_unavailable';
}

function isDevBuild(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/**
 * RN-WEB-LOADER item 6 — the ONE predicate for the native dev-loopback
 * relaxation, shared by both gates that need it
 * (`isRestrictiveHostedWebSecurityPolicy` and `canRenderHostedWebEndpoint`)
 * so the three-part condition is never duplicated/drifted. A contribution's
 * OWN declared `security.mixedContent: 'devLoopbackOnly'`, on the
 * `development` channel, in a dev build — all three must hold.
 */
function isLocalTrustedDevLoopbackAllowed(params: Readonly<{
    security: PluginHostedWebSecurityPolicyV1;
    channel?: PluginUiChannelV1;
    isDevBuildOverride?: boolean;
}>): boolean {
    return params.security.mixedContent === 'devLoopbackOnly'
        && params.channel === 'development'
        && (params.isDevBuildOverride ?? isDevBuild());
}

function isRestrictiveHostedWebSecurityPolicy(
    security: PluginHostedWebSecurityPolicyV1,
    allowDevLoopbackMixedContent: boolean,
): boolean {
    return security.allowedNavigationOrigins.length === 0
        && security.allowedCallbackOrigins.length === 0
        && security.allowedConnectOrigins.length === 0
        && security.sourceMaps === 'disabled'
        && (security.mixedContent === 'deny' || allowDevLoopbackMixedContent)
        && security.csp.scriptSrc === 'selfOnly'
        && security.csp.styleSrc === 'selfOnly'
        && security.csp.imgSrc === 'selfOnly'
        && security.csp.fontSrc === 'selfOnly'
        && security.csp.connectSrc === 'selfOnly'
        && security.csp.allowDataUrls === false
        && security.csp.allowBlobUrls === false
        && security.csp.allowInlineStyles === false
        && security.csp.allowEval === false;
}

function canEnforceHostedWebSecurityPolicy(input: Readonly<{
    descriptor: Record<string, unknown>;
    security: PluginHostedWebSecurityPolicyV1;
    channel?: PluginUiChannelV1;
    isDevBuildOverride?: boolean;
}>): boolean {
    const serviceKind = readServiceKind(input.descriptor.service);
    const allowDevLoopbackMixedContent = isLocalTrustedDevLoopbackAllowed({
        security: input.security,
        channel: input.channel,
        isDevBuildOverride: input.isDevBuildOverride,
    });
    return serviceKind === 'staticAssets'
        || isRestrictiveHostedWebSecurityPolicy(input.security, allowDevLoopbackMixedContent);
}

/**
 * §8 split-brain removal (EU-8): `sameOrigin` had TWO narrowing owners in
 * series — this one and `resolveHostedPluginWebSandboxPolicy`, which runs
 * afterwards and actually decides the rendered `sandbox` attribute. They
 * disagreed (this one also demanded `routeMode: 'hostOrigin'`), and because the
 * daemon's static-asset server serves `pathFallback` over loopback `http`, the
 * pair forced every daemon-served hosted-web guest into an OPAQUE origin — which
 * silently breaks both bridge directions in a real browser.
 *
 * The narrowing now has one owner. This function keeps only what the DESCRIPTOR
 * decides, which is nothing about origins.
 */

function createBridgeNonce(): string | null {
    const random = globalThis.crypto?.randomUUID?.();
    if (random) return random;
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes.some((byte) => byte !== 0)) {
        return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return null;
}

type HostedWebBridgeCorrelation = Readonly<{
    pluginId: string;
    contributionId: string;
    surfaceId: string;
    nonce: string;
}>;

function appendBridgeCorrelation(query: URLSearchParams, input: HostedWebBridgeCorrelation): void {
    query.set('happierBridgeNonce', input.nonce);
    query.set('happierPluginId', input.pluginId);
    query.set('happierContributionId', input.contributionId);
    query.set('happierSurfaceId', input.surfaceId);
}

function withBridgeQuery(input: HostedWebBridgeCorrelation & Readonly<{
    endpoint: URL;
    hostOrigin?: string | null;
}>): string {
    const url = new URL(input.endpoint.toString());
    appendBridgeCorrelation(url.searchParams, input);
    if (input.hostOrigin) {
        url.searchParams.set('happierHostOrigin', input.hostOrigin);
    }
    return url.toString();
}

/** Correlation-only Artifact frame address. Launch/subPath remain post-ready facts. */
function withArtifactBridgePathAndQuery(input: HostedWebBridgeCorrelation & Readonly<{
    hostOrigin: string | null;
}>): string {
    const query = new URLSearchParams();
    appendBridgeCorrelation(query, input);
    if (input.hostOrigin) {
        query.set('happierHostOrigin', input.hostOrigin);
    }
    return `/?${query.toString()}`;
}

/**
 * Declare this host as the frame's ancestor (§3.12, EU-8).
 *
 * The daemon's static-asset server cannot see who embeds it — an iframe
 * navigation sends no `Origin` and the host sets `referrer-policy: no-referrer`
 * — so the host names itself, and the daemon-issued ancestor token that already
 * rides in the endpoint's own query is what makes that claim trustworthy. It is
 * applied to every daemon/legacy hosted-web frame, bridge or not. The opaque
 * browser Artifact route has a separately configured server-owned ancestor
 * policy and must not receive this query.
 */
function withHostAncestorQuery(endpoint: URL, hostOrigin: string | null): URL {
    const url = new URL(endpoint.toString());
    if (hostOrigin) {
        url.searchParams.set('happierHostOrigin', hostOrigin);
    }
    return url;
}

function resolveCanonicalHostOrigin(): string | null {
    if (Platform.OS !== 'web') return 'https://happier.native';
    const location = Reflect.get(globalThis, 'location');
    if (!location || typeof location !== 'object') return null;
    const origin = Reflect.get(location, 'origin');
    return typeof origin === 'string' && origin.length > 0 && origin !== 'null' ? origin : null;
}

function readHostedWebProjectionUnavailableDiagnosticCode(
    descriptor: unknown,
): PluginHostedWebUnavailableDiagnosticCode | null {
    const runtime = readRecord(readRecord(descriptor)?.runtime);
    const decision = readRecord(runtime?.decision);
    const decisionReason = readPluginHostedWebUnavailableDiagnosticCode(decision?.reason);
    if (decisionReason) return decisionReason;
    const diagnostics = Array.isArray(runtime?.diagnostics) ? runtime.diagnostics : [];
    for (const diagnostic of diagnostics) {
        const code = readPluginHostedWebUnavailableDiagnosticCode(diagnostic);
        if (code) return code;
    }
    return null;
}

function readHostedWebRuntimeUnavailableDiagnosticCode(
    diagnostics: readonly unknown[] | undefined,
): PluginHostedWebUnavailableDiagnosticCode | null {
    for (const diagnostic of diagnostics ?? []) {
        const code = readPluginHostedWebUnavailableDiagnosticCode(diagnostic);
        if (code) return code;
    }
    return null;
}

/**
 * The pane owns only these local terminal presentation facts. A typed issuer or
 * projection diagnostic remains authoritative when present; this function never
 * changes admission, currentness, or the runtime/wire reason contract.
 */
function resolveHostedWebPaneUnavailableDiagnosticCode(input: Readonly<{
    upstreamDiagnosticCode: PluginHostedWebUnavailableDiagnosticCode | null;
    descriptorPresent: boolean;
    projectionPolicyRenderable: boolean;
    runtimeRenderable: boolean;
    hasDaemonEndpointFrame: boolean;
    hasSource: boolean;
    nativeArtifactAdapterUnavailable: boolean;
    sandboxAvailable: boolean;
    securityAvailable: boolean;
    securityEnforceable: boolean;
    frameOriginAvailable: boolean;
    bridgeRequested: boolean;
    bridgeNonceAvailable: boolean;
    readyTimedOut: boolean;
    endpointRenderable: boolean;
}>): PluginHostedWebUnavailableDiagnosticCode | null {
    if (!input.descriptorPresent) {
        return input.upstreamDiagnosticCode ?? 'hosted_web_preview_unavailable';
    }
    if (!input.projectionPolicyRenderable) {
        return input.upstreamDiagnosticCode ?? 'hosted_web_policy_denied';
    }
    if (!input.runtimeRenderable) {
        return input.upstreamDiagnosticCode ?? 'hosted_web_preview_unavailable';
    }
    if (input.nativeArtifactAdapterUnavailable && !input.hasDaemonEndpointFrame) {
        return input.upstreamDiagnosticCode ?? 'hosted_web_frame_adapter_unavailable';
    }
    if (!input.hasSource) {
        return input.upstreamDiagnosticCode ?? 'hosted_web_preview_unavailable';
    }
    // A concrete daemon/native source intentionally bypasses only the
    // projection's missing packaged-frame-adapter fallback. Once that exact
    // source has been admitted, a later local refusal must remain visible;
    // otherwise the bypassed projection fact would mask security, origin,
    // nonce, timeout, or endpoint policy failures. All other upstream facts
    // (notably issuer/currentness failures) retain their existing authority.
    const resolveDownstreamDiagnostic = (local: PluginHostedWebUnavailableDiagnosticCode) => (
        input.upstreamDiagnosticCode === 'hosted_web_frame_adapter_unavailable'
            ? local
            : input.upstreamDiagnosticCode ?? local
    );
    if (!input.sandboxAvailable) {
        return resolveDownstreamDiagnostic('hosted_web_sandbox_unavailable');
    }
    if (!input.securityAvailable || !input.securityEnforceable) {
        return resolveDownstreamDiagnostic('hosted_web_security_unavailable');
    }
    if (!input.frameOriginAvailable) {
        return resolveDownstreamDiagnostic('hosted_web_frame_origin_unavailable');
    }
    if (input.bridgeRequested && !input.bridgeNonceAvailable) {
        return resolveDownstreamDiagnostic('hosted_web_bridge_nonce_unavailable');
    }
    if (input.readyTimedOut) {
        return resolveDownstreamDiagnostic('hosted_web_bridge_timeout');
    }
    if (!input.endpointRenderable) {
        return resolveDownstreamDiagnostic('hosted_web_endpoint_policy_denied');
    }
    return null;
}

export function PluginHostedWebPane(props: Readonly<{
    /** The hosted-web RENDERER contribution: which served asset this frame loads. */
    contributionId: string;
    /**
     * A correlated selected renderer supplied by the generalized physical
     * mount. Targeted children use this exact entry instead of reselecting an
     * ambient projection member; ordinary destinations retain the projection
     * lookup below.
     */
    projectedContribution?: PluginUiHostedWebProjection | null;
    /** The exact selected renderer's projection generation, when supplied. */
    projectionGeneration?: number | null;
    /**
     * §3.1/UI-D11: the mount's surface identity, produced by the ONE bound
     * controller (`resolveBoundPluginSurfaceContext`). The frame query the guest
     * echoes back, the staleness match on every inbound bridge envelope, the
     * ready-state key and the host-API request scope all read it, so the hosted-web
     * transport can no longer disagree with the rest of the host about who this
     * surface is. It is deliberately NOT the renderer contribution id: a
     * `PluginUiSurfaceContextV1.contributionId` is the contribution that DECLARES
     * the surface, everywhere.
     */
    surfaceContext: PluginUiSurfaceContextV1;
    pluginUiProjection: PluginUiProjectionModel | null | undefined;
    endpointUrl?: string | null;
    expiresAt?: number | null;
    /**
     * Browser-only capability transport. The server's signed Artifact response
     * owns its frame-ancestor policy, so this path cannot add the daemon's
     * `happierHostOrigin` query contract.
     */
    opaqueArtifactFrame?: boolean;
    /** A bounded issuer/projection failure fact for the safe state-card channel. */
    unavailableDiagnosticCode?: PluginHostedWebUnavailableDiagnosticCode | null;
    /**
     * Existing target/caller fallback for a targeted surface. The host owns
     * selection and contributor attribution; the pane consumes this only for
     * its local ready-timeout and native-frame operational failures.
     */
    targetedFallback?: React.ReactNode;
    nowMs?: () => number;
    platform?: PluginHostedWebPanePlatform;
    navigationKey?: string;
    /** Resolver-stamped ephemeral lifetime key; it is never persisted or derived here. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** The bound controller remains the sole currentness authority. */
    isCurrent?: () => boolean;
    /**
     * The incumbent Account lifetime behind this bound surface. The bridge
     * observes its existing retirement seam only; it does not create a second
     * Account owner or retain any Account facts.
     */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    navigationCommand?: BrowserFrameNavigationCommand;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    bridgeNonce?: string;
    readyTimeoutMs?: number | null;
    onBridgeMessage?: (envelope: PluginHostedWebBridgeEnvelopeV1) => void;
    hostApi?: Readonly<{
        platform: PluginUiPlatformV1;
        channel: PluginUiChannelV1;
        // The bridge's own handler contract, not a fourth hand-written copy: the
        // narrower one-parameter spelling that used to live here silently dropped
        // the caller-cancellation argument from the type while the runtime value
        // still carried it.
        handleRequest: PluginHostedWebHostApiRequestHandler;
    }>;
    canonicalHostApi?: Readonly<{
        identity: PluginUiHostApiWireIdentityV1;
        /** The exact public mount fact already stamped by the bound host. */
        mount: SurfaceContext['mount'];
        methods: readonly PluginUiHostMethodV1[];
        /** §3.2: the exact target this placement resolved for the surface. */
        target: PluginSurfaceTarget;
        /** Account-lifetime-bound public disclosure from the shared host. */
        accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
        /** §3.2: the plugin's projected translation bundle for the active locale. */
        translations: Readonly<Record<string, string>>;
        /** Exact daemon-admitted target snapshot; an empty snapshot is valid. */
        targetedContributions: SurfaceContext['targetedContributions'];
    }>;
    /**
     * The mounted host's single Account-scoped Data bridge factory. The pane
     * lends it only to the incumbent framed lifecycle after canonical host API
     * bootstrap is available; it never becomes an alternate guest transport.
     */
    createCollectionUiQueryBridge?: PluginHostedWebCollectionUiQueryBridgeFactory;
    interactionEnabled?: boolean;
    /** Outer physical mount's retained-pane eligibility, independent of availability. */
    focusEligible?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    /**
     * EU-4b: the mount's live resource invalidation sink. The bridge handler
     * pushes each event to the frame; the subscription itself is owned by the
     * mount's `watchResource` handler, so hosted web adds no second owner.
     */
    subscribeResourceInvalidations?: (
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ) => () => void;
    /**
     * An exact mounted Composer handler lends its document owner the incumbent
     * host-to-frame publisher through this mount-local setter. The Pane clears
     * it before its bridge retires; the private current Composer ref remains
     * absent from generic and targeted mounts.
     */
    setComposerSubscriptionPublisher?: (
        publisher: PluginHostedWebComposerSubscriptionPublisher | undefined,
    ) => void;
    /**
     * §3.7 launch facts for this mount, delivered in-frame (EU-8). The same two
     * values `PluginSurfaceHost` puts on a React Native `RenderContext`, so an
     * `openSurface(destination, input, { subPath })` reaches a hosted-web destination
     * with the same meaning it has on the native side.
     */
    launchInput?: PluginUiLaunchInputV1;
    subPath?: PluginUiSubPathV1;
    /** Exact host-stamped Composer mount identity, absent from generic mounts. */
    composerRef?: ComposerRefV1;
    /**
     * Availability injects a selected opaque handle here after Artifact has
     * chosen, verified, persisted, and registered it. This pane never acquires
     * bytes or chooses a source.
     */
    nativeArtifactAdoption?: PluginUiArtifactAdoption<
        'hostedWebNative',
        PluginNativeArtifactResourceHandle
    > | null;
}>): React.ReactElement {
    const { theme, rt } = useUnistyles();
    const descriptor = props.projectedContribution === undefined
        ? props.pluginUiProjection?.hostedWebById[props.contributionId]
        : props.projectedContribution;
    const hasDescriptor = descriptor !== null && descriptor !== undefined;
    const platform = resolvePlatform(props.platform);
    const interactionEnabled = props.interactionEnabled ?? Boolean(props.hostApi);
    const effectiveInteractionEnabled = interactionEnabled && props.focusEligible !== false;
    const opaqueArtifactFrame = platform === 'web' && props.opaqueArtifactFrame === true;
    const hostedRuntime = hasDescriptor
        ? resolveHostedWebRuntimeDiagnostics({
            hostedWeb: descriptor,
            endpointUrl: props.endpointUrl,
            expiresAt: props.expiresAt,
            nowMs: props.nowMs?.() ?? Date.now(),
        })
        : null;
    const endpoint = readEndpointUrl(hostedRuntime?.state === 'ready' ? hostedRuntime.endpointUrl : null);
    const upstreamUnavailableDiagnosticCode = props.unavailableDiagnosticCode
        ?? readHostedWebProjectionUnavailableDiagnosticCode(descriptor)
        ?? (hostedRuntime?.state === 'fallback'
            ? readHostedWebRuntimeUnavailableDiagnosticCode(hostedRuntime.diagnostics)
            : null);
    const isCurrentRef = React.useRef(props.isCurrent);
    isCurrentRef.current = props.isCurrent;
    const artifactCurrentnessRef = React.useRef<PluginHostedWebArtifactCurrentness | null>(null);
    const isSurfaceCurrent = React.useCallback(() => {
        if (!(isCurrentRef.current?.() ?? true)) return false;
        try {
            return artifactCurrentnessRef.current?.isCurrent() ?? true;
        } catch {
            return false;
        }
    }, []);
    const surfaceEnvironment = usePluginSurfaceEnvironment(platform);
    const policyContext = React.useMemo(() => createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform,
            channel: props.hostApi?.channel ?? 'internal',
        },
    ), [platform, props.hostApi?.channel, props.policyContext]);
    // F7: an app-scope projection is a union, so the descriptor's OWN origin
    // generation owns this frame's lifetime. Reading the model-level generation
    // would remount a hosted-web surface every time an unrelated machine's
    // projection advanced.
    const projectionGeneration = props.projectionGeneration
        ?? readPluginUiContributionOrigin(descriptor)?.generation
        ?? props.pluginUiProjection?.generation
        ?? null;
    const sandbox = hasDescriptor ? readSandboxPolicy(descriptor.sandbox) : null;
    const security = hasDescriptor ? readSecurityPolicy(descriptor.security) : null;
    // Artifact ownership injects only a registered opaque handle. A native
    // host consumes it only for a static-asset renderer; session/daemon URLs
    // retain the established generic frame path and cannot borrow this handle.
    const nativeArtifactAdoption = (
        (platform === 'ios' || platform === 'android' || platform === 'desktop')
        && readServiceKind(descriptor?.service) === 'staticAssets'
    ) ? props.nativeArtifactAdoption ?? null : null;
    const nativeArtifactHandle = nativeArtifactAdoption?.handle ?? null;
    const artifactCurrentness = nativeArtifactHandle;
    artifactCurrentnessRef.current = artifactCurrentness;
    const [nativeArtifactFrameEnabled, setNativeArtifactFrameEnabled] = React.useState(false);
    const [nativeArtifactAdapterUnavailableHandle, setNativeArtifactAdapterUnavailableHandle] = React.useState<NativeArtifactFrameHandle | null>(null);
    const [nativeArtifactFrameLoadStateForHandle, setNativeArtifactFrameLoadStateForHandle] = React.useState<NativeArtifactFrameLoadStateForHandle>({
        handle: null,
        state: 'loading',
    });
    const [nativeArtifactHistoryStateForHandle, setNativeArtifactHistoryStateForHandle] = React.useState<NativeArtifactHistoryStateForHandle>({
        handle: null,
        canGoBack: false,
    });
    const nativeArtifactGoBackCommandIdRef = React.useRef(0);
    const [nativeArtifactGoBackCommand, setNativeArtifactGoBackCommand] = React.useState<BrowserFrameNavigationCommand | null>(null);
    const nativeArtifactAdapterUnavailable = nativeArtifactHandle !== null
        && nativeArtifactAdapterUnavailableHandle === nativeArtifactHandle;
    React.useLayoutEffect(() => {
        const adoption = nativeArtifactAdoption;
        const handle = adoption?.handle ?? null;
        setNativeArtifactFrameEnabled(false);
        setNativeArtifactAdapterUnavailableHandle(null);
        setNativeArtifactFrameLoadStateForHandle({ handle, state: 'loading' });
        setNativeArtifactHistoryStateForHandle({ handle, canGoBack: false });
        setNativeArtifactGoBackCommand(null);
        if (!handle) return;

        let disposedForTarget = false;
        const disposeForTarget = () => {
            if (disposedForTarget) return;
            disposedForTarget = true;
            adoption?.dispose();
        };
        if (!handle.isCurrent()) {
            return;
        }
        setNativeArtifactFrameEnabled(true);
        return () => {
            // Target/generation replacement owns the consumed handle's normal
            // teardown. This executes in layout cleanup before a replacement
            // frame is committed, so stale bytes cannot remain mounted.
            disposeForTarget();
        };
    }, [nativeArtifactAdoption, projectionGeneration, props.mountInstanceKey]);
    const nativeArtifactFrameOrigin = nativeArtifactHandle
        && !nativeArtifactAdapterUnavailable
        && (platform === 'ios' || platform === 'android' || platform === 'desktop')
        && nativeArtifactHandle.isCurrent()
        ? (platform === 'desktop' ? nativeArtifactHandle.frameOrigin : undefined)
            ?? resolvePluginHostedWebNativeArtifactFrameOriginV1({
                platform,
                storagePartitionId: nativeArtifactHandle.storagePartitionId,
            })
        : null;
    const nativeArtifactFrame = nativeArtifactFrameEnabled && nativeArtifactFrameOrigin && nativeArtifactHandle
        ? Object.freeze({
            artifactHandleToken: nativeArtifactHandle.token,
            frameOrigin: nativeArtifactFrameOrigin,
        })
        : null;
    const nativeArtifactActivationPending = nativeArtifactFrameOrigin !== null && !nativeArtifactFrameEnabled;
    const nativeArtifactFrameLoadState = nativeArtifactFrameLoadStateForHandle.handle === nativeArtifactHandle
        ? nativeArtifactFrameLoadStateForHandle.state
        : 'loading';
    const nativeArtifactCanGoBack = nativeArtifactHistoryStateForHandle.handle === nativeArtifactHandle
        && nativeArtifactHistoryStateForHandle.canGoBack;
    const handleNativeArtifactUnavailable = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactAdapterUnavailableHandle(handle);
        nativeArtifactAdoption?.dispose();
    }, [nativeArtifactAdoption, nativeArtifactHandle]);
    const handleNativeArtifactLoadStart = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactFrameLoadStateForHandle({ handle, state: 'loading' });
    }, [nativeArtifactHandle]);
    const handleNativeArtifactLoadEnd = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactFrameLoadStateForHandle({ handle, state: 'ready' });
    }, [nativeArtifactHandle]);
    const handleNativeArtifactLoadError = React.useCallback((event: unknown) => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactFrameLoadStateForHandle({
            handle,
            state: {
                kind: 'error',
                code: readNativeArtifactLoadErrorCode(event),
            },
        });
    }, [nativeArtifactHandle]);
    const handleNativeArtifactHistoryStateChange = React.useCallback((canGoBack: boolean) => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactHistoryStateForHandle({ handle, canGoBack });
    }, [nativeArtifactHandle]);
    const handleNativeArtifactGoBackResult = React.useCallback((handled: boolean) => {
        if (handled) return;
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        // A stale positive event must not trap a later native/route Back after
        // the native frame reports that no current history entry exists.
        setNativeArtifactHistoryStateForHandle({ handle, canGoBack: false });
    }, [nativeArtifactHandle]);
    const nativeArtifactGuestHistoryActive = (platform === 'ios' || platform === 'android')
        && nativeArtifactFrame !== null
        && nativeArtifactCanGoBack;
    const requestNativeArtifactGoBack = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (
            !effectiveInteractionEnabled
            || !nativeArtifactGuestHistoryActive
            || !handle
            || artifactCurrentnessRef.current !== handle
            || !handle.isCurrent()
        ) {
            return false;
        }
        nativeArtifactGoBackCommandIdRef.current += 1;
        setNativeArtifactGoBackCommand({
            commandId: `hosted-artifact-history-back-${nativeArtifactGoBackCommandIdRef.current}`,
            kind: 'goBack',
        });
        return true;
    }, [effectiveInteractionEnabled, nativeArtifactGuestHistoryActive, nativeArtifactHandle]);
    const requestAndroidNativeArtifactGoBack = React.useCallback(
        () => effectiveInteractionEnabled && requestNativeArtifactGoBack(),
        [effectiveInteractionEnabled, requestNativeArtifactGoBack],
    );
    useNativeBackLayerBackHandler(
        effectiveInteractionEnabled && platform === 'android' && nativeArtifactGuestHistoryActive,
        requestAndroidNativeArtifactGoBack,
    );
    const launchInputSemanticKey = stableJsonStringify({
        present: props.launchInput !== undefined,
        value: props.launchInput,
    });
    // The nonce is the guest's address proof for exactly one bound frame, so its
    // lifetime must cover every fact that replaces the guest document. The bound
    // page location is one of them: `bridgeLifetimeKey` below already re-keys the
    // frame on it, so without it here the document minted for the previous page
    // would hand its still-valid nonce to the document that replaces it.
    const bridgeNonce = React.useMemo(
        () => props.bridgeNonce ?? createBridgeNonce(),
        [
            launchInputSemanticKey,
            projectionGeneration,
            props.bridgeNonce,
            props.mountInstanceKey,
            props.subPath,
        ],
    );
    const allowedMessageKinds = descriptor ? readAllowedMessageKinds(descriptor.bridge) : [];
    const canonicalHostOrigin = resolveCanonicalHostOrigin();
    const canonicalWireAllowed = allowedMessageKinds.includes('hostApi');
    // §3.2/§3.3/UI-D11: one context owner. This mount no longer builds its own
    // snapshot from its own copy of the environment hooks — it composes the same
    // `SurfaceContext` the React Native mount receives, so the two can no longer
    // disagree about target, theme, locale or accessibility facts.
    const canonicalHostApi = React.useMemo(() => {
        const binding = props.canonicalHostApi;
        if (!binding || !canonicalWireAllowed || !canonicalHostOrigin) return undefined;
        return Object.freeze({
            identity: binding.identity,
            methods: binding.methods,
            target: binding.target,
            surface: createPluginSurfaceContext({
                mount: binding.mount,
                target: binding.target,
                accountEncryptionMode: binding.accountEncryptionMode,
                environment: surfaceEnvironment,
                translations: binding.translations,
                targetedContributions: binding.targetedContributions,
            }),
        });
    }, [
        canonicalHostOrigin,
        canonicalWireAllowed,
        props.canonicalHostApi,
        surfaceEnvironment,
    ]);
    // Collection UI-query messages are meaningful only once the canonical
    // hosted bootstrap exists. A descriptor cannot expose Data by declaring a
    // message kind alone: without hostApi there is no single ready/currentness
    // lifecycle or private guest bootstrap carrier to consume it.
    const collectionUiQueryMessageAllowed = canonicalHostApi !== undefined
        && allowedMessageKinds.includes(PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1);
    const collectionUiQueryBridgeAllowed = collectionUiQueryMessageAllowed
        && props.createCollectionUiQueryBridge !== undefined;
    // `ready` is an internal lifecycle handshake for the canonical host API,
    // not an author-selected bridge method. A canonical frame cannot receive its
    // post-ready bootstrap without it, even when the declared author vocabulary
    // contains only `hostApi`.
    const readyRequired = canonicalHostApi !== undefined || allowedMessageKinds.includes('ready');
    const bridgeAllowedMessageKinds = React.useMemo(() => {
        const kinds = new Set<string>(allowedMessageKinds);
        if (canonicalHostApi) kinds.add('ready');
        if (!collectionUiQueryMessageAllowed) {
            kinds.delete(PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1);
        }
        return kinds;
    }, [allowedMessageKinds, canonicalHostApi, collectionUiQueryMessageAllowed]);
    const [readyTimedOut, setReadyTimedOut] = React.useState(false);
    // EU-8: the mounted frame lends its host->frame delivery primitive here for
    // as long as it is mounted. The registry is a ref, not state, so attaching a
    // frame never re-creates the bridge handler — a handler churn would retire
    // the guest's subscriptions on every render.
    const frameSinkRef = React.useRef<((message: unknown) => void) | null>(null);
    const postToFrame = React.useCallback<PluginHostedWebHostMessageSink>((envelope) => {
        const terminal = envelope.kind === 'hostApi' && envelope.payload.kind === 'disconnected';
        if (!terminal && !isSurfaceCurrent()) return;
        frameSinkRef.current?.(envelope);
    }, [isSurfaceCurrent]);
    // The canonical snapshot is read through a ref, exactly as `PluginSurfaceHost`
    // does for the React Native mount: a locale, theme or accessibility change
    // must reach the guest as a PUSH, never as a new bridge handler that would
    // disconnect it and drop its subscriptions.
    const canonicalSurfaceRef = React.useRef<PluginUiJsonValueV1 | undefined>(undefined);
    canonicalSurfaceRef.current = canonicalHostApi?.surface;
    // Method installation is a current capability fact for `negotiate`, not a
    // new bound surface. Keeping it behind the incumbent bridge's read seam
    // prevents a harmless capability expansion from remounting the guest and
    // dropping its state/subscriptions.
    const canonicalInstalledMethodsRef = React.useRef<readonly PluginUiHostMethodV1[]>([]);
    canonicalInstalledMethodsRef.current = canonicalHostApi?.methods ?? [];
    const readCanonicalInstalledMethods = React.useCallback(
        () => canonicalInstalledMethodsRef.current,
        [],
    );
    // The request handler is read the same way and for the same reason: a new
    // handler FUNCTION is not a new surface lifetime. Rebuilding the bridge on
    // its identity would disconnect a live guest — and now that retirement is
    // pushed, the guest would actually see it — every time an ancestor
    // re-rendered. What the transport must react to is whether a handler is
    // installed at all, which is a boolean and stays in the memo key.
    const handleRequestRef = React.useRef<PluginHostedWebHostApiRequestHandler | undefined>(undefined);
    handleRequestRef.current = interactionEnabled ? props.hostApi?.handleRequest : undefined;
    const handleRequestInstalled = handleRequestRef.current !== undefined;
    const handleRequest = React.useCallback<PluginHostedWebHostApiRequestHandler>(
        (request, options) => {
            const current = handleRequestRef.current;
            if (!current) {
                throw new Error('Plugin hosted-web host API request handler is unavailable.');
            }
            // Forwarded verbatim, including the absence of cancellation: an
            // invented `undefined` second argument would change what the mount
            // observes about how it was called.
            return options === undefined ? current(request) : current(request, options);
        },
        [],
    );
    const canonicalBindingKey = canonicalHostApi
        ? [
            canonicalHostApi.identity.pluginId,
            canonicalHostApi.identity.pluginVersion,
            canonicalHostApi.identity.viewId,
            canonicalHostApi.identity.generation,
            canonicalHostApi.identity.sessionId ?? '',
            getPluginSurfaceTargetAuthorityKey(canonicalHostApi.target),
            canonicalHostApi.surface.targetedContributions.target.pluginId,
            canonicalHostApi.surface.targetedContributions.target.immutableGenerationId,
        ].join('')
        : null;
    // Account lifetime is an opaque object rather than serializable UI state.
    // Track only replacement identity for the bridge/frame key; currentness
    // and retirement still come exclusively from the captured lifetime.
    const bridgeAccountLifetimeRef = React.useRef(props.accountLifetime ?? null);
    const bridgeAccountLifetimeRevisionRef = React.useRef(0);
    if (bridgeAccountLifetimeRef.current !== (props.accountLifetime ?? null)) {
        bridgeAccountLifetimeRef.current = props.accountLifetime ?? null;
        bridgeAccountLifetimeRevisionRef.current += 1;
    }
    const bridgeAccountLifetimeRevision = bridgeAccountLifetimeRevisionRef.current;
    const frameOrigin = nativeArtifactFrame?.frameOrigin
        ?? (nativeArtifactActivationPending ? nativeArtifactFrameOrigin : null)
        ?? endpoint?.origin
        ?? null;
    // Only the bridge-routing identity belongs to the bound frame lifetime.
    // Live context facts (theme, locale, accessibility, Resource scope and
    // diagnostics) are delivered through `watchContext`; keying the guest by
    // the whole snapshot would disconnect those subscriptions before the PUSH
    // that reports the change can reach them.
    const bridgeSurfaceIdentityKey = stableJsonStringify({
        pluginId: props.surfaceContext.pluginId,
        contributionId: props.surfaceContext.contributionId,
        surfaceId: props.surfaceContext.surfaceId,
        sessionId: props.surfaceContext.sessionId ?? null,
    });
    const bridgeDescriptorKey = stableJsonStringify(descriptor
        ? {
            pluginId: descriptor.pluginId,
            contributionId: descriptor.contributionId,
            bridge: descriptor.bridge,
        }
        : null);
    // This is the bound bridge lifetime, not a second currentness owner. Every
    // fact here already causes the handler below to represent a different
    // ready/bootstrap contract; keying the guest by the same facts prevents a
    // retired handler's terminal packet from being delivered into a new one.
    const bridgeLifetimeKey = stableJsonStringify({
        bridgeNonce,
        canonicalBindingKey,
        descriptor: bridgeDescriptorKey,
        frameOrigin,
        launchInput: launchInputSemanticKey,
        subPath: props.subPath ?? null,
        mountInstanceKey: props.mountInstanceKey ?? null,
        opaqueArtifactFrame,
        projectionGeneration,
        handleRequestInstalled,
        collectionUiQueryBridgeAllowed,
        accountLifetimeRevision: bridgeAccountLifetimeRevision,
        surfaceIdentity: bridgeSurfaceIdentityKey,
    });
    const collectionUiQueryBridgeFactoryRef = React.useRef<PluginHostedWebCollectionUiQueryBridgeFactory | undefined>(undefined);
    collectionUiQueryBridgeFactoryRef.current = collectionUiQueryBridgeAllowed
        ? props.createCollectionUiQueryBridge
        : undefined;
    const createCollectionUiQueryBridge = React.useCallback<PluginHostedWebCollectionUiQueryBridgeFactory>((input) => {
        const factory = collectionUiQueryBridgeFactoryRef.current;
        if (!factory) {
            throw new Error('Plugin hosted-web collection UI-query bridge is unavailable.');
        }
        return factory(input);
    }, []);
    const hostApiBridgeHandler = React.useMemo<PluginHostedWebHostApiBridgeHandler | null>(() => {
        if (!descriptor || !bridgeNonce) return null;
        const binding = canonicalHostApi;
        return createPluginHostedWebHostApiBridgeHandler({
            surface: props.surfaceContext,
            requestIdPrefix: `hostedWeb:${descriptor.pluginId}:${descriptor.contributionId}`,
            bridgeNonce,
            ...(binding && frameOrigin
                ? {
                    bootstrap: {
                        frameOrigin,
                        ...(props.launchInput === undefined ? {} : { launchInput: props.launchInput }),
                        ...(props.subPath === undefined ? {} : { subPath: props.subPath }),
                        ...(props.composerRef === undefined ? {} : { composerRef: props.composerRef }),
                    },
                }
                : {}),
            ...(binding
                ? {
                    canonicalHostApi: {
                        ...binding,
                        surface: canonicalSurfaceRef.current ?? binding.surface,
                    },
                    readInstalledMethods: readCanonicalInstalledMethods,
                    postToFrame,
                }
                : {}),
            ...(collectionUiQueryBridgeAllowed
                ? { createCollectionUiQueryBridge }
                : {}),
            isCurrent: isSurfaceCurrent,
            ...(handleRequestInstalled ? { handleRequest } : {}),
            onReadyStateChange: (state) => {
                if (state.state === 'ready') {
                    setReadyTimedOut(false);
                    return;
                }
                if (state.state === 'timedOut') {
                    setReadyTimedOut(true);
                }
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the canonical
        // surface is read through a ref on purpose; the push effect below is its
        // producer. Depending on the snapshot here would rebuild the handler on
        // every context change and retire the guest's subscriptions with it.
    }, [
        bridgeLifetimeKey,
        readCanonicalInstalledMethods,
        handleRequest,
        handleRequestInstalled,
        postToFrame,
        collectionUiQueryBridgeAllowed,
        createCollectionUiQueryBridge,
        isSurfaceCurrent,
        props.accountLifetime,
    ]);
    const hostApiBridgeHandlerRef = React.useRef<PluginHostedWebHostApiBridgeHandler | null>(null);
    hostApiBridgeHandlerRef.current = hostApiBridgeHandler;
    const setComposerSubscriptionPublisher = props.setComposerSubscriptionPublisher;
    const composerSubscriptionPublisher = setComposerSubscriptionPublisher !== undefined
        && canonicalHostApi?.methods.includes('watchComposer')
        && handleRequestInstalled
        ? hostApiBridgeHandler?.publishComposerSubscriptionEvent
        : undefined;
    // The host document owns Composer observation. This physical Pane merely
    // lends its existing framed publisher for the exact bridge lifetime, before
    // a browser frame can begin guest traffic, then removes it before a retired
    // bridge can be addressed by a later document.
    React.useLayoutEffect(() => {
        if (!setComposerSubscriptionPublisher) return;
        setComposerSubscriptionPublisher(composerSubscriptionPublisher);
        return () => setComposerSubscriptionPublisher(undefined);
    }, [composerSubscriptionPublisher, setComposerSubscriptionPublisher]);
    React.useLayoutEffect(() => {
        const lifetime = props.accountLifetime;
        if (!lifetime) return;
        // Retire the handler that captured this exact Account before the
        // Account owner exposes its replacement. `dispose()` clears the sole
        // selected-operation map and pushes the canonical terminal notice.
        const retire = () => hostApiBridgeHandler?.dispose();
        const subscription = lifetime.onRetire(retire);
        if (!lifetime.isCurrent()) retire();
        return () => subscription.dispose();
    }, [hostApiBridgeHandler, props.accountLifetime]);
    const handleOpaqueArtifactUnexpectedNavigation = React.useCallback(() => {
        // The opaque iframe now contains a replacement document, so its
        // wildcard delivery primitive must be severed before the bridge's
        // disposal packet can be constructed. The bridge remains the one
        // owner of subscription cancellation and terminal state.
        frameSinkRef.current = null;
        hostApiBridgeHandlerRef.current?.dispose();
    }, []);
    React.useLayoutEffect(() => {
        const handle = artifactCurrentness;
        if (!handle) return;
        const retire = () => {
            // Source revocation synchronously closes admission and reaches the
            // incumbent bridge handler while its exact frame sink is still
            // attached. The following React update only removes presentation;
            // it is not a second retirement owner.
            hostApiBridgeHandlerRef.current?.dispose();
            setNativeArtifactFrameEnabled(false);
        };
        const subscription = handle.onRevoke(retire);
        if (!handle.isCurrent()) retire();
        return () => subscription.dispose();
    }, [artifactCurrentness, nativeArtifactHandle]);
    const attachHostMessages = React.useCallback((send: (message: unknown) => void) => {
        frameSinkRef.current = send;
        const attachedHandler = hostApiBridgeHandler;
        return () => {
            // Account retirement closes the bound controller before React has
            // detached the incumbent iframe. Dispose through the one bridge
            // owner while that exact sink is still lent, so its canonical
            // terminal packet can reach the guest; ordinary currentness still
            // suppresses every non-terminal push in the adapter.
            if (!isSurfaceCurrent()) attachedHandler?.dispose();
            if (frameSinkRef.current === send) frameSinkRef.current = null;
        };
    }, [hostApiBridgeHandler, isSurfaceCurrent]);
    // The context producer for this transport (UI-D03), the hosted-web twin of
    // `PluginSurfaceHost`'s. An identical snapshot is not republished, so the
    // push that runs at mount is not a spurious event.
    React.useEffect(() => {
        const surface = canonicalHostApi?.surface;
        if (hostApiBridgeHandler && surface) hostApiBridgeHandler.pushSurfaceContext(surface);
    }, [canonicalHostApi?.surface, hostApiBridgeHandler]);
    // EU-4b: the mount's one invalidation sink reaches this transport's push
    // channel. The subscription registry stays the bridge handler's.
    const subscribeResourceInvalidations = props.subscribeResourceInvalidations;
    React.useEffect(() => {
        if (!hostApiBridgeHandler || !subscribeResourceInvalidations) return;
        return subscribeResourceInvalidations((event) => {
            hostApiBridgeHandler.publishResourceSubscriptionEvent(event);
        });
    }, [hostApiBridgeHandler, subscribeResourceInvalidations]);
    React.useLayoutEffect(() => {
        setReadyTimedOut(false);
        if (!hostApiBridgeHandler || !readyRequired || props.readyTimeoutMs === null) {
            return () => {
                hostApiBridgeHandler?.dispose();
            };
        }

        const timeout = setTimeout(() => {
            const snapshot = hostApiBridgeHandler.recordReadyTimeout();
            if (snapshot.state === 'timedOut') {
                setReadyTimedOut(true);
            }
        }, props.readyTimeoutMs ?? 30_000);
        return () => {
            clearTimeout(timeout);
            hostApiBridgeHandler.dispose();
        };
    }, [hostApiBridgeHandler, props.readyTimeoutMs, readyRequired]);
    const handleBridgeMessage = React.useCallback((
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ) => {
        if (!isSurfaceCurrent()) {
            return hostApiBridgeHandler?.(envelope);
        }
        props.onBridgeMessage?.(envelope);
        return hostApiBridgeHandler?.(envelope);
    }, [hostApiBridgeHandler, isSurfaceCurrent, props.onBridgeMessage]);
    const bridgeRequested = Boolean((props.onBridgeMessage || hostApiBridgeHandler) && bridgeAllowedMessageKinds.size > 0);
    const hasNativeArtifactFrame = nativeArtifactFrame !== null;
    const hasNativeArtifactSource = hasNativeArtifactFrame || nativeArtifactActivationPending;
    const hasDaemonEndpointFrame = hostedRuntime?.state === 'ready' && endpoint !== null;
    const projectionPolicyRenderable = hasDescriptor
        && canRenderPluginUiProjectionEntry(descriptor, policyContext);
    const runtimeRenderable = hasDescriptor
        && canRenderProjectedHostedWebRuntime(
            descriptor.runtime,
            hasDaemonEndpointFrame || hasNativeArtifactSource,
        );
    const securityEnforceable = hasDescriptor
        && security !== null
        && canEnforceHostedWebSecurityPolicy({ descriptor, security, channel: props.hostApi?.channel });
    const endpointRenderable = hasNativeArtifactSource || canRenderHostedWebEndpoint({
        url: endpoint,
        platform,
        security,
        channel: props.hostApi?.channel,
    });
    const unavailableDiagnosticCode = resolveHostedWebPaneUnavailableDiagnosticCode({
        upstreamDiagnosticCode: upstreamUnavailableDiagnosticCode,
        descriptorPresent: hasDescriptor,
        projectionPolicyRenderable,
        runtimeRenderable,
        hasDaemonEndpointFrame,
        hasSource: hasDaemonEndpointFrame || hasNativeArtifactSource,
        nativeArtifactAdapterUnavailable,
        sandboxAvailable: sandbox !== null,
        securityAvailable: security !== null,
        securityEnforceable,
        frameOriginAvailable: Boolean(frameOrigin),
        bridgeRequested,
        bridgeNonceAvailable: Boolean(bridgeNonce),
        readyTimedOut,
        endpointRenderable,
    });

    // The bounded resolver above owns every terminal reason. Retain the direct
    // presence guard so TypeScript narrows the render-only values below without
    // introducing a second policy/currentness decision.
    if (unavailableDiagnosticCode || !descriptor || !sandbox || !security || !frameOrigin) {
        if (unavailableDiagnosticCode === 'hosted_web_bridge_timeout' && props.targetedFallback !== undefined) {
            return <>{props.targetedFallback}</>;
        }
        return <PluginHostedWebUnavailable diagnosticCode={unavailableDiagnosticCode} />;
    }

    if (nativeArtifactActivationPending) {
        return <BrowserFrameLoading testID="plugin-hosted-web-frame" />;
    }

    if (nativeArtifactFrame && typeof nativeArtifactFrameLoadState !== 'string') {
        if (props.targetedFallback !== undefined) {
            return <>{props.targetedFallback}</>;
        }
        return (
            <BrowserFrameError
                testID="plugin-hosted-web-frame"
                errorCode={nativeArtifactFrameLoadState.code}
            />
        );
    }

    // A native Artifact error has returned above. Keep the renderer's narrow
    // lifecycle prop binary so it only ever selects its loading overlay or
    // exposes an already-successful native view.
    const nativeArtifactFramePresentationState = typeof nativeArtifactFrameLoadState === 'string'
        ? nativeArtifactFrameLoadState
        : 'loading';

    // One identity for this mount: the frame guard, the query the guest echoes and
    // the bridge's staleness match all read the controller's surface context, so a
    // guest that echoes what the host gave it always matches.
    const surface = props.surfaceContext;
    const bridge = bridgeRequested && bridgeNonce
        ? {
            expectedOrigin: frameOrigin,
            expectedPluginId: surface.pluginId,
            expectedContributionId: surface.contributionId,
            expectedSurfaceId: surface.surfaceId,
            expectedNonce: bridgeNonce,
            // The first ready is sessionless on every frame. The canonical host
            // bootstrap stamps the Session identity before later wire traffic.
            expectedSessionId: surface.sessionId ?? null,
            allowedMessageKinds: bridgeAllowedMessageKinds,
            onMessage: handleBridgeMessage,
            attachHostMessages,
        }
        : null;
    const frameUrl = endpoint
        ? (() => {
            const embeddableEndpoint = opaqueArtifactFrame
                ? endpoint
                : withHostAncestorQuery(endpoint, canonicalHostOrigin);
            return bridge
                ? withBridgeQuery({
                    endpoint: embeddableEndpoint,
                    pluginId: surface.pluginId,
                    contributionId: surface.contributionId,
                    surfaceId: surface.surfaceId,
                    nonce: bridge.expectedNonce,
                    // This non-secret target origin is necessary for the guest
                    // to address its parent. The signed server capability still
                    // owns the actual embedding audience and ancestor policy.
                    hostOrigin: opaqueArtifactFrame ? canonicalHostOrigin : null,
                })
                : embeddableEndpoint.toString();
        })()
        : undefined;
    const artifactFrameInput = nativeArtifactFrame
        ? Object.freeze({
            artifactHandleToken: nativeArtifactFrame.artifactHandleToken,
            initialPathAndQuery: bridge
                ? withArtifactBridgePathAndQuery({
                    pluginId: surface.pluginId,
                    contributionId: surface.contributionId,
                    surfaceId: surface.surfaceId,
                    nonce: bridge.expectedNonce,
                    hostOrigin: canonicalHostOrigin,
                })
                : '/',
        })
        : null;
    const nativeArtifact = platform === 'desktop' ? null : artifactFrameInput;
    const desktopArtifact = platform === 'desktop' ? artifactFrameInput : null;
    const display = readRecord(descriptor.display);
    const frameTitle = resolvePluginUiText({
        projection: props.pluginUiProjection,
        pluginId: descriptor.pluginId,
        key: typeof display?.titleKey === 'string' ? display.titleKey : null,
        fallback: typeof display?.developerFallback === 'string'
            ? display.developerFallback
            : surface.surfaceId,
    });
    const artifactFrame = nativeArtifact ?? desktopArtifact;
    const frameNavigationCommand = artifactFrame
        ? nativeArtifactGoBackCommand
            ?? (props.navigationCommand?.kind === 'goBack' ? props.navigationCommand : undefined)
        : props.navigationCommand;

    return (
        <PluginSurfaceInteractionBoundary
            surfaceId={surface.surfaceId}
            snapshotTitle={frameTitle}
            enabled={interactionEnabled}
            focusEligible={props.focusEligible}
        >
            <NativeArtifactHistoryRouteBackGuard
                active={platform === 'ios' && effectiveInteractionEnabled && nativeArtifactGuestHistoryActive}
                requestGuestGoBack={requestNativeArtifactGoBack}
            />
            <PluginHostedWebFrame
                key={[
                    projectionGeneration ?? 'unversioned',
                    props.mountInstanceKey ?? 'legacy',
                    nativeArtifact?.artifactHandleToken ?? desktopArtifact?.artifactHandleToken ?? 'daemon-frame',
                    bridgeLifetimeKey,
                ].join('\u001f')}
                bridge={bridge}
                security={security}
                sandbox={sandbox}
                title={frameTitle}
                {...(frameUrl ? { url: frameUrl } : {})}
                {...(opaqueArtifactFrame ? {
                    opaqueArtifactFrame: true,
                    onUnexpectedNavigation: handleOpaqueArtifactUnexpectedNavigation,
                } : {})}
                {...(nativeArtifact ? { nativeArtifact } : {})}
                {...(desktopArtifact ? { desktopArtifact } : {})}
                {...(nativeArtifact || desktopArtifact ? { onNativeArtifactUnavailable: handleNativeArtifactUnavailable } : {})}
                {...(nativeArtifact || desktopArtifact ? {
                    nativeArtifactLoadState: nativeArtifactFramePresentationState,
                    onNativeArtifactLoadStart: handleNativeArtifactLoadStart,
                    onNativeArtifactLoadEnd: handleNativeArtifactLoadEnd,
                    onNativeArtifactLoadError: handleNativeArtifactLoadError,
                } : {})}
                {...(nativeArtifact || desktopArtifact ? {
                    onNativeArtifactHistoryStateChange: handleNativeArtifactHistoryStateChange,
                    onNativeArtifactGoBackResult: handleNativeArtifactGoBackResult,
                } : {})}
                navigationKey={props.navigationKey}
                navigationCommand={frameNavigationCommand}
                diagnostics={props.diagnostics}
                testID="plugin-hosted-web-frame"
            />
        </PluginSurfaceInteractionBoundary>
    );
}
