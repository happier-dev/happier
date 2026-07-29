import type { BrowserSidecarErrorCodeV1 } from '@happier-dev/protocol';

export type BrowserSidecarCdpEndpoint = Readonly<{
    url: string;
    host: string;
    port: number;
    path: string;
}>;

export type BrowserSidecarCdpEndpointSource =
    | Readonly<{ kind: 'devtoolsStderr'; stderr: string }>
    | Readonly<{ kind: 'explicit'; endpoint: string }>;

export type BrowserSidecarCdpEndpointDiscoveryResult =
    | Readonly<{ ok: true; endpoint: BrowserSidecarCdpEndpoint }>
    | Readonly<{
        ok: false;
        errorCode: Extract<BrowserSidecarErrorCodeV1, 'cdp_unavailable'>;
        reason: 'missing_endpoint' | 'invalid_endpoint';
    }>;

const DEVTOOLS_LISTENING_PATTERN = /DevTools listening on\s+(ws:\/\/\S+)/u;

function unavailable(reason: 'missing_endpoint' | 'invalid_endpoint'): BrowserSidecarCdpEndpointDiscoveryResult {
    return {
        ok: false,
        errorCode: 'cdp_unavailable',
        reason,
    };
}

function isLoopbackHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^\[|\]$/gu, '');
    return normalized === '127.0.0.1'
        || normalized === 'localhost'
        || normalized === '::1';
}

function readEndpoint(source: BrowserSidecarCdpEndpointSource): string | null {
    if (source.kind === 'explicit') {
        return source.endpoint.trim().length > 0 ? source.endpoint.trim() : null;
    }
    const match = DEVTOOLS_LISTENING_PATTERN.exec(source.stderr);
    return match?.[1] ?? null;
}

function parseEndpoint(endpoint: string): BrowserSidecarCdpEndpoint | null {
    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'ws:') return null;
    if (parsed.username || parsed.password) return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    if (parsed.port.length === 0) return null;

    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (!parsed.pathname.startsWith('/devtools/browser/') || parsed.pathname === '/devtools/browser/') {
        return null;
    }
    if (parsed.hash) return null;

    return {
        url: endpoint,
        host: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
    };
}

export function discoverBrowserSidecarCdpEndpoint(
    source: BrowserSidecarCdpEndpointSource,
): BrowserSidecarCdpEndpointDiscoveryResult {
    const endpoint = readEndpoint(source);
    if (!endpoint) {
        return unavailable('missing_endpoint');
    }

    const parsed = parseEndpoint(endpoint);
    if (!parsed) {
        return unavailable('invalid_endpoint');
    }

    return {
        ok: true,
        endpoint: parsed,
    };
}
