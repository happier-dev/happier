import { STATUS_CODES } from 'node:http';
import type { DefaultTreeAdapterMap } from 'parse5';
import { SAFE_TELEMETRY_HEADER_NAMES } from '@happier-dev/protocol/browser/diagnostics/egress/headers';
import { buildCooperativeNavigationRuntimeScript, buildInjectedBrowserDiagnosticsRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';
import {
    COOPERATIVE_COLLECTOR_QUERY, COOPERATIVE_COLLECTOR_STATE_QUERY, COOPERATIVE_COLLECTOR_LOADER_PATH,
    COOPERATIVE_COLLECTOR_NAVIGATION_QUERY,
    parseCooperativeCollectorConfig, stripCooperativeCollectorQuery, buildCooperativeCollectorNavigationUrl,
} from '@happier-dev/peer-mediation/browser/collector/cooperative';
import type { LocalServicePreviewHttpResponseHeaders } from '@happier-dev/peer-mediation/localServices/preview/httpAdapter';
import type { ProxyLocalServicePreviewHttpRequestInput } from './httpAdapter';
import { createCollectorHtmlStream } from './collectorHtmlStream';

function header(headers: LocalServicePreviewHttpResponseHeaders, name: string): string {
    const value = headers[name];
    return Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
}

// This is an admission check, not a CSP replacement. The browser still enforces every
// original policy. Unsupported script sources fail closed rather than borrowing page nonces.
function permitsLoader(policy: string, loader: URL): boolean {
    return policy.split(',').every((part) => {
        const directives = new Map<string, string[]>();
        for (const directive of part.split(';')) {
            const [name, ...sources] = directive.trim().split(/\s+/);
            if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
        }
        const sandbox = directives.get('sandbox');
        if (sandbox && (!sandbox.includes('allow-scripts') || !sandbox.includes('allow-same-origin'))) return false;
        const sources = directives.get('script-src-elem') ?? directives.get('script-src') ?? directives.get('default-src');
        if (!sources) return true;
        if (sources.includes("'strict-dynamic'")) return false;
        return sources.some((source) => {
            if (source === "'self'" || source === '*' || source === loader.protocol) return true;
            if (source.startsWith("'")) return false;
            try {
                const allowed = new URL(source.includes('://') ? source : `${loader.protocol}//${source}`);
                return allowed.origin === loader.origin && (allowed.pathname === '/' || allowed.pathname === loader.pathname
                    || (allowed.pathname.endsWith('/') && loader.pathname.startsWith(allowed.pathname)));
            } catch { return false; }
        });
    });
}

function htmlAdmission(tree: DefaultTreeAdapterMap['document'], policy: string, loader: URL): { allowed: boolean; offset: number } {
    const element = tree.childNodes.find((node) => 'tagName' in node && node.tagName === 'html');
    const head = element && 'childNodes' in element ? element.childNodes.find((node) => 'tagName' in node && node.tagName === 'head') : undefined;
    let allowed = permitsLoader(policy, loader);
    const visit = (node: DefaultTreeAdapterMap['node']) => {
        if ('tagName' in node && node.tagName === 'meta') {
            const equiv = node.attrs.find((attr) => attr.name === 'http-equiv')?.value.toLowerCase();
            if (equiv === 'content-security-policy') allowed &&= permitsLoader(node.attrs.find((attr) => attr.name === 'content')?.value ?? '', loader);
        }
        // Template contents are inert; parse5 keeps them outside childNodes.
        if ('childNodes' in node) node.childNodes.forEach(visit);
    };
    if (head) visit(head);
    const location = head && 'tagName' in head ? head.sourceCodeLocation : undefined;
    const rootLocation = element && 'tagName' in element ? element.sourceCodeLocation : undefined;
    const body = element && 'childNodes' in element ? element.childNodes.find((node) => 'tagName' in node && node.tagName === 'body') : undefined;
    const bodyLocation = body && 'tagName' in body ? body.sourceCodeLocation : undefined;
    const doctypeEnd = tree.childNodes.find((node) => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset;
    // An implicit head/root has no tag location. Keep the doctype before the loader,
    // otherwise an otherwise standards-mode page would switch to quirks mode.
    return { allowed, offset: location?.endTag?.startOffset ?? location?.endOffset
        ?? bodyLocation?.startTag?.startOffset ?? rootLocation?.startTag?.endOffset ?? doctypeEnd ?? 0 };
}

/**
 * A refusal the preview route answers before the proxy (no such preview, no admission) is still the
 * pane's state probe's typed answer: the ended state rests on it. Only the parent origin the probe's
 * own collector identity names, and that sent the request, may read it; the body names a refusal and
 * no page content. Any other request gets no CORS grant.
 */
export function cooperativeProbeRefusalHeaders(search: string, headers: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> | null {
    const query = new URLSearchParams(search);
    if (query.get(COOPERATIVE_COLLECTOR_STATE_QUERY) !== '1') return null;
    const config = parseCooperativeCollectorConfig(query.get(COOPERATIVE_COLLECTOR_QUERY));
    const origin = headers.origin;
    if (!config || typeof origin !== 'string' || origin !== config.webPostMessageTargetOrigin) return null;
    return { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

/** Called only after the existing preview route has admitted access; configuration is not a grant. */
export async function prepareCooperativePreview(input: ProxyLocalServicePreviewHttpRequestInput): Promise<ProxyLocalServicePreviewHttpRequestInput | null> {
    const query = new URLSearchParams(input.request.search);
    const probe = query.get(COOPERATIVE_COLLECTOR_STATE_QUERY) === '1';
    const hasCollectorConfig = query.has(COOPERATIVE_COLLECTOR_QUERY);
    // Later iframe documents learn their identity from their actual embedding frame, never a cookie.
    const navigationOnly = !hasCollectorConfig && input.preview.originMode === 'host' &&
        (input.request.headers['sec-fetch-dest'] === 'iframe' || (input.request.path === COOPERATIVE_COLLECTOR_LOADER_PATH
            && query.get(COOPERATIVE_COLLECTOR_NAVIGATION_QUERY) === '1'));
    if (!hasCollectorConfig && !probe && !navigationOnly) return input;
    const config = parseCooperativeCollectorConfig(query.get(COOPERATIVE_COLLECTOR_QUERY));
    const respond = async (status: number, body: string, headers: LocalServicePreviewHttpResponseHeaders) => {
        input.response.writeHead(status, STATUS_CODES[status] ?? '', { 'cache-control': 'no-store', ...headers });
        await input.response.write(Buffer.from(body));
        await input.response.end();
    };
    if (hasCollectorConfig && (!config || input.preview.originMode !== 'host')) {
        await respond(400, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    if ((config || navigationOnly) && input.request.path === COOPERATIVE_COLLECTOR_LOADER_PATH) {
        if (input.request.method !== 'GET' || (config && query.get('n') !== config.collector.nonce)) {
            await respond(400, JSON.stringify({ state: 'collector_mismatch' }), { 'content-type': 'application/json' });
            return null;
        }
        const runtimeConfig = config ? JSON.stringify({
            ...config, cooperativePreview: true,
            ...(config.ownerDiagnosticsValueCapture ? { safeTelemetryHeaderNames: [...SAFE_TELEMETRY_HEADER_NAMES] } : {}),
        }).replace(/</g, '\\u003c') : 'null';
        const script = query.get(COOPERATIVE_COLLECTOR_NAVIGATION_QUERY) === '1'
            ? buildCooperativeNavigationRuntimeScript(runtimeConfig)
            : buildInjectedBrowserDiagnosticsRuntimeScript(runtimeConfig);
        await respond(200, script, { 'content-type': 'application/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
        return null;
    }
    const requestOrigin = input.request.headers.origin;
    const parentOrigin = config?.webPostMessageTargetOrigin ?? (typeof requestOrigin === 'string' ? requestOrigin : undefined);
    if (probe && (requestOrigin !== parentOrigin || (parentOrigin !== undefined
        && (!/^https?:\/\//.test(parentOrigin) || URL.canParse(parentOrigin) === false || new URL(parentOrigin).origin !== parentOrigin)))) {
        await respond(403, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    const upstreamSearch = stripCooperativeCollectorQuery(input.request.search);
    const destination = input.request.headers['sec-fetch-dest'];
    if (input.request.method !== 'GET' || (!probe && typeof destination === 'string'
        && destination !== 'iframe' && destination !== 'document')) {
        return { ...input, request: { ...input.request, search: upstreamSearch } };
    }
    const host = input.request.headers.host;
    if (typeof host !== 'string') {
        await respond(400, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    // The loader is requested from the document it is injected into, so the tag carries a root-relative
    // URL and no scheme to derive. The document's own origin is only what the CSP admission compares with:
    // the routes already resolved its external protocol from the Home and transport, including
    // loopback HTTP. Never derive this from a caller-supplied forwarded header.
    const origin = new URL(`${input.request.externalProtocol ?? 'https'}://${host}`).origin;
    const loader = new URL(COOPERATIVE_COLLECTOR_LOADER_PATH, origin);
    if (config) {
        loader.searchParams.set('n', config.collector.nonce);
        loader.searchParams.set(COOPERATIVE_COLLECTOR_QUERY, JSON.stringify(config));
    }
    if (navigationOnly) loader.searchParams.set(COOPERATIVE_COLLECTOR_NAVIGATION_QUERY, '1');
    let status = 0;
    let message = '';
    let headers: LocalServicePreviewHttpResponseHeaders = {};
    let collectHtml = false;
    let htmlStream: ReturnType<typeof createCollectorHtmlStream> | undefined;
    let state = 'runtime_unavailable';
    let transportUnavailable = false;
    let probeRedirect: string | undefined;
    const chunks: Uint8Array[] = [];
    return { ...input, request: { ...input.request, search: upstreamSearch },
        onTransportUnavailable(event) {
            transportUnavailable = true;
            input.onTransportUnavailable?.(event);
        }, response: {
        writeHead(code, statusMessage, value) {
            status = code; message = statusMessage; headers = value;
            collectHtml = (config !== null || navigationOnly) && code === 200 && /^text\/html(?:;|$)/i.test(header(value, 'content-type'));
            if (collectHtml) {
                const encoding = header(headers, 'content-encoding').trim().toLowerCase();
                const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(header(headers, 'content-type'))?.[1] ?? 'utf-8';
                let decoder: InstanceType<typeof TextDecoder> | undefined;
                try { decoder = new TextDecoder(charset); } catch { /* Unsupported charsets stream unchanged. */ }
                if (decoder && ['', 'identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
                    htmlStream = createCollectorHtmlStream({ encoding, decoder, maxBytes: input.preview.policy?.maxResponseBodyBytes,
                        admitHead(html, tree) {
                            const admission = htmlAdmission(tree, header(headers, 'content-security-policy'), loader);
                            state = admission.allowed ? 'collector_available' : 'collector_blocked_by_csp';
                            const nextHeaders: Record<string, string | readonly string[]> = { ...headers, 'x-happier-collector-state': state };
                            for (const name of ['content-encoding', 'content-length', 'etag', 'content-md5', 'digest']) delete nextHeaders[name];
                            nextHeaders['content-type'] = 'text/html; charset=utf-8';
                            nextHeaders['cache-control'] = 'no-store';
                            if (!probe) input.response.writeHead(status, message, nextHeaders);
                            // Install the document's controls before parsing its body. `defer` would
                            // leave a streamed page without a Stop listener until upstream EOF.
                            const tag = `<script src="${(loader.pathname + loader.search).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`;
                            return admission.allowed ? html.slice(0, admission.offset) + tag + html.slice(admission.offset) : html;
                        },
                        write: (chunk) => { if (!probe) return input.response.write(chunk); },
                    });
                } else if (!probe) input.response.writeHead(status, message, { ...headers, 'x-happier-collector-state': state });
            }
            if (!collectHtml) {
                const location = header(value, 'location');
                if (code >= 300 && code < 400 && location) {
                    try {
                        const next = new URL(location, `${origin}${input.request.path}`);
                        if (next.origin === origin) {
                            // Redirects within the admitted preview retain this navigation's identity;
                            // an external destination must never receive it.
                            const admitted = new URL(config ? buildCooperativeCollectorNavigationUrl(next.href, config) : next.href);
                            if (probe) {
                                admitted.search += `${admitted.search ? '&' : '?'}${COOPERATIVE_COLLECTOR_STATE_QUERY}=1`;
                                probeRedirect = admitted.pathname + admitted.search + admitted.hash;
                            }
                            headers = { ...value, location: admitted.pathname + admitted.search + admitted.hash };
                        }
                    } catch { /* Leave invalid application redirects to the browser. */ }
                }
                if (!probe) input.response.writeHead(code, statusMessage, headers);
            }
        },
        async write(chunk) {
            if (htmlStream) await htmlStream.write(chunk);
            else if (probe && transportUnavailable) chunks.push(chunk);
            else if (!probe) await input.response.write(chunk);
        },
        async end() {
            await htmlStream?.end();
            if (probe) {
                // Preserve the proxy's typed refusal, not an application's error body. The existing
                // transport callback is authoritative; status or JSON supplied by the app is not.
                await respond(transportUnavailable || probeRedirect ? status : 200,
                    transportUnavailable ? Buffer.concat(chunks).toString('utf8') : probeRedirect ? '' : JSON.stringify({ state }), { 'content-type': 'application/json',
                    ...(probeRedirect ? { location: probeRedirect } : {}),
                    ...(parentOrigin ? { 'access-control-allow-origin': parentOrigin, 'access-control-allow-credentials': 'true' } : {}), 'vary': 'Origin' });
                return;
            }
            await input.response.end();
        },
        destroy(error) { htmlStream?.destroy(error); input.response.destroy(error); },
    } };
}
