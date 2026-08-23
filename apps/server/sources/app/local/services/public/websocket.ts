import { auth } from "@/app/auth/auth";
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
} from "@/app/local/services/public/accessAuthorization";
import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";

type UpgradeRequest = Readonly<{
    url?: string;
    headers?: Record<string, string | readonly string[] | undefined>;
    rawHeaders?: readonly string[];
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
    authorizeSessionAccess?: (input: Readonly<{
        userId: string;
        sessionId: string;
        purpose: LocalServicePublicAccessPurpose | string;
    }>) => boolean | Promise<boolean>;
    readOptionalUserId?: (request: unknown) => Promise<string | null>;
    openTunnel?: OpenLocalServicePreviewTunnel;
    featureEnabled?: () => boolean;
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

async function readOptionalBearerUserId(headers: Record<string, unknown>): Promise<string | null> {
    const authorization = headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
        return null;
    }
    try {
        const verified = await auth.verifyToken(authorization.slice("Bearer ".length));
        return verified?.userId ?? null;
    } catch {
        return null;
    }
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

    if (options.featureEnabled && !options.featureEnabled()) {
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
    const userId = options.readOptionalUserId
        ? await options.readOptionalUserId({ headers })
        : await readOptionalBearerUserId(headers);
    // S-2/S-5: the WebSocket data plane resolves the same access identity and client bucket as
    // the HTTP data plane; a co-tenant must not reach an authenticated exposure over either.
    const identity = await resolveLocalServicePublicAccessIdentity({
        exposureId: route.exposureId,
        userId,
        resolveExposure: options.resolveExposure,
        authorizeSessionAccess: options.authorizeSessionAccess,
    });
    const access = options.validateAccess({
        exposureId: route.exposureId,
        rawToken: route.rawToken,
        authenticated: identity.authenticated,
        sessionAuthorized: identity.sessionAuthorized,
        clientKey: readLocalServicePublicClientKey([
            (socket as Readonly<{ remoteAddress?: string }>).remoteAddress,
        ]),
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
                head,
                client: createLocalServicePreviewUpgradeClient(socket),
            },
            openTunnel: options.openTunnel as OpenLocalServicePreviewTunnel,
            observability: createPublicExposureObservabilityEmitter(options.observability, route.exposureId),
        });
    } catch {
        await sendUpgradeError(socket, 502, "Bad Gateway");
    }
}
