import { isLoopbackHostname, type PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol';

import type { PluginHostedWebSandboxPolicy } from '@/components/plugins/hostedWeb/sandbox';

export const DEFAULT_HOSTED_PLUGIN_SECURITY: PluginHostedWebSecurityPolicyV1 = {
    allowedNavigationOrigins: [],
    allowedCallbackOrigins: [],
    allowedConnectOrigins: [],
    csp: {
        connectSrc: 'selfOnly',
        allowDataUrls: false,
        allowBlobUrls: false,
        allowInlineStyles: false,
        allowEval: false,
    },
    sourceMaps: 'disabled',
    mixedContent: 'deny',
};

function parseHostedPluginTargetUrl(url: string): URL | null {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
    } catch {
        return null;
    }
}

export function isLoopbackHostedWebUrl(url: string): boolean {
    const parsed = parseHostedPluginTargetUrl(url);
    if (!parsed) {
        return false;
    }
    return isLoopbackHostname(parsed.hostname);
}

export function canLoadHostedPluginTargetUrl(input: Readonly<{
    security: PluginHostedWebSecurityPolicyV1;
    url: string;
}>): boolean {
    const parsed = parseHostedPluginTargetUrl(input.url);
    if (!parsed) {
        return false;
    }
    if (parsed.protocol === 'https:') {
        return true;
    }
    return input.security.mixedContent === 'devLoopbackOnly' && isLoopbackHostedWebUrl(input.url);
}

function canAllowTopNavigation(input: Readonly<{
    security: PluginHostedWebSecurityPolicyV1;
    url: URL;
}>): boolean {
    return input.security.allowedNavigationOrigins.includes(input.url.origin)
        || input.security.allowedCallbackOrigins.includes(input.url.origin);
}

export function resolveHostedPluginWebSandboxPolicy(input: Readonly<{
    sandbox: PluginHostedWebSandboxPolicy;
    security: PluginHostedWebSecurityPolicyV1;
    url: string;
}>): PluginHostedWebSandboxPolicy {
    const parsed = parseHostedPluginTargetUrl(input.url);
    // EU-8: an addressable origin is a TRANSPORT requirement, not an author
    // capability. A frame sandboxed without `allow-same-origin` has an opaque
    // origin, and BOTH bridge directions then fail in a real browser: the
    // guest's `postMessage` arrives with `origin: "null"` and the host's
    // inbound validator rejects it, while the host cannot address an exact
    // `targetOrigin` back — so it must never use `'*'` instead. That was
    // observed in Chromium, not inferred: every unit test on this path
    // fabricates `event.origin` and therefore could not see it.
    //
    // It is granted for the origins the HOST itself addresses — a secure origin,
    // or the daemon's own loopback static-asset server — and for nothing else.
    // `allow-scripts allow-same-origin` is only dangerous when the framed
    // document is same-origin with its EMBEDDER, which a plugin asset served
    // from a different origin never is. The author's remaining sandbox flags
    // (popups, top navigation, mixed content) keep their meaning untouched.
    const sameOrigin = Boolean(parsed
        && (parsed.protocol === 'https:' || isLoopbackHostedWebUrl(input.url)));
    const topNavigation = Boolean(parsed && input.sandbox.topNavigation && canAllowTopNavigation({
        security: input.security,
        url: parsed,
    }));
    const mixedContent = Boolean(
        input.sandbox.mixedContent
        && input.security.mixedContent === 'devLoopbackOnly'
        && isLoopbackHostedWebUrl(input.url),
    );
    return {
        ...input.sandbox,
        sameOrigin,
        topNavigation,
        mixedContent,
    };
}
