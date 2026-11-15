import type { ApiProxyTrust } from '@/app/api/utils/apiRateLimitPolicy';
import { claimHttpUpgrade } from '@/app/api/utils/httpUpgradeOwnership';
import { readOptionalPublicAuthDisposition } from "@/app/api/utils/optionalPublicAuth";
import proxyAddr from '@fastify/proxy-addr';
import type { IncomingMessage } from 'node:http';
import type { OpenLocalServicePreviewTunnel } from "@/app/local/services/preview/httpAdapter";
import {
    proxyLocalServicePreviewWebSocketUpgrade,
    type ProxyLocalServicePreviewWebSocketUpgradeInput,
    type ProxyLocalServicePreviewWebSocketUpgradeResult,
} from "@/app/local/services/preview/websocketAdapter";
import {
    createLocalServicePreviewUpgradeClient,
    type LocalServicePreviewUpgradeSocket,
    writeLocalServicePreviewUpgradeError,
} from "@/app/local/services/preview/upgradeClient";
import type { PeerMediationObservabilityEmitter } from "@/app/api/socket/peer/mediation/observability/events";
import type { LocalServicePublicRuntimeAccessResult } from "@/app/local/services/public/runtime";
import {
    readLocalServicePublicQueryToken,
    readLocalServicePublicTokenCookie,
} from "@/app/local/services/public/accessToken";
import { readLocalServicePublicClientKey } from "@/app/local/services/public/accessAuthorization";
import type { LocalServicePublicExposureV1 } from '@happier-dev/protocol/local/services/public/v1';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { isLocalServiceUpgradeOriginAdmitted, readLocalServiceRequestHostname, resolveLocalServiceExternalProtocol } from '@/app/local/services/preview/origin';

type UpgradeRequest = Readonly<{
    url?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
    rawHeaders?: readonly string[];
    socket?: Readonly<{ encrypted?: boolean; remoteAddress?: string }>;
}>;

type UpgradeSocket = LocalServicePreviewUpgradeSocket;

type PublicUpgradeRoute = Readonly<{
    exposureId: string;
    path: string;
    search: string;
    rawToken: string | null;
    hasQueryToken: boolean;
}>;

export type LocalServicePublicWebSocketUpgradeOptions = Readonly<{
    validateAccess: (input: Readonly<{
        exposureId: string;
        rawToken: string | null;
        clientKey: string;
    }>) => LocalServicePublicRuntimeAccessResult;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    resolveExposureByHost?: (hostname: string) => LocalServicePublicExposureV1 | null | undefined;
    trustProxy?: ApiProxyTrust;
    externalProtocol?: "http" | "https";
    retainConnection?: (exposureId: string, close: () => void) => () => void;
    resolvePreview?: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    openTunnel?: OpenLocalServicePreviewTunnel;
    /** The upgrade request being served, so the decision reads that request's Home configuration. */
    featureEnabled?: (request: object) => boolean | Promise<boolean>;
    observability?: PeerMediationObservabilityEmitter;
    proxyWebSocket?: (input: ProxyLocalServicePreviewWebSocketUpgradeInput) => Promise<ProxyLocalServicePreviewWebSocketUpgradeResult>;
}>;

const PUBLIC_UPGRADE_ROUTE_PREFIX = "/v1/local-services/public/";

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requestHeadersToRecord(headers: Record<string, string | readonly string[] | undefined> | undefined): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(headers ?? {}).flatMap(([key, value]) => (
            typeof value === "string" || Array.isArray(value)
                ? [[key, value]]
                : typeof value === "undefined"
                    ? []
                    : [[key, String(value)]]
        )),
    );
}

function upgradeUrl(request: UpgradeRequest): URL | null {
    try {
        const rawHost = request.headers?.host;
        const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
        return new URL(request.url ?? "", `http://${typeof host === "string" ? host : "localhost"}`);
    } catch {
        return null;
    }
}

function serializeUrlSearchWithoutPublicToken(url: URL): string {
    url.searchParams.delete("publicToken");
    const search = url.searchParams.toString();
    return search ? `?${search}` : "";
}

function parsePublicUpgradeRoute(request: UpgradeRequest, options: LocalServicePublicWebSocketUpgradeOptions): PublicUpgradeRoute | null {
    const url = upgradeUrl(request);
    if (!url) return null;
    const headers = requestHeadersToRecord(request.headers);
    if (!url.pathname.startsWith(PUBLIC_UPGRADE_ROUTE_PREFIX)) {
        const hostname = readLocalServiceRequestHostname(headers);
        const exposure = hostname ? options.resolveExposureByHost?.(hostname) : null;
        if (!exposure) return null;
        return {
            exposureId: exposure.exposureId, path: url.pathname,
            search: serializeUrlSearchWithoutPublicToken(url),
            rawToken: readLocalServicePublicTokenCookie(headers),
            hasQueryToken: Boolean(url.searchParams.get('publicToken')),
        };
    }
    const rest = url.pathname.slice(PUBLIC_UPGRADE_ROUTE_PREFIX.length);
    const [encodedExposureId, ...pathParts] = rest.split("/");
    let decodedExposureId: string | null = null;
    try {
        decodedExposureId = encodedExposureId ? decodeURIComponent(encodedExposureId) : null;
    } catch {
        return null;
    }
    const exposureId = readString(decodedExposureId);
    if (!exposureId) return null;
    const queryToken = readLocalServicePublicQueryToken(Object.fromEntries(url.searchParams.entries()));
    return {
        exposureId,
        path: `/${pathParts.join("/")}`,
        search: serializeUrlSearchWithoutPublicToken(url),
        rawToken: readLocalServicePublicTokenCookie(headers),
        hasQueryToken: Boolean(queryToken),
    };
}

async function sendUpgradeError(socket: UpgradeSocket, statusCode: number, statusMessage: string): Promise<void> {
    await writeLocalServicePreviewUpgradeError(socket, statusCode, statusMessage);
}

export function createPublicExposureObservabilityEmitter(
    base: PeerMediationObservabilityEmitter | undefined,
    exposureId: string,
): PeerMediationObservabilityEmitter | undefined {
    if (!base) return undefined;
    return {
        emit(event) {
            const { routeGrantId: _routeGrantId, ...flow } = event.flow;
            base.emit({
                ...event,
                scope: {
                    kind: "publicPreview",
                    publicExposureId: exposureId,
                },
                flow: {
                    ...flow,
                    productRef: {
                        kind: "publicExposure",
                        id: exposureId,
                        redacted: false,
                    },
                },
            });
        },
    };
}

export async function handleLocalServicePublicWebSocketUpgrade(
    request: UpgradeRequest,
    socket: UpgradeSocket,
    head: Uint8Array,
    options: LocalServicePublicWebSocketUpgradeOptions,
): Promise<void> {
    const route = parsePublicUpgradeRoute(request, options);
    if (!route && !upgradeUrl(request)?.pathname.startsWith(PUBLIC_UPGRADE_ROUTE_PREFIX)) return;
    claimHttpUpgrade(request);

    if (options.featureEnabled && !await options.featureEnabled(request)) {
        await sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    if (!route) {
        await sendUpgradeError(socket, 400, 'Bad Request');
        return;
    }
    const hostname = readLocalServiceRequestHostname(requestHeadersToRecord(request.headers));
    if (options.resolveExposureByHost && (!hostname || options.resolveExposureByHost(hostname)?.exposureId !== route.exposureId)) {
        await sendUpgradeError(socket, 403, 'Forbidden');
        return;
    }

    if (route.hasQueryToken || !isLocalServiceUpgradeOriginAdmitted(requestHeadersToRecord(request.headers))) {
        await sendUpgradeError(socket, 403, "Forbidden");
        return;
    }

    const headers = requestHeadersToRecord(request.headers);
    const bearerAuth = await readOptionalPublicAuthDisposition(headers.authorization);
    if (bearerAuth.status === "session_runtime_forbidden") {
        await sendUpgradeError(socket, 403, "Forbidden");
        return;
    }
    // S-5: the WebSocket data plane uses the same viewer cookie and client bucket as HTTP.
    const trustProxy = options.trustProxy;
    const access = options.validateAccess({
        exposureId: route.exposureId,
        rawToken: route.rawToken,
        // Same proxy-addr implementation and trust function as Fastify's request.ip.
        // Project Node's prototype-backed headers explicitly at the external library boundary.
        clientKey: readLocalServicePublicClientKey([proxyAddr({ headers: request.headers ?? {}, socket } as IncomingMessage,
            typeof trustProxy === "function" ? trustProxy : () => trustProxy === true)]),
    });
    if (!access.ok) {
        await sendUpgradeError(socket, 403, "Forbidden");
        return;
    }

    const proxyWebSocket = options.proxyWebSocket ?? proxyLocalServicePreviewWebSocketUpgrade;
    if (!options.openTunnel && !options.proxyWebSocket) {
        await sendUpgradeError(socket, 503, "Service Unavailable");
        return;
    }

    const registration = new AbortController();
    const releaseConnection = options.retainConnection?.(route.exposureId, () => {
        registration.abort();
        socket.destroy?.();
    });
    if (registration.signal.aborted || socket.destroyed) {
        releaseConnection?.();
        return;
    }
    try {
        await proxyWebSocket({
            preview: access.preview,
            request: {
                path: route.path,
                search: route.search,
                headers: Object.fromEntries(
                    Object.entries(request.headers ?? {}).flatMap(([key, value]) => (
                        typeof value === "string" || Array.isArray(value)
                            ? [[key, value]]
                            : typeof value === "undefined"
                                ? []
                                : [[key, String(value)]]
                    )),
                ),
                rawHeaders: request.rawHeaders ?? [],
                externalProtocol: resolveLocalServiceExternalProtocol({
                    requestIsSecure: request.socket?.encrypted === true,
                    configured: options.externalProtocol,
                }),
                head,
                signal: registration.signal,
                client: createLocalServicePreviewUpgradeClient(socket),
            },
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
            observability: createPublicExposureObservabilityEmitter(options.observability, route.exposureId),
        });
    } catch {
        await sendUpgradeError(socket, 502, "Bad Gateway");
    } finally {
        releaseConnection?.();
    }
}
