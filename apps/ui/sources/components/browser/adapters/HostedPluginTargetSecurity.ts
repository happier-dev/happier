import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import type { PluginHostedWebSecurityPolicyV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedWebSecurity';

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

/** Declaration metadata for an installed inline HTML document. */
export function createInlineHostedHtmlSecurityPolicy(
    networkOrigins: readonly string[],
): PluginHostedWebSecurityPolicyV1 {
    return {
        allowedNavigationOrigins: [],
        allowedCallbackOrigins: [],
        allowedConnectOrigins: [...networkOrigins],
        csp: {
            connectSrc: networkOrigins.length > 0 ? 'declaredOrigins' : 'none',
            allowDataUrls: true,
            allowBlobUrls: false,
            allowInlineStyles: true,
            allowEval: false,
        },
        sourceMaps: 'disabled',
        mixedContent: 'deny',
    };
}

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
    url: string;
}>): boolean {
    const parsed = parseHostedPluginTargetUrl(input.url);
    if (!parsed) {
        return false;
    }
    if (parsed.protocol === 'https:') {
        return true;
    }
    return isLoopbackHostedWebUrl(input.url);
}
