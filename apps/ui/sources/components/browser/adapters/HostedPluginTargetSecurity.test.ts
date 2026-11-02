import { describe, expect, it } from 'vitest';

import { canLoadHostedPluginTargetUrl, createInlineHostedHtmlSecurityPolicy, isLoopbackHostedWebUrl } from './HostedPluginTargetSecurity';

describe('HostedPluginTargetSecurity', () => {
    it('recognizes bracketed IPv6 loopback URLs', () => {
        expect(isLoopbackHostedWebUrl('http://[::1]:5173/')).toBe(true);
        expect(isLoopbackHostedWebUrl('http://[::ffff:127.0.0.1]:5173/')).toBe(true);
        expect(isLoopbackHostedWebUrl('http://[::ffff:192.0.2.1]:5173/')).toBe(false);
    });

    it('admits https and loopback http independently of plugin policy and refuses remote http', () => {
        for (const url of ['https://plugin.example.test/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']) {
            expect(canLoadHostedPluginTargetUrl({ url })).toBe(true);
        }
        expect(canLoadHostedPluginTargetUrl({ url: 'http://plugin.example.test/' })).toBe(false);
    });

    it('reports security metadata that matches the inline document CSP', () => {
        expect(createInlineHostedHtmlSecurityPolicy(['https://api.example.com'])).toEqual({
            allowedNavigationOrigins: [],
            allowedCallbackOrigins: [],
            allowedConnectOrigins: ['https://api.example.com'],
            csp: {
                connectSrc: 'declaredOrigins',
                allowDataUrls: true,
                allowBlobUrls: false,
                allowInlineStyles: true,
                allowEval: false,
            },
            sourceMaps: 'disabled',
            mixedContent: 'deny',
        });
        expect(createInlineHostedHtmlSecurityPolicy([]).csp.connectSrc).toBe('none');
    });
});
