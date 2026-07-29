import { describe, expect, it } from 'vitest';

type EndpointDiscoveryResult =
    | Readonly<{
        ok: true;
        endpoint: Readonly<{
            url: string;
            host: string;
            port: number;
            path: string;
        }>;
    }>
    | Readonly<{
        ok: false;
        errorCode: 'cdp_unavailable';
        reason: string;
    }>;

type EndpointModule = Readonly<{
    discoverBrowserSidecarCdpEndpoint?: (source: Readonly<{
        kind: 'devtoolsStderr';
        stderr: string;
    }> | Readonly<{
        kind: 'explicit';
        endpoint: string;
    }>) => EndpointDiscoveryResult;
}>;

async function loadEndpointModule(): Promise<EndpointModule | null> {
    return import('./cdpEndpoint') as Promise<EndpointModule | null>;
}

describe('browser sidecar CDP endpoint discovery', () => {
    it('extracts private loopback DevTools browser endpoints from Chromium stderr', async () => {
        const mod = await loadEndpointModule();

        expect(mod?.discoverBrowserSidecarCdpEndpoint).toBeTypeOf('function');
        if (!mod?.discoverBrowserSidecarCdpEndpoint) return;

        const result = mod.discoverBrowserSidecarCdpEndpoint({
            kind: 'devtoolsStderr',
            stderr: [
                '[1137:1137] noise',
                'DevTools listening on ws://127.0.0.1:9222/devtools/browser/browser-secret-token',
            ].join('\n'),
        });

        expect(result).toEqual({
            ok: true,
            endpoint: {
                url: 'ws://127.0.0.1:9222/devtools/browser/browser-secret-token',
                host: '127.0.0.1',
                port: 9222,
                path: '/devtools/browser/browser-secret-token',
            },
        });
    });

    it('accepts explicit loopback browser endpoints and normalizes localhost inputs privately', async () => {
        const mod = await loadEndpointModule();

        expect(mod?.discoverBrowserSidecarCdpEndpoint).toBeTypeOf('function');
        if (!mod?.discoverBrowserSidecarCdpEndpoint) return;

        const result = mod.discoverBrowserSidecarCdpEndpoint({
            kind: 'explicit',
            endpoint: 'ws://localhost:9333/devtools/browser/explicit-token',
        });

        expect(result).toMatchObject({
            ok: true,
            endpoint: {
                url: 'ws://localhost:9333/devtools/browser/explicit-token',
                host: 'localhost',
                port: 9333,
                path: '/devtools/browser/explicit-token',
            },
        });
    });

    it.each([
        ['missing stderr endpoint', { kind: 'devtoolsStderr' as const, stderr: 'Chrome started without a debugger line' }],
        ['malformed endpoint', { kind: 'explicit' as const, endpoint: 'not a url' }],
        ['HTTP endpoint', { kind: 'explicit' as const, endpoint: 'http://127.0.0.1:9222/devtools/browser/token' }],
        ['credential-bearing endpoint', { kind: 'explicit' as const, endpoint: 'ws://user:pass@127.0.0.1:9222/devtools/browser/token' }],
        ['non-loopback endpoint', { kind: 'explicit' as const, endpoint: 'ws://192.0.2.10:9222/devtools/browser/token' }],
        ['non-browser DevTools endpoint', { kind: 'explicit' as const, endpoint: 'ws://127.0.0.1:9222/devtools/page/page-token' }],
        ['missing explicit port', { kind: 'explicit' as const, endpoint: 'ws://127.0.0.1/devtools/browser/token' }],
    ])('rejects %s without returning debugger endpoint details', async (_label, source) => {
        const mod = await loadEndpointModule();

        expect(mod?.discoverBrowserSidecarCdpEndpoint).toBeTypeOf('function');
        if (!mod?.discoverBrowserSidecarCdpEndpoint) return;

        const result = mod.discoverBrowserSidecarCdpEndpoint(source);

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'cdp_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('ws://');
        expect(JSON.stringify(result)).not.toContain('user:pass');
        expect(JSON.stringify(result)).not.toContain('token');
    });
});
