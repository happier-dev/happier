import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol';

import type { PluginHostedWebSandboxPolicy } from '@/components/plugins/hostedWeb/sandbox';

export const DEFAULT_HOSTED_PLUGIN_SECURITY: PluginHostedWebSecurityPolicyV1 = {
    allowedNavigationOrigins: [],
    allowedCallbackOrigins: [],
    allowedConnectOrigins: [],
    csp: {
        scriptSrc: 'selfOnly',
        styleSrc: 'selfOnly',
        imgSrc: 'selfOnly',
        fontSrc: 'selfOnly',
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
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
        || hostname === '::1'
        || hostname.startsWith('::ffff:127.')
        || hostname.startsWith('::ffff:7f');
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
    const sameOrigin = Boolean(input.sandbox.sameOrigin && parsed?.protocol === 'https:');
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
