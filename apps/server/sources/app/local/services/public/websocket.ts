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
import {
    readLocalServicePublicClientKey,
    resolveLocalServicePublicAccessIdentity,
    type LocalServicePublicAccessPurpose,
    type LocalServicePublicAuthenticatedUser,
    type LocalServicePublicAccessServiceAuthorizer,
} from "@/app/local/services/public/accessAuthorization";
import type { LocalServicePublicExposureV1, LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

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
        authenticated: boolean;
        sessionAuthorized: boolean;
        clientKey: string;
    }>) => LocalServicePublicRuntimeAccessResult;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    trustProxy?: boolean | number;
    externalProtocol?: "http" | "https";
    retainConnection?: (exposureId: string, close: () => void, actorAccountId?: string) => () => void;
    resolvePreview?: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    authorizeServiceAccess?: LocalServicePublicAccessServiceAuthorizer;
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: LocalServicePublicAccessPurpose;
        authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
    }>) => boolean | Promise<boolean>;
    readOptionalAuthenticatedUser?: (request: unknown) => Promise<LocalServicePublicAuthenticatedUser | null>;
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

function parsePublicUpgradeRoute(request: UpgradeRequest): PublicUpgradeRoute | null {
    const url = upgradeUrl(request);
    if (!url || !url.pathname.startsWith(PUBLIC_UPGRADE_ROUTE_PREFIX)) {
        return null;
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
    const headers = requestHeadersToRecord(request.headers);
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
    const url = upgradeUrl(request);
    if (!url || !url.pathname.startsWith(PUBLIC_UPGRADE_ROUTE_PREFIX)) return;

    if (options.featureEnabled && !await options.featureEnabled(request)) {
        await sendUpgradeError(socket, 404, "Not Found");
        return;
    }

    const route = parsePublicUpgradeRoute(request);
    if (!route) {
        await sendUpgradeError(socket, 400, "Bad Request");
        return;
    }
    if (route.hasQueryToken) {
        await sendUpgradeError(socket, 403, "Forbidden");
        return;
    }

    const headers = requestHeadersToRecord(request.headers);
    const bearerAuth = await readOptionalPublicAuthDisposition(headers.authorization);
    if (bearerAuth.status === "session_runtime_forbidden") {
        await sendUpgradeError(socket, 403, "Forbidden");
        return;
    }
    const principal = bearerAuth.status === "authenticated"
        ? {
            userId: bearerAuth.principal.userId,
            authentication: {
                env: process.env,
                authority: bearerAuth.principal.authority,
                authenticationEvidence: bearerAuth.principal.authenticationEvidence,
            },
        }
        : options.readOptionalAuthenticatedUser
            ? await options.readOptionalAuthenticatedUser({ headers })
            : null;
    // S-2/S-5: the WebSocket data plane resolves the same access identity and client bucket as
    // the HTTP data plane; a co-tenant must not reach an authenticated exposure over either.
    const identity = await resolveLocalServicePublicAccessIdentity({
        exposureId: route.exposureId,
        principal,
        resolveExposure: options.resolveExposure,
        authorizeSessionAccess: options.authorizeSessionAccess,
        resolvePreview: options.resolvePreview,
        authorizeServiceAccess: options.authorizeServiceAccess,
    });
    const trustProxy = options.trustProxy;
    const access = options.validateAccess({
        exposureId: route.exposureId,
        rawToken: route.rawToken,
        authenticated: identity.authenticated,
        sessionAuthorized: identity.sessionAuthorized,
        // Same proxy-addr implementation and trust function as Fastify's request.ip.
        // The library reads only headers and socket; raw upgrade requests have this shape.
        clientKey: readLocalServicePublicClientKey([proxyAddr({ ...request, socket } as IncomingMessage,
            trustProxy === true ? () => true
                : typeof trustProxy === 'number' ? (_address, hop) => hop < trustProxy
                    : () => false)]),
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
    }, options.resolveExposure?.(route.exposureId)?.mode === 'authenticated' ? principal?.userId : undefined);
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
                externalProtocol: request.socket?.encrypted ? "https" : options.externalProtocol ?? "http",
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
