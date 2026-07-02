import * as React from 'react';
import { Platform } from 'react-native';
import type { PluginHostedWebBridgeEnvelopeV1 } from '@happier-dev/protocol';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { PluginHostedWebFrame } from './PluginHostedWebFrame';
import { PluginHostedWebUnavailable } from './PluginHostedWebUnavailable';
import type { PluginHostedWebSandboxPolicy } from './sandbox';

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

function canRenderHostedWebEndpoint(params: Readonly<{
    url: URL | null;
    platform: PluginHostedWebPanePlatform;
    expiresAt?: number | null;
    nowMs: number;
}>): boolean {
    if (!params.url) {
        return false;
    }
    if (typeof params.expiresAt === 'number' && params.expiresAt <= params.nowMs) {
        return false;
    }
    if (params.platform !== 'web' && isDaemonLoopbackHost(params.url.hostname)) {
        return false;
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

function readRouteMode(value: unknown): 'hostOrigin' | 'pathFallback' | null {
    const routeMode = readRecord(value)?.routeMode;
    return routeMode === 'hostOrigin' || routeMode === 'pathFallback' ? routeMode : null;
}

function readAllowedMessageKinds(value: unknown): readonly string[] {
    const allowedMessages = readRecord(value)?.allowedMessages;
    if (!Array.isArray(allowedMessages)) {
        return [];
    }
    return allowedMessages.filter((kind): kind is string => typeof kind === 'string' && kind.length > 0);
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

function createBridgeNonce(): string {
    const random = globalThis.crypto?.randomUUID?.();
    if (random) return random;
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    bridgeNonce?: string;
    onBridgeMessage?: (envelope: PluginHostedWebBridgeEnvelopeV1) => void;
}>): React.ReactElement {
    const descriptor = props.pluginUiProjection?.hostedWebById[props.contributionId];
    const endpoint = readEndpointUrl(props.endpointUrl);
    const platform = resolvePlatform(props.platform);
    const sandbox = descriptor ? readSandboxPolicy(descriptor.sandbox) : null;
    const bridgeNonce = React.useMemo(() => props.bridgeNonce ?? createBridgeNonce(), [props.bridgeNonce]);

    if (!descriptor || !sandbox || !endpoint || !canRenderHostedWebEndpoint({
        url: endpoint,
        platform,
        expiresAt: props.expiresAt,
        nowMs: props.nowMs?.() ?? Date.now(),
    })) {
        return <PluginHostedWebUnavailable />;
    }

    const allowedMessageKinds = readAllowedMessageKinds(descriptor.bridge);
    const bridge = props.onBridgeMessage && allowedMessageKinds.length > 0
        ? {
            expectedOrigin: endpoint.origin,
            expectedPluginId: descriptor.pluginId,
            expectedContributionId: descriptor.contributionId,
            expectedSurfaceId: props.surfaceId,
            expectedNonce: bridgeNonce,
            expectedSessionId: props.sessionId ?? null,
            allowedMessageKinds: new Set<string>(allowedMessageKinds),
            onMessage: props.onBridgeMessage,
        }
        : null;
    const frameUrl = bridge
        ? withBridgeQuery({
            endpoint,
            pluginId: descriptor.pluginId,
            contributionId: descriptor.contributionId,
            surfaceId: props.surfaceId,
            nonce: bridgeNonce,
            sessionId: props.sessionId,
        })
        : endpoint.toString();

    return (
        <PluginHostedWebFrame
            bridge={bridge}
            sandbox={resolveHostSandboxPolicy({ descriptor, endpoint, sandbox })}
            title={props.surfaceId}
            url={frameUrl}
            testID="plugin-hosted-web-frame"
        />
    );
}
