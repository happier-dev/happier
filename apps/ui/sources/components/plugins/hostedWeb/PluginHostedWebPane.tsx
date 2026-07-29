import * as React from 'react';
import { Platform } from 'react-native';
import {
    PluginHostedWebSecurityPolicyV1Schema,
    type PluginHostedWebSecurityPolicyV1,
    PluginHostedWebBridgeEnvelopeV1,
    type PluginSessionResourceTargetV1,
    PluginUiChannelV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiPlatformV1,
    PluginUiSurfacePlacementV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    canRenderPluginUiProjectionEntry,
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type {
    BrowserDiagnosticsEngineBridgeConfig,
    BrowserFrameNavigationCommand,
} from '@/components/browser/frame/types';
import { resolvePluginUiText } from '@/sync/domains/plugins/ui/i18n';

import { PluginHostedWebFrame } from './PluginHostedWebFrame';
import { PluginHostedWebUnavailable } from './PluginHostedWebUnavailable';
import type { PluginHostedWebSandboxPolicy } from './sandbox';
import {
    createPluginHostedWebHostApiBridgeHandler,
    type PluginHostedWebHostApiBridgeHandler,
} from '@/components/plugins/hostApi/hostedWebAdapter';
import { PluginSurfaceInteractionBoundary } from '@/components/plugins/shared/PluginSurfaceInteractionBoundary';

type PluginHostedWebPanePlatform = 'web' | 'ios' | 'android' | 'desktop';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
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

function isDaemonLoopbackHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
        return true;
    }
    if (/^127(?:\.[0-9]{1,3}){3}$/.test(normalized)) {
        return true;
    }
    if (normalized === '::1' || normalized === '[::1]') {
        return true;
    }
    if (normalized.startsWith('::ffff:127.') || normalized.startsWith('[::ffff:127.')) {
        return true;
    }
    if (normalized.startsWith('::ffff:7f') || normalized.startsWith('[::ffff:7f')) {
        return true;
    }
    return false;
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
    expiresAt?: number | null;
    nowMs: number;
    security?: PluginHostedWebSecurityPolicyV1 | null;
    channel?: PluginUiChannelV1;
    isDevBuildOverride?: boolean;
}>): boolean {
    if (!params.url) {
        return false;
    }
    if (typeof params.expiresAt === 'number' && params.expiresAt <= params.nowMs) {
        return false;
    }
    if (params.platform !== 'web' && isDaemonLoopbackHost(params.url.hostname)) {
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

function readRouteMode(value: unknown): 'hostOrigin' | 'pathFallback' | null {
    const routeMode = readRecord(value)?.routeMode;
    return routeMode === 'hostOrigin' || routeMode === 'pathFallback' ? routeMode : null;
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

function canRenderProjectedHostedWebRuntime(value: unknown): boolean {
    const runtime = readRecord(value);
    return runtime?.state === 'available';
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

function resolveHostSandboxPolicy(params: Readonly<{
    descriptor: Record<string, unknown>;
    endpoint: URL;
    sandbox: PluginHostedWebSandboxPolicy;
}>): PluginHostedWebSandboxPolicy {
    const routeMode = readRouteMode(params.descriptor.entry);
    const sameOriginAllowed = params.sandbox.sameOrigin
        && routeMode === 'hostOrigin'
        && params.endpoint.protocol === 'https:';
    return {
        ...params.sandbox,
        sameOrigin: sameOriginAllowed,
    };
}

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

function withBridgeQuery(input: Readonly<{
    endpoint: URL;
    pluginId: string;
    contributionId: string;
    surfaceId: string;
    nonce: string;
    sessionId?: string | null;
}>): string {
    const url = new URL(input.endpoint.toString());
    url.searchParams.set('happierBridgeNonce', input.nonce);
    url.searchParams.set('happierPluginId', input.pluginId);
    url.searchParams.set('happierContributionId', input.contributionId);
    url.searchParams.set('happierSurfaceId', input.surfaceId);
    if (input.sessionId) {
        url.searchParams.set('happierSessionId', input.sessionId);
    }
    return url.toString();
}

export function PluginHostedWebPane(props: Readonly<{
    contributionId: string;
    surfaceId: string;
    pluginUiProjection: PluginUiProjectionModel | null | undefined;
    endpointUrl?: string | null;
    expiresAt?: number | null;
    nowMs?: () => number;
    platform?: PluginHostedWebPanePlatform;
    sessionId?: string | null;
    surfacePlacement?: PluginUiSurfacePlacementV1;
    resourceScope?: readonly PluginSessionResourceTargetV1[];
    navigationKey?: string;
    navigationCommand?: BrowserFrameNavigationCommand;
    diagnostics?: BrowserDiagnosticsEngineBridgeConfig;
    bridgeNonce?: string;
    readyTimeoutMs?: number | null;
    onBridgeMessage?: (envelope: PluginHostedWebBridgeEnvelopeV1) => void;
    hostApi?: Readonly<{
        platform: PluginUiPlatformV1;
        channel: PluginUiChannelV1;
        handleRequest: (
            request: PluginUiHostApiRequestEnvelopeV1,
        ) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;
    }>;
    interactionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
}>): React.ReactElement {
    const descriptor = props.pluginUiProjection?.hostedWebById[props.contributionId];
    const endpoint = readEndpointUrl(props.endpointUrl);
    const platform = resolvePlatform(props.platform);
    const policyContext = React.useMemo(() => createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform,
            channel: props.hostApi?.channel ?? 'internal',
        },
    ), [platform, props.hostApi?.channel, props.policyContext]);
    const projectionGeneration = props.pluginUiProjection?.generation ?? null;
    const sandbox = descriptor ? readSandboxPolicy(descriptor.sandbox) : null;
    const security = descriptor ? readSecurityPolicy(descriptor.security) : null;
    const bridgeNonce = React.useMemo(
        () => props.bridgeNonce ?? createBridgeNonce(),
        [projectionGeneration, props.bridgeNonce],
    );
    const allowedMessageKinds = descriptor ? readAllowedMessageKinds(descriptor.bridge) : [];
    const readyRequired = allowedMessageKinds.includes('ready');
    const [readyTimedOut, setReadyTimedOut] = React.useState(false);
    const interactionEnabled = props.interactionEnabled ?? Boolean(props.hostApi);
    const hostApiBridgeHandler = React.useMemo<PluginHostedWebHostApiBridgeHandler | null>(() => {
        if (!descriptor) return null;
        return createPluginHostedWebHostApiBridgeHandler({
            surface: {
                pluginId: descriptor.pluginId,
                contributionId: descriptor.contributionId,
                surfaceId: props.surfaceId,
                sessionId: props.sessionId ?? undefined,
                placement: props.surfacePlacement ?? 'sessionPane',
                platform: props.hostApi?.platform ?? (platform === 'desktop' ? 'web' : platform),
                channel: props.hostApi?.channel ?? 'internal',
                resourceScope: [...(props.resourceScope ?? [])],
                diagnostics: [],
            },
            requestIdPrefix: `hostedWeb:${descriptor.pluginId}:${descriptor.contributionId}`,
            handleRequest: interactionEnabled ? props.hostApi?.handleRequest : undefined,
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
    }, [
        descriptor,
        interactionEnabled,
        platform,
        // A new daemon generation owns a new ready/subscription lifetime even
        // when its projected descriptor bytes are referentially unchanged.
        projectionGeneration,
        props.hostApi,
        props.resourceScope,
        props.sessionId,
        props.surfaceId,
        props.surfacePlacement,
    ]);
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
        props.onBridgeMessage?.(envelope);
        return hostApiBridgeHandler?.(envelope);
    }, [hostApiBridgeHandler, props.onBridgeMessage]);
    const bridgeRequested = Boolean((props.onBridgeMessage || hostApiBridgeHandler) && allowedMessageKinds.length > 0);

    if (!descriptor
        || !canRenderPluginUiProjectionEntry(descriptor, policyContext)
        || !canRenderProjectedHostedWebRuntime(descriptor.runtime)
        || !sandbox
        || !security
        || !canEnforceHostedWebSecurityPolicy({ descriptor, security, channel: props.hostApi?.channel })
        || !endpoint
        || (bridgeRequested && !bridgeNonce)
        || readyTimedOut
        || !canRenderHostedWebEndpoint({
        url: endpoint,
        platform,
        expiresAt: props.expiresAt,
        nowMs: props.nowMs?.() ?? Date.now(),
        security,
        channel: props.hostApi?.channel,
    })) {
        return <PluginHostedWebUnavailable />;
    }

    const bridge = bridgeRequested && bridgeNonce
        ? {
            expectedOrigin: endpoint.origin,
            expectedPluginId: descriptor.pluginId,
            expectedContributionId: descriptor.contributionId,
            expectedSurfaceId: props.surfaceId,
            expectedNonce: bridgeNonce,
            expectedSessionId: props.sessionId ?? null,
            allowedMessageKinds: new Set<string>(allowedMessageKinds),
            onMessage: handleBridgeMessage,
        }
        : null;
    const frameUrl = bridge
        ? withBridgeQuery({
            endpoint,
            pluginId: descriptor.pluginId,
            contributionId: descriptor.contributionId,
            surfaceId: props.surfaceId,
            nonce: bridge.expectedNonce,
            sessionId: props.sessionId,
        })
        : endpoint.toString();
    const display = readRecord(descriptor.display);
    const frameTitle = resolvePluginUiText({
        projection: props.pluginUiProjection,
        pluginId: descriptor.pluginId,
        key: typeof display?.titleKey === 'string' ? display.titleKey : null,
        fallback: typeof display?.developerFallback === 'string'
            ? display.developerFallback
            : props.surfaceId,
    });

    return (
        <PluginSurfaceInteractionBoundary
            surfaceId={props.surfaceId}
            snapshotTitle={frameTitle}
            enabled={interactionEnabled}
        >
            <PluginHostedWebFrame
                key={projectionGeneration ?? 'unversioned'}
                bridge={bridge}
                security={security}
                sandbox={resolveHostSandboxPolicy({ descriptor, endpoint, sandbox })}
                title={frameTitle}
                url={frameUrl}
                navigationKey={props.navigationKey}
                navigationCommand={props.navigationCommand}
                diagnostics={props.diagnostics}
                testID="plugin-hosted-web-frame"
            />
        </PluginSurfaceInteractionBoundary>
    );
}
