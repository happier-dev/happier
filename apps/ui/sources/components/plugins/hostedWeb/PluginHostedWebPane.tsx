import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1,
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
    type PluginUiArtifactDigestV1,
    type PluginHostedHtmlSourceV1,
    type UiSurfaceNetworkOriginV1,
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
import { resolveHostedWebRuntimeDiagnostics } from '@/sync/domains/plugins/ui/hostedWebRuntime';
import type { PluginUiArtifactAdoption } from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { BrowserFrameError } from '@/components/browser/frame/BrowserFrameError';
import { BrowserFrameLoading } from '@/components/browser/frame/BrowserFrameLoading';
import type { SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { isLoopbackHostedWebUrl } from '@/components/browser/adapters/HostedPluginTargetSecurity';
import { createInlineHostedHtmlSecurityPolicy } from '@/components/browser/adapters/HostedPluginTargetSecurity';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    createPluginSurfaceContext,
    getPluginSurfaceTargetAuthorityKey,
    usePluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';

import { HostedFrameHost } from '@/components/ui/surfaces/framed/HostedFrameHost';
import {
    useHostedFrameLifecycle,
    type HostedFrameFailure,
} from '@/components/ui/surfaces/framed/useHostedFrameLifecycle';
import { resolveHostedFrameHostOrigin } from '@/components/ui/surfaces/framed/hostOrigin';
import {
    PluginHostedWebUnavailable,
    readPluginHostedWebUnavailableDiagnosticCode,
    type PluginHostedWebUnavailableDiagnosticCode,
} from './PluginHostedWebUnavailable';
import type { PluginHostedWebSandboxPolicy } from './sandbox';
import {
    createPluginHostedWebHostApiBridgeHandler,
    type PluginHostedWebHostApiBridgeHandler,
    type PluginHostedWebAccountDataBridgeFactory,
    type PluginHostedWebHostApiRequestHandler,
    type PluginHostedWebHostMessageSink,
    type PluginHostedWebComposerSubscriptionPublisher,
} from '@/components/plugins/hostApi/hostedWebAdapter';
import { createHostedFrameIntrinsicHeightReporter } from '@/components/plugins/hostApi/hostedFrameIntrinsicHeight';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { RouteRemovalStepConsumer } from '@/utils/navigation/RouteRemovalStepConsumer';
import { useUiSurfaceRendererMount } from '@/components/plugins/hostApi/useUiSurfaceRendererMount';
import { measureWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';

type PluginHostedWebPanePlatform = 'web' | 'ios' | 'android' | 'desktop';
const INLINE_DOCUMENT_SANDBOX: PluginHostedWebSandboxPolicy = Object.freeze({
    scripts: true, sameOrigin: false, popups: false, topNavigation: false, mixedContent: false,
});
const INLINE_DOCUMENT_MESSAGES = Object.freeze(['ready', 'error', 'heightChanged', 'hostApi']);

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

type HostedWebBridgeCorrelation = Readonly<{
    identity: PluginUiHostApiWireIdentityV1;
}>;

function appendBridgeCorrelation(query: URLSearchParams, input: HostedWebBridgeCorrelation): void {
    query.set('happierBridgeNonce', input.identity.mountNonce);
    query.set('happierInstanceId', input.identity.instanceId);
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
    frameFailure: HostedFrameFailure | null;
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
    if (input.frameFailure === 'ready_timeout') {
        return resolveDownstreamDiagnostic('hosted_web_bridge_timeout');
    }
    if (input.frameFailure) {
        return resolveDownstreamDiagnostic('hosted_web_preview_unavailable');
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
    /** Already-admitted by-value source; it has no Artifact or service descriptor. */
    inlineDocument?: PluginHostedHtmlSourceV1;
    /** Exact normalized egress request written into this document's CSP. */
    inlineDocumentNetworkOrigins?: readonly UiSurfaceNetworkOriginV1[];
    title?: string;
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
    /** Retry the incumbent exact Artifact acquisition/issuance without changing source ownership. */
    onUnavailableRetry?: () => void;
    /** Existing route-owned recovery callback for settings/update/enable actions. */
    unavailableAction?: SurfaceStateAction;
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
    mountLifetime: Parameters<typeof useUiSurfaceRendererMount>[0]['lifetime'];
    readyTimeoutMs?: number | null;
    onBridgeMessage?: (envelope: PluginHostedWebBridgeEnvelopeV1) => void;
    /** Validated current-mount content height; the outer placement owns sizing. */
    onIntrinsicHeightChange?: (height: number) => void;
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
        authorPlugin: Readonly<{ id: string; version: string }>;
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
    createAccountDataBridge?: PluginHostedWebAccountDataBridgeFactory;
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
    /**
     * Exact facts captured with the incumbent adoption. They are presentation
     * evidence only: the Artifact handle remains the currentness/custody owner.
     */
    nativeArtifactLoadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactDigest: PluginUiArtifactDigestV1;
    }> | null;
    /** Candidate-adoption callbacks; omitted for already-applied ordinary frames. */
    onArtifactCandidateReady?: () => void;
    onArtifactCandidateFailure?: (code: string) => void;
    /** The outer adoption transaction carries a pending handle across the presentation swap. */
    retainCandidateAdoptionOnUnmount?: boolean;
    /** Candidate frames may load, but cannot use live host mutation authority before adoption. */
    artifactCandidatePreparing?: boolean;
}>): React.ReactElement {
    const { theme, rt } = useUnistyles();
    const descriptor = props.projectedContribution === undefined
        ? props.pluginUiProjection?.hostedWebById[props.contributionId]
        : props.projectedContribution;
    const hasDescriptor = descriptor !== null && descriptor !== undefined;
    const platform = resolvePlatform(props.platform);
    const interactionEnabled = props.interactionEnabled ?? Boolean(props.hostApi);
    const effectiveInteractionEnabled = interactionEnabled && props.focusEligible !== false;
    const inlineDocument = props.inlineDocument;
    const occurrenceId = typeof descriptor?.occurrenceId === 'string'
        ? descriptor.occurrenceId
        : null;
    const launchInputSemanticKey = stableJsonStringify({
        present: props.launchInput !== undefined,
        value: props.launchInput,
    });
    const rendererDocumentKey = React.useMemo(() => stableJsonStringify({
        endpointUrl: props.endpointUrl,
        html: inlineDocument?.html,
        networkOrigins: props.inlineDocumentNetworkOrigins,
        launchInputSemanticKey,
        occurrenceId,
        mountInstanceKey: props.mountInstanceKey,
        subPath: props.subPath,
    }), [props.endpointUrl, inlineDocument?.html, props.inlineDocumentNetworkOrigins, launchInputSemanticKey, occurrenceId, props.mountInstanceKey, props.subPath]);
    const allowedMessageKinds = inlineDocument ? INLINE_DOCUMENT_MESSAGES : descriptor ? readAllowedMessageKinds(descriptor.bridge) : [];
    const canonicalHostOrigin = resolveHostedFrameHostOrigin();
    const canonicalWireAllowed = allowedMessageKinds.includes('hostApi');
    const readyRequired = Boolean(props.canonicalHostApi && canonicalWireAllowed && canonicalHostOrigin)
        || allowedMessageKinds.includes('ready');
    const frameSinkRef = React.useRef<((message: unknown) => void) | null>(null);
    const hostApiBridgeHandlerRef = React.useRef<PluginHostedWebHostApiBridgeHandler | null>(null);
    const lifecycle = useHostedFrameLifecycle({
        lifetimeKey: rendererDocumentKey,
        readyRequired,
        readyTimeoutMs: props.readyTimeoutMs,
        onReadyTimeout: () => { hostApiBridgeHandlerRef.current?.recordReadyTimeout(); },
        onRetireAttempt: (reason) => {
            if (reason === 'unexpected_navigation') frameSinkRef.current = null;
            hostApiBridgeHandlerRef.current?.dispose();
            frameSinkRef.current = null;
        },
    });
    const rendererMount = useUiSurfaceRendererMount({
        lifetime: props.mountLifetime,
        mountKey: `${rendererDocumentKey}\u001f${lifecycle.attempt}`,
        interactionEnabled,
        focusEligible: props.focusEligible !== false,
    });
    const bridgeIdentity = rendererMount.identity;
    const bridgeNonce = bridgeIdentity?.mountNonce ?? null;
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
    const onIntrinsicHeightChangeRef = React.useRef(props.onIntrinsicHeightChange);
    onIntrinsicHeightChangeRef.current = props.onIntrinsicHeightChange;
    const artifactCurrentnessRef = React.useRef<PluginHostedWebArtifactCurrentness | null>(null);
    const isSurfaceCurrent = React.useCallback(() => {
        if (props.artifactCandidatePreparing) return false;
        if (!rendererMount.isCurrent() || !(isCurrentRef.current?.() ?? true)) return false;
        try {
            return artifactCurrentnessRef.current?.isCurrent() ?? true;
        } catch {
            return false;
        }
    }, [props.artifactCandidatePreparing, rendererMount.isCurrent]);
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
    const sandbox = inlineDocument ? INLINE_DOCUMENT_SANDBOX : hasDescriptor ? readSandboxPolicy(descriptor.sandbox) : null;
    const security = inlineDocument
        ? createInlineHostedHtmlSecurityPolicy(props.inlineDocumentNetworkOrigins ?? [])
        : hasDescriptor ? readSecurityPolicy(descriptor.security) : null;
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
    const [nativeInlineDocumentUnavailable, setNativeInlineDocumentUnavailable] = React.useState(false);
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
            // Target/occurrence replacement owns the consumed handle's normal
            // teardown. This executes in layout cleanup before a replacement
            // frame is committed, so stale bytes cannot remain mounted.
            if (!props.retainCandidateAdoptionOnUnmount) disposeForTarget();
        };
    }, [nativeArtifactAdoption, occurrenceId, props.mountInstanceKey, props.retainCandidateAdoptionOnUnmount]);
    React.useLayoutEffect(() => {
        setNativeInlineDocumentUnavailable(false);
    }, [rendererDocumentKey]);
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
    const handleNativeHostedHtmlUnavailable = React.useCallback(() => {
        setNativeInlineDocumentUnavailable(true);
        lifecycle.fail('load_failed');
    }, [lifecycle.fail]);
    const handleNativeArtifactLoadStart = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactFrameLoadStateForHandle({ handle, state: 'loading' });
    }, [nativeArtifactHandle]);
    const handleNativeArtifactLoadEnd = React.useCallback(() => {
        const handle = nativeArtifactHandle;
        if (!handle || artifactCurrentnessRef.current !== handle || !handle.isCurrent()) return;
        setNativeArtifactFrameLoadStateForHandle({ handle, state: 'ready' });
        lifecycle.markLoaded();
        props.onArtifactCandidateReady?.();
    }, [lifecycle.markLoaded, nativeArtifactHandle, props.onArtifactCandidateReady]);
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
        // The native mount has failed and this render transitions off it. Retire
        // the adoption/bridge lifetime synchronously with that transition so no
        // late guest, bridge, or history work can settle through the dead frame.
        const code = readNativeArtifactLoadErrorCode(event);
        if (props.onArtifactCandidateFailure) props.onArtifactCandidateFailure(code);
        else nativeArtifactAdoption?.dispose();
        lifecycle.fail('load_failed');
    }, [lifecycle.fail, nativeArtifactAdoption, nativeArtifactHandle, props.onArtifactCandidateFailure]);
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
    // The nonce is the guest's address proof for exactly one bound frame, so its
    // lifetime must cover every fact that replaces the guest document. The bound
    // page location is one of them: `bridgeLifetimeKey` below already re-keys the
    // frame on it, so without it here the document minted for the previous page
    // would hand its still-valid nonce to the document that replaces it.
    // §3.2/§3.3/UI-D11: one context owner. This mount no longer builds its own
    // snapshot from its own copy of the environment hooks — it composes the same
    // `SurfaceContext` the React Native mount receives, so the two can no longer
    // disagree about target, theme, locale or accessibility facts.
    const canonicalHostApi = React.useMemo(() => {
        const binding = props.canonicalHostApi;
        if (!binding || !bridgeIdentity || !canonicalWireAllowed || !canonicalHostOrigin) return undefined;
        return Object.freeze({
            identity: bridgeIdentity,
            authorPlugin: binding.authorPlugin,
            methods: binding.methods,
            target: binding.target,
            activity: Object.freeze({ active: effectiveInteractionEnabled && isSurfaceCurrent() }),
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
        bridgeIdentity,
        canonicalWireAllowed,
        props.canonicalHostApi,
        effectiveInteractionEnabled,
        isSurfaceCurrent,
        surfaceEnvironment,
    ]);
    // Collection UI-query messages are meaningful only once the canonical
    // hosted bootstrap exists. A descriptor cannot expose Data by declaring a
    // message kind alone: without hostApi there is no single ready/currentness
    // lifecycle or private guest bootstrap carrier to consume it.
    const accountDataMessageAllowed = canonicalHostApi !== undefined
        && allowedMessageKinds.includes(PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1);
    const accountDataBridgeAllowed = accountDataMessageAllowed
        && props.createAccountDataBridge !== undefined;
    // `ready` is an internal lifecycle handshake for the canonical host API,
    // not an author-selected bridge method. A canonical frame cannot receive its
    // post-ready bootstrap without it, even when the declared author vocabulary
    // contains only `hostApi`.
    const bridgeAllowedMessageKinds = React.useMemo(() => {
        const kinds = new Set<string>(allowedMessageKinds);
        if (canonicalHostApi) kinds.add('ready');
        if (!accountDataMessageAllowed) {
            kinds.delete(PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1);
        }
        return kinds;
    }, [allowedMessageKinds, canonicalHostApi, accountDataMessageAllowed]);
    // EU-8: the mounted frame lends its host->frame delivery primitive here for
    // as long as it is mounted. The registry is a ref, not state, so attaching a
    // frame never re-creates the bridge handler — a handler churn would retire
    // the guest's subscriptions on every render.
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
    const hostedFrameBoundsRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const getHostedFrameBounds = React.useCallback(() => measureWindowBounds(toTreeDropMeasurableRef(hostedFrameBoundsRef.current)), []);
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
            return request.method === 'updateEntityDragDrop'
                ? current(request, { ...options, getHostedFrameBounds })
                : options === undefined ? current(request) : current(request, options);
        },
        [getHostedFrameBounds],
    );
    const canonicalBindingKey = canonicalHostApi
        ? [
            canonicalHostApi.identity.instanceId,
            canonicalHostApi.identity.mountNonce,
            getPluginSurfaceTargetAuthorityKey(canonicalHostApi.target),
            canonicalHostApi.surface.targetedContributions.target.pluginId,
            canonicalHostApi.surface.targetedContributions.target.occurrenceId,
        ].join('')
        : null;
    const frameOrigin = (inlineDocument ? 'null' : null)
        ?? nativeArtifactFrame?.frameOrigin
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
        occurrenceId,
        handleRequestInstalled,
        accountDataBridgeAllowed,
        surfaceIdentity: bridgeSurfaceIdentityKey,
    });
    const heightReporter = React.useMemo(() => createHostedFrameIntrinsicHeightReporter({
        publish: (height) => {
            if (isSurfaceCurrent()) onIntrinsicHeightChangeRef.current?.(height);
        },
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
    }), [bridgeLifetimeKey, isSurfaceCurrent]);
    React.useLayoutEffect(() => () => heightReporter.dispose(), [heightReporter]);
    const accountDataBridgeFactoryRef = React.useRef<PluginHostedWebAccountDataBridgeFactory | undefined>(undefined);
    accountDataBridgeFactoryRef.current = accountDataBridgeAllowed
        ? props.createAccountDataBridge
        : undefined;
    const createAccountDataBridge = React.useCallback<PluginHostedWebAccountDataBridgeFactory>((input) => {
        const factory = accountDataBridgeFactoryRef.current;
        if (!factory) {
            throw new Error('Plugin hosted-web collection UI-query bridge is unavailable.');
        }
        return factory(input);
    }, []);
    const hostApiBridgeHandler = React.useMemo<PluginHostedWebHostApiBridgeHandler | null>(() => {
        if ((!descriptor && !inlineDocument) || !bridgeIdentity) return null;
        const binding = canonicalHostApi;
        return createPluginHostedWebHostApiBridgeHandler({
            surface: props.surfaceContext,
            requestIdPrefix: `hosted:${bridgeIdentity.instanceId}`,
            identity: bridgeIdentity,
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
            ...(accountDataBridgeAllowed
                ? { createAccountDataBridge }
                : {}),
            isCurrent: isSurfaceCurrent,
            ...(handleRequestInstalled ? { handleRequest } : {}),
            onReadyStateChange: (state) => {
                if (state.state === 'ready') lifecycle.markReady();
            },
            onGuestError: () => lifecycle.fail('guest_error'),
            onHeightChanged: (height) => {
                if (onIntrinsicHeightChangeRef.current) heightReporter.report(height);
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
        accountDataBridgeAllowed,
        createAccountDataBridge,
        heightReporter,
        isSurfaceCurrent,
        props.accountLifetime,
        lifecycle.fail,
        lifecycle.markReady,
    ]);
    React.useLayoutEffect(() => {
        hostApiBridgeHandlerRef.current = hostApiBridgeHandler;
    }, [hostApiBridgeHandler]);
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
        const signal = rendererMount.signal;
        const retire = () => lifecycle.retire();
        signal.addEventListener('abort', retire, { once: true });
        if (signal.aborted) retire();
        return () => signal.removeEventListener('abort', retire);
    }, [lifecycle.retire, rendererMount.signal]);
    const handleOpaqueArtifactUnexpectedNavigation = React.useCallback(() => {
        lifecycle.fail('unexpected_navigation');
    }, [lifecycle.fail]);
    React.useLayoutEffect(() => {
        const handle = artifactCurrentness;
        if (!handle) return;
        const retire = () => {
            // Source revocation synchronously closes admission and reaches the
            // incumbent bridge handler while its exact frame sink is still
            // attached. The following React update only removes presentation;
            // it is not a second retirement owner.
            lifecycle.retire();
            setNativeArtifactFrameEnabled(false);
        };
        const subscription = handle.onRevoke(retire);
        if (!handle.isCurrent()) retire();
        return () => subscription.dispose();
    }, [artifactCurrentness, lifecycle.retire, nativeArtifactHandle]);
    const attachHostMessages = React.useCallback((send: (message: unknown) => void) => {
        frameSinkRef.current = send;
        return () => {
            // Dispose through the one bridge owner while this exact sink is
            // still lent. React deletes a keyed replacement frame before the
            // parent mount-abort cleanup, so waiting for that abort would clear
            // the sink before the canonical terminal packet can reach the old
            // guest. Disposal is lifetime-idempotent and terminal delivery is
            // the one operation intentionally allowed after currentness closes.
            lifecycle.retire();
            if (frameSinkRef.current === send) frameSinkRef.current = null;
        };
    }, [hostApiBridgeHandler, lifecycle.retire]);
    // The context producer for this transport (UI-D03), the hosted-web twin of
    // `PluginSurfaceHost`'s. An identical snapshot is not republished, so the
    // push that runs at mount is not a spurious event.
    React.useEffect(() => {
        const surface = canonicalHostApi?.surface;
        if (hostApiBridgeHandler && surface) {
            hostApiBridgeHandler.pushSurfaceContext(surface, canonicalHostApi.activity);
        }
    }, [canonicalHostApi?.activity, canonicalHostApi?.surface, hostApiBridgeHandler]);
    // EU-4b: the mount's one invalidation sink reaches this transport's push
    // channel. The subscription registry stays the bridge handler's.
    const subscribeResourceInvalidations = props.subscribeResourceInvalidations;
    React.useEffect(() => {
        if (!hostApiBridgeHandler || !subscribeResourceInvalidations) return;
        return subscribeResourceInvalidations((event) => {
            hostApiBridgeHandler.publishResourceSubscriptionEvent(event);
        });
    }, [hostApiBridgeHandler, subscribeResourceInvalidations]);
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
    const projectionPolicyRenderable = Boolean(inlineDocument) || hasDescriptor
        && canRenderPluginUiProjectionEntry(descriptor, policyContext);
    const runtimeRenderable = Boolean(inlineDocument) || hasDescriptor
        && canRenderProjectedHostedWebRuntime(
            descriptor.runtime,
            hasDaemonEndpointFrame || hasNativeArtifactSource,
        );
    const securityEnforceable = Boolean(inlineDocument) || hasDescriptor
        && security !== null
        && canEnforceHostedWebSecurityPolicy({ descriptor, security, channel: props.hostApi?.channel });
    const endpointRenderable = Boolean(inlineDocument) || hasNativeArtifactSource || canRenderHostedWebEndpoint({
        url: endpoint,
        platform,
        security,
        channel: props.hostApi?.channel,
    });
    const unavailableDiagnosticCode = resolveHostedWebPaneUnavailableDiagnosticCode({
        upstreamDiagnosticCode: upstreamUnavailableDiagnosticCode,
        descriptorPresent: hasDescriptor || inlineDocument !== undefined,
        projectionPolicyRenderable,
        runtimeRenderable,
        hasDaemonEndpointFrame,
        hasSource: inlineDocument !== undefined || hasDaemonEndpointFrame || hasNativeArtifactSource,
        nativeArtifactAdapterUnavailable: nativeArtifactAdapterUnavailable || nativeInlineDocumentUnavailable,
        sandboxAvailable: sandbox !== null,
        securityAvailable: security !== null,
        securityEnforceable,
        frameOriginAvailable: Boolean(frameOrigin),
        bridgeRequested,
        bridgeNonceAvailable: Boolean(bridgeNonce),
        frameFailure: lifecycle.failure,
        endpointRenderable,
    });

    // A mounted native Artifact frame that reported a load failure is the exact
    // terminal reason for this surface, and it is decided before the generic
    // resolver: retiring the failed mount's adoption necessarily removes its
    // frame origin, which the generic resolver would otherwise report as a
    // less truthful "no source" state.
    if (nativeArtifactHandle && typeof nativeArtifactFrameLoadState !== 'string') {
        if (props.targetedFallback !== undefined) {
            return <>{props.targetedFallback}</>;
        }
        return (
            <BrowserFrameError
                testID="plugin-hosted-web-frame"
                errorCode={nativeArtifactFrameLoadState.code}
                onReload={props.onUnavailableRetry ?? lifecycle.reload}
            />
        );
    }

    // The bounded resolver above owns every remaining terminal reason. Retain
    // the direct presence guard so TypeScript narrows the render-only values
    // below without introducing a second policy/currentness decision.
    if ((unavailableDiagnosticCode && !nativeArtifactHandle) || (!descriptor && !inlineDocument) || !sandbox || !security || !frameOrigin) {
        if (unavailableDiagnosticCode && props.targetedFallback !== undefined) {
            return <>{props.targetedFallback}</>;
        }
        return (
            <PluginHostedWebUnavailable
                diagnosticCode={unavailableDiagnosticCode}
                onRetry={lifecycle.failure ? lifecycle.reload : props.onUnavailableRetry}
                recoveryAction={props.unavailableAction}
            />
        );
    }

    if (nativeArtifactActivationPending) {
        return <BrowserFrameLoading testID="plugin-hosted-web-frame" />;
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
    const bridge = bridgeRequested && bridgeIdentity
        ? {
            expectedOrigin: frameOrigin,
            identity: bridgeIdentity,
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
                    identity: bridge.identity,
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
                    identity: bridge.identity,
                    hostOrigin: canonicalHostOrigin,
                })
                : '/',
        })
        : null;
    const nativeArtifact = platform === 'desktop' ? null : artifactFrameInput;
    const desktopArtifact = platform === 'desktop' ? artifactFrameInput : null;
    const display = readRecord(descriptor?.display);
    const literalTitle = typeof display?.title === 'string' && display.title.trim().length > 0
        ? display.title.trim()
        : null;
    const frameTitle = props.title ?? literalTitle ?? resolvePluginUiText({
        projection: props.pluginUiProjection,
        pluginId: props.surfaceContext.pluginId,
        // Without the current locale the shared resolver answers from the
        // plugin's English bundle no matter what the reader selected.
        locale: getPreferredLanguage(),
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
    const nativeArtifactLoadedRuntimeIdentity = props.nativeArtifactLoadedRuntimeIdentity;
    const nativeArtifactReadyDiagnosticTestID = nativeArtifact
        && nativeArtifactFramePresentationState === 'ready'
        && nativeArtifactHandle?.isCurrent()
        && isSurfaceCurrent()
        && nativeArtifactLoadedRuntimeIdentity
        && nativeArtifactLoadedRuntimeIdentity.pluginId === descriptor?.pluginId
        && nativeArtifactLoadedRuntimeIdentity.contributionId === descriptor?.contributionId
        ? [
            'plugin-hosted-web-native-ready',
            nativeArtifactLoadedRuntimeIdentity.pluginId,
            nativeArtifactLoadedRuntimeIdentity.contributionId,
            nativeArtifactLoadedRuntimeIdentity.artifactDigest,
        ].join(':')
        : null;

    return (
        <PluginSurfaceInteractionBoundary
            surfaceId={surface.surfaceId}
            snapshotTitle={frameTitle}
            enabled={interactionEnabled}
            focusEligible={props.focusEligible}
        >
            {/*
                The guest's own history, spent before the route leaves. The
                physical hosted mount has already selected the exact platform in
                `active`; checking ambient React Native `Platform` here would
                create a second platform authority that can disagree with an
                injected or native renderer.
            */}
            <RouteRemovalStepConsumer
                active={platform === 'ios' && effectiveInteractionEnabled && nativeArtifactGuestHistoryActive}
                consume={requestNativeArtifactGoBack}
            />
            <View
                ref={hostedFrameBoundsRef}
                testID={nativeArtifactReadyDiagnosticTestID ?? undefined}
                accessible={false}
                collapsable={false}
                style={styles.nativeArtifactReadyDiagnosticRoot}
            >
            <HostedFrameHost
                key={[
                    occurrenceId ?? 'unversioned',
                    props.mountInstanceKey ?? 'legacy',
                    nativeArtifact?.artifactHandleToken ?? desktopArtifact?.artifactHandleToken ?? 'daemon-frame',
                    bridgeLifetimeKey,
                    lifecycle.attempt,
                ].join('\u001f')}
                bridge={bridge}
                security={security}
                sandbox={sandbox}
                title={frameTitle}
                {...(frameUrl ? { url: frameUrl } : {})}
                {...(inlineDocument && bridgeIdentity && canonicalHostOrigin ? {
                    html: inlineDocument.html,
                    networkOrigins: props.inlineDocumentNetworkOrigins,
                    bootstrapConfig: { identity: bridgeIdentity, frameOrigin: 'null', hostOrigin: canonicalHostOrigin },
                    onUnexpectedNavigation: handleOpaqueArtifactUnexpectedNavigation,
                    onNativeHostedHtmlUnavailable: handleNativeHostedHtmlUnavailable,
                } : {})}
                {...(opaqueArtifactFrame ? {
                    opaqueArtifactFrame: true,
                    onUnexpectedNavigation: handleOpaqueArtifactUnexpectedNavigation,
                } : {})}
                {...(nativeArtifact ? { nativeArtifact } : {})}
                {...(desktopArtifact ? { desktopArtifact } : {})}
                {...(nativeArtifact || desktopArtifact ? { onNativeArtifactUnavailable: handleNativeArtifactUnavailable } : {})}
                {...(nativeArtifact || desktopArtifact ? {
                    nativeArtifactLoadState: nativeArtifactFramePresentationState,
                    presentationEligible: effectiveInteractionEnabled,
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
                onLoad={() => {
                    lifecycle.markLoaded();
                    props.onArtifactCandidateReady?.();
                }}
                onError={() => {
                    props.onArtifactCandidateFailure?.('load_failed');
                    lifecycle.fail('load_failed');
                }}
                testID="plugin-hosted-web-frame"
            />
            </View>
        </PluginSurfaceInteractionBoundary>
    );
}

const styles = StyleSheet.create({
    nativeArtifactReadyDiagnosticRoot: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
});
