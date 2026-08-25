import type {
    LocalServicePreviewResourceV1,
    PeerMediationObservabilityEventV1,
    PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
} from "@happier-dev/protocol";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { describe, expect, it, vi } from "vitest";
import { peerMediationGrantSigningEnv } from "@/testkit/env";
import tweetnacl from "tweetnacl";

import { FEATURE_ENV_KEYS } from "@/app/features/catalog/featureEnvSchema";

type LocalServiceRoutesModule = typeof import("./registerRoutes");

async function loadLocalServiceRoutesModule(): Promise<LocalServiceRoutesModule | null> {
    return import("./registerRoutes.js").catch(() => null) as Promise<LocalServiceRoutesModule | null>;
}

const preview: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/", search: "" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "path",
};

const ROUTE_WEBSOCKET_KEY = "client-key";
const VALID_ROUTE_WEBSOCKET_ACCEPT = "3JXE6q0TVDdbiIJlVyvPfGkLkho=";

function switchingProtocolsResponse(extraHeaders: readonly string[] = []): string {
    return [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${VALID_ROUTE_WEBSOCKET_ACCEPT}`,
        ...extraHeaders,
        "",
        "",
    ].join("\r\n");
}

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
    for (const value of values) {
        yield new TextEncoder().encode(value);
    }
}

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function createProductionRelayHarness(responseText = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>live</html>") {
    const sent: PeerTcpTunnelRelayEnvelope[] = [];
    const handlers = new Set<(envelope: PeerTcpTunnelRelayEnvelope) => void>();
    return {
        sent,
        createRelayTransport: vi.fn(() => ({
            relaySocketId: "server_preview_relay_test",
            send: (event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope: PeerTcpTunnelRelayEnvelope) => {
                expect(event).toBe(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT);
                sent.push(envelope);
                if (envelope.v === 2 && sent.length >= 3) {
                    const decoded = decodePeerTcpTunnelBinaryFrameV2({
                        frame: envelope.frame,
                        maxHeaderBytes: 64 * 1024,
                        maxPayloadBytes: 64 * 1024,
                    });
                    if (!decoded.ok || !decoded.header.substreamId) return;
                    const response = new TextEncoder().encode(responseText);
                    queueMicrotask(() => {
                        for (const handler of handlers) {
                            handler({
                                v: 2,
                                scopeUserId: envelope.scopeUserId,
                                sender: { kind: "machine", machineId: "machine_1" },
                                recipient: { kind: "user" },
                                encoding: "binary_frame_v2",
                                frame: encodePeerTcpTunnelBinaryFrameV2({
                                    header: {
                                        version: 2,
                                        kind: "data",
                                        tunnelId: decoded.header.tunnelId,
                                        substreamId: decoded.header.substreamId,
                                        direction: "daemon_to_client",
                                        sequence: 0,
                                        payloadLength: response.byteLength,
                                    },
                                    payload: response,
                                }),
                            });
                            handler({
                                v: 2,
                                scopeUserId: envelope.scopeUserId,
                                sender: { kind: "machine", machineId: "machine_1" },
                                recipient: { kind: "user" },
                                encoding: "binary_frame_v2",
                                frame: encodePeerTcpTunnelBinaryFrameV2({
                                    header: {
                                        version: 2,
                                        kind: "close",
                                        tunnelId: decoded.header.tunnelId,
                                        substreamId: decoded.header.substreamId,
                                        halfClose: false,
                                        reasonCode: "upstream_closed",
                                        payloadLength: 0,
                                    },
                                }),
                            });
                        }
                    });
                }
            },
            subscribe: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => {
                handlers.add(handler);
                return () => {
                    handlers.delete(handler);
                };
            },
            close: vi.fn(),
        })),
    };
}

function createUpgradeRouteApp() {
    const upgradeHandlers: Array<(request: unknown, socket: unknown, head: Uint8Array) => unknown> = [];
    return {
        ...createFakeRouteApp(),
        server: {
            on: vi.fn((event: string, handler: (request: unknown, socket: unknown, head: Uint8Array) => unknown) => {
                if (event === "upgrade") upgradeHandlers.push(handler);
            }),
        },
        upgradeHandlers,
    };
}

function createUpgradeSocket() {
    return {
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
            return;
        },
    };
}

async function waitForSocketWrite(socket: ReturnType<typeof createUpgradeSocket>): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (socket.write.mock.calls.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function waitForObservabilityEvents(
    emitted: readonly PeerMediationObservabilityEventV1[],
    count: number,
): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (emitted.length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function readPreviewCookieHeader(reply: ReturnType<typeof createReplyStub>): string {
    const setCookie = reply.headers["Set-Cookie"];
    expect(setCookie).toBeTypeOf("string");
    const [cookie] = setCookie.split(";");
    expect(cookie).toMatch(/^happier_preview_token=/u);
    return cookie;
}

async function exchangePreviewTokenForCookie(input: Readonly<{
    app: ReturnType<typeof createFakeRouteApp>;
    previewToken: string;
    path?: string;
}>): Promise<string> {
    const exchangeReply = createReplyStub();
    await getRouteHandler(input.app, "GET", "/v1/local-services/preview/:previewId/*")({
        method: "GET",
        params: { previewId: "preview_1", "*": input.path ?? "" },
        query: { previewToken: input.previewToken },
        headers: { host: "app.happier.test" },
    }, exchangeReply);

    expect(exchangeReply.statusCode).toBe(303);
    return readPreviewCookieHeader(exchangeReply);
}

describe("local service API route composition", () => {
    it("registers private preview routes behind the canonical feature gate", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "0",
            } as NodeJS.ProcessEnv,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/preview");
        const reply = createReplyStub();
        await handler({ userId: "user_1", body: preview }, reply);

        expect(reply.statusCode).toBe(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("keeps private preview OPTIONS data-plane routes behind the canonical feature gate", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "0",
            } as NodeJS.ProcessEnv,
            openTunnel: vi.fn(),
        });

        const reply = createReplyStub();
        await getRouteHandler(app, "OPTIONS", "/v1/local-services/preview/:previewId/*")({
            method: "OPTIONS",
            params: { previewId: "preview_1", "*": "api/data" },
            query: { previewToken: "token_1" },
            headers: {},
        }, reply);

        expect(reply.statusCode).toBe(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("keeps private preview WebSocket upgrades behind the canonical feature gate", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createUpgradeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "0",
            } as NodeJS.ProcessEnv,
            runtimes: {
                preview: {
                    registerPreview: vi.fn(),
                    resolvePreview: vi.fn(() => preview),
                    resolvePreviewByHost: vi.fn(() => null),
                    resolvePreviewContext: vi.fn(() => ({ resource: preview, accountId: "user_1" })),
                    validateAccess: vi.fn(() => ({ ok: true as const })),
                    exchangeAccessToken: vi.fn(),
                    unregisterPreview: vi.fn(),
                },
                public: {
                    createExposure: vi.fn(),
                    resolveExposure: vi.fn(),
                    validateAccess: vi.fn(),
                    exchangeAccessToken: vi.fn(),
                    revokeExposure: vi.fn(),
                    getSnapshot: vi.fn(),
                },
            },
            authorizeSessionAccess: vi.fn(() => true),
        });

        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/socket?previewToken=token_1",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        const socketResponse = socket.write.mock.calls.map((call) => new TextDecoder().decode(call[0])).join("");
        expect(socketResponse).toContain("404 Not Found");
        expect(socket.destroy).toHaveBeenCalled();
    });

    it("keeps public preview WebSocket upgrades behind the canonical feature gate", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createUpgradeRouteApp();
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            runtimes: {
                preview: {
                    registerPreview: vi.fn(),
                    resolvePreview: vi.fn(() => preview),
                    resolvePreviewByHost: vi.fn(() => null),
                    resolvePreviewContext: vi.fn(() => ({ resource: preview, accountId: "user_1" })),
                    validateAccess: vi.fn(() => ({ ok: true as const })),
                    exchangeAccessToken: vi.fn(),
                    unregisterPreview: vi.fn(),
                },
                public: {
                    createExposure: vi.fn(),
                    resolveExposure: vi.fn(),
                    validateAccess: vi.fn(() => ({ ok: true as const, preview })),
                    exchangeAccessToken: vi.fn(),
                    revokeExposure: vi.fn(),
                    getSnapshot: vi.fn(),
                },
            },
            authorizeSessionAccess: vi.fn(() => true),
            openTunnel: vi.fn(),
        });

        const socket = createUpgradeSocket();
        for (const handler of app.upgradeHandlers) {
            await handler({
                url: "/v1/local-services/public/public_preview_1/socket?publicToken=token_1",
                headers: {
                    host: "app.happier.test",
                    upgrade: "websocket",
                    connection: "Upgrade",
                },
                rawHeaders: [],
            }, socket, new Uint8Array());
        }

        const socketResponse = socket.write.mock.calls.map((call) => new TextDecoder().decode(call[0])).join("");
        expect(socketResponse).toContain("404 Not Found");
        expect(socket.destroy).toHaveBeenCalled();
        expect(proxyWebSocket).not.toHaveBeenCalled();
    });

    it("uses shared default runtimes when preview is enabled by env", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        const authorizeSessionAccess = vi.fn(() => true);
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/preview");
        const reply = createReplyStub();
        await handler({ userId: "user_1", body: preview }, reply);

        expect(reply.statusCode).toBe(201);
        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "user_1",
            sessionId: "session_1",
            purpose: "register",
        });
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            resource: preview,
            accessUrl: expect.stringContaining("https://app.happier.test/v1/local-services/preview/preview_1/"),
        }));
    });

    it("revokes public exposures through the composed shared runtime", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        const authorizeSessionAccess = vi.fn(() => true);
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                ...peerMediationGrantSigningEnv(),
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: "1",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: "default",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess,
        });

        const previewReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, previewReply);
        expect(previewReply.statusCode).toBe(201);

        const exposureReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                ttlMs: 60_000,
                rateLimitProfileId: "default",
                confirmation: { acknowledged: true },
            },
        }, exposureReply);
        expect(exposureReply.statusCode).toBe(201);

        const exposureResponse = exposureReply.send.mock.calls[0]?.[0] as { exposure?: { exposureId?: string; publicUrl?: string } } | undefined;
        const exposureId = exposureResponse?.exposure?.exposureId;
        const publicToken = exposureResponse?.exposure?.publicUrl
            ? new URL(exposureResponse.exposure.publicUrl).searchParams.get("publicToken")
            : null;
        expect(exposureId).toBeTypeOf("string");
        expect(publicToken).toBeTypeOf("string");

        const revokeReply = createReplyStub();
        await getRouteHandler(app, "DELETE", "/v1/local-services/public/:exposureId")({
            userId: "user_1",
            params: { exposureId },
            body: {
                exposureId,
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
            },
        }, revokeReply);

        expect(revokeReply.statusCode).toBe(200);
        expect(revokeReply.send).toHaveBeenCalledWith({ ok: true });
        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "user_1",
            sessionId: "session_1",
            purpose: "public_revoke",
        });

        const accessReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
            method: "GET",
            params: { exposureId, "*": "index.html" },
            query: { publicToken },
            headers: { host: "app.happier.test" },
        }, accessReply);

        expect(accessReply.statusCode).toBe(403);
        expect(accessReply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "revoked",
        }));
    });

    it("allows composed public exposure creation with explicit local test audit and rate overrides", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                ...peerMediationGrantSigningEnv(),
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: "1",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const previewReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, previewReply);
        expect(previewReply.statusCode).toBe(201);

        const exposureReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                ttlMs: 60_000,
                rateLimitProfileId: "default",
                confirmation: { acknowledged: true },
            },
        }, exposureReply);

        expect(exposureReply.statusCode).toBe(201);
        expect(exposureReply.send).toHaveBeenCalledWith({
            exposure: expect.objectContaining({
                previewId: "preview_1",
                state: "active",
                rateLimitProfileId: "default",
            }),
        });
    });

    it("exchanges the composed public capability URL token once and rejects the consumed original", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                ...peerMediationGrantSigningEnv(),
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: "1",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const previewReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, previewReply);
        expect(previewReply.statusCode).toBe(201);

        const exposureReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                ttlMs: 60_000,
                rateLimitProfileId: "default",
                confirmation: { acknowledged: true },
            },
        }, exposureReply);
        expect(exposureReply.statusCode).toBe(201);

        const exposureResponse = exposureReply.send.mock.calls.at(-1)?.[0] as { exposure?: { exposureId?: string; publicUrl?: string } } | undefined;
        const exposureId = exposureResponse?.exposure?.exposureId;
        const publicToken = exposureResponse?.exposure?.publicUrl
            ? new URL(exposureResponse.exposure.publicUrl).searchParams.get("publicToken")
            : null;
        expect(exposureId).toBeTypeOf("string");
        expect(publicToken).toBeTypeOf("string");

        const exchangeReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public/:exposureId/exchange")({
            params: { exposureId },
            body: { publicToken },
        }, exchangeReply);

        expect(exchangeReply.statusCode).toBe(200);
        const exchangeResponse = exchangeReply.send.mock.calls.at(-1)?.[0] as { protocolVersion?: number; publicToken?: string; exposureId?: string } | undefined;
        expect(exchangeResponse?.protocolVersion).toBe(1);
        expect(exchangeResponse?.exposureId).toBe(exposureId);
        const rotatedToken = exchangeResponse?.publicToken;
        expect(rotatedToken).toBeTypeOf("string");
        expect(rotatedToken).not.toBe(publicToken);
        expect(exchangeReply.headers["Set-Cookie"]).toEqual(expect.stringContaining(`Path=/v1/local-services/public/${exposureId}`));
        expect(exchangeReply.headers["Set-Cookie"]).toEqual(expect.stringContaining("HttpOnly"));

        // Replaying the consumed original URL token is denied.
        const replayReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
            method: "GET",
            params: { exposureId, "*": "index.html" },
            query: { publicToken },
            headers: { host: "app.happier.test" },
        }, replayReply);
        expect(replayReply.statusCode).toBe(403);
        expect(replayReply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "public_token_mismatch",
        }));
    });

    it("keeps composed public exposure fail-closed in production when only local test audit and rate overrides are configured", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                ...peerMediationGrantSigningEnv(),
                NODE_ENV: "production",
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: "1",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const previewReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, previewReply);
        expect(previewReply.statusCode).toBe(201);

        const exposureReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                ttlMs: 60_000,
                rateLimitProfileId: "default",
            },
        }, exposureReply);

        expect(exposureReply.statusCode).toBe(404);
        expect(exposureReply.send).toHaveBeenCalledWith({ error: "not_found" });
    });

    it("allows composed public exposure creation with real local audit and rate dependencies", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const tempDir = mkdtempSync(join(tmpdir(), "happier-public-preview-"));
        const auditPath = join(tempDir, "audit.jsonl");
        try {
            const app = createFakeRouteApp();
            const openTunnel = vi.fn(async () => ({
                tunnelId: "preview_tunnel_test",
                substreamId: "preview_substream_test",
                write: vi.fn(),
                endWrite: vi.fn(),
                read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"]),
                close: vi.fn(),
                abort: vi.fn(),
            }));
            mod.registerLocalServiceRoutes(app as never, {
                env: {
                    ...peerMediationGrantSigningEnv(),
                    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: "jsonl_file",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: auditPath,
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: "fixed_window",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: "60000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                    HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                    HANDY_MASTER_SECRET: "master-secret",
                } as NodeJS.ProcessEnv,
                authorizeSessionAccess: vi.fn(() => true),
                openTunnel,
            });

            const previewReply = createReplyStub();
            await getRouteHandler(app, "POST", "/v1/local-services/preview")({
                userId: "user_1",
                body: preview,
            }, previewReply);
            expect(previewReply.statusCode).toBe(201);

            const exposureReply = createReplyStub();
            await getRouteHandler(app, "POST", "/v1/local-services/public")({
                userId: "user_1",
                body: {
                    previewId: "preview_1",
                    sessionId: "session_1",
                    machineId: "machine_1",
                    mode: "secret_link",
                    ttlMs: 60_000,
                    rateLimitProfileId: "default",
                    confirmation: { acknowledged: true },
                },
            }, exposureReply);

            expect(exposureReply.statusCode).toBe(201);
            expect(exposureReply.send).toHaveBeenCalledWith({
                exposure: expect.objectContaining({
                    previewId: "preview_1",
                    state: "active",
                    rateLimitProfileId: "default",
                }),
            });
            const exposureResponse = exposureReply.send.mock.calls[0]?.[0] as { exposure?: { exposureId?: string; publicUrl?: string } } | undefined;
            const exposureId = exposureResponse?.exposure?.exposureId;
            const publicToken = exposureResponse?.exposure?.publicUrl
                ? new URL(exposureResponse.exposure.publicUrl).searchParams.get("publicToken")
                : null;
            expect(exposureId).toBeTypeOf("string");
            expect(exposureResponse?.exposure?.publicUrl).toMatch(/^https:\/\/[a-z0-9-]+\.preview\.example\.test\//u);
            expect(publicToken).toBeTypeOf("string");

            const exchangeViaUrlReply = createReplyStub();
            await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
                method: "GET",
                params: { exposureId, "*": "index.html" },
                query: { publicToken },
                headers: { host: "app.happier.test" },
            }, exchangeViaUrlReply);
            expect(exchangeViaUrlReply.statusCode).toBe(303);
            const exchangedCookie = exchangeViaUrlReply.headers["Set-Cookie"];
            expect(exchangedCookie).toEqual(expect.stringContaining("happier_public_token="));

            const firstAccessReply = createReplyStub();
            await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
                method: "GET",
                params: { exposureId, "*": "index.html" },
                query: {},
                headers: {
                    host: "app.happier.test",
                    cookie: exchangedCookie,
                },
            }, firstAccessReply);
            expect(firstAccessReply.statusCode).toBe(200);
            expect(openTunnel).toHaveBeenCalledTimes(1);

            const secondAccessReply = createReplyStub();
            await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
                method: "GET",
                params: { exposureId, "*": "index.html" },
                query: {},
                headers: {
                    host: "app.happier.test",
                    cookie: exchangedCookie,
                },
            }, secondAccessReply);
            expect(secondAccessReply.statusCode).toBe(403);
            expect(secondAccessReply.send).toHaveBeenCalledWith(expect.objectContaining({
                reasonCode: "rate_limited",
            }));
            expect(openTunnel).toHaveBeenCalledTimes(1);

            const auditEvents = readFileSync(auditPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(auditEvents).toEqual([
                expect.objectContaining({
                    action: "create",
                    actorId: "user_1",
                    exposureId: expect.any(String),
                }),
                expect.objectContaining({
                    action: "access",
                    exposureId,
                }),
                expect.objectContaining({
                    action: "rate_limit",
                    exposureId,
                }),
                expect.objectContaining({
                    action: "access_denied",
                    exposureId,
                    reasonCode: "rate_limited",
                }),
            ]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("enables composed production self-hosted public exposure with the in-memory limiter when the canonical opt-in is enabled", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const tempDir = mkdtempSync(join(tmpdir(), "happier-public-preview-"));
        const auditPath = join(tempDir, "audit.jsonl");
        try {
            const app = createFakeRouteApp();
            mod.registerLocalServiceRoutes(app as never, {
                env: {
                    ...peerMediationGrantSigningEnv(),
                    NODE_ENV: "production",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: "jsonl_file",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: auditPath,
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: "default",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: "fixed_window",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: "1",
                    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: "60000",
                    [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                    [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                    HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                    HANDY_MASTER_SECRET: "master-secret",
                } as NodeJS.ProcessEnv,
                authorizeSessionAccess: vi.fn(() => true),
            });

            const previewReply = createReplyStub();
            await getRouteHandler(app, "POST", "/v1/local-services/preview")({
                userId: "user_1",
                body: preview,
            }, previewReply);
            expect(previewReply.statusCode).toBe(201);

            const exposureReply = createReplyStub();
            await getRouteHandler(app, "POST", "/v1/local-services/public")({
                userId: "user_1",
                body: {
                    previewId: "preview_1",
                    sessionId: "session_1",
                    machineId: "machine_1",
                    mode: "secret_link",
                    ttlMs: 60_000,
                    rateLimitProfileId: "default",
                    confirmation: { acknowledged: true },
                },
            }, exposureReply);

            expect(exposureReply.statusCode).toBe(201);
            const sendArg = exposureReply.send.mock.calls.at(-1)?.[0] as { exposure?: { mode?: string; state?: string } } | undefined;
            expect(sendArg?.exposure?.mode).toBe("secret_link");
            expect(sendArg?.exposure?.state).toBe("active");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("denies public access after the underlying private preview is unregistered", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        const openTunnel = vi.fn(async () => ({
            tunnelId: "preview_tunnel_test",
            substreamId: "preview_substream_test",
            write: vi.fn(),
            endWrite: vi.fn(),
            read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"]),
            close: vi.fn(),
            abort: vi.fn(),
        }));
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                ...peerMediationGrantSigningEnv(),
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: "preview.example.test",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: "1",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: "secret_link",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: "60000",
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: "0",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: "1",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: "default",
                [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "1",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
            openTunnel,
        });

        const previewReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, previewReply);
        expect(previewReply.statusCode).toBe(201);

        const exposureReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                previewId: "preview_1",
                sessionId: "session_1",
                machineId: "machine_1",
                mode: "secret_link",
                ttlMs: 60_000,
                rateLimitProfileId: "default",
                confirmation: { acknowledged: true },
            },
        }, exposureReply);
        expect(exposureReply.statusCode).toBe(201);

        const exposureResponse = exposureReply.send.mock.calls[0]?.[0] as { exposure?: { exposureId?: string; publicUrl?: string } } | undefined;
        const exposureId = exposureResponse?.exposure?.exposureId;
        const publicToken = exposureResponse?.exposure?.publicUrl
            ? new URL(exposureResponse.exposure.publicUrl).searchParams.get("publicToken")
            : null;
        expect(exposureId).toBeTypeOf("string");
        expect(publicToken).toBeTypeOf("string");

        const unregisterReply = createReplyStub();
        await getRouteHandler(app, "DELETE", "/v1/local-services/preview/:previewId")({
            userId: "user_1",
            params: { previewId: "preview_1" },
        }, unregisterReply);
        expect(unregisterReply.statusCode).toBe(200);

        const accessReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
            method: "GET",
            params: { exposureId, "*": "index.html" },
            query: { publicToken },
            headers: { host: "app.happier.test" },
        }, accessReply);

        expect(accessReply.statusCode).toBe(403);
        expect(accessReply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "preview_not_found",
        }));
        expect(openTunnel).not.toHaveBeenCalled();
    });

    it("serves a registered preview resource through the minted preview token and PMS tunnel seam", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        const tunnelWrites: string[] = [];
        const openTunnel = vi.fn(async () => ({
            tunnelId: "preview_tunnel_test",
            substreamId: "preview_substream_test",
            write: (bytes: Uint8Array) => {
                tunnelWrites.push(new TextDecoder().decode(bytes));
            },
            endWrite: vi.fn(),
            read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"]),
            close: vi.fn(),
            abort: vi.fn(),
        }));

        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
            openTunnel,
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);

        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");
        const previewCookie = await exchangePreviewTokenForCookie({
            app,
            previewToken: previewToken!,
            path: "index.html",
        });

        const dataReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "index.html" },
            query: { vite: "1" },
            headers: { host: "app.happier.test", cookie: previewCookie },
        }, dataReply);

        expect(openTunnel).toHaveBeenCalledWith({
            preview: expect.objectContaining({ previewId: "preview_1" }),
        });
        expect(tunnelWrites.join("")).toContain("GET /index.html?vite=1 HTTP/1.1\r\n");
        expect(dataReply.statusCode).toBe(200);
        expect(dataReply.headers["content-type"]).toBe("text/html");
        expect(dataReply.headers["Set-Cookie"]).toBeUndefined();
    });

    it("emits PMS-9 private preview HTTP observability with the registered account scope", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const emitted: PeerMediationObservabilityEventV1[] = [];
        const app = createFakeRouteApp() as ReturnType<typeof createFakeRouteApp> & {
            peerMediationObservability?: { emit(event: PeerMediationObservabilityEventV1): void };
        };
        app.peerMediationObservability = {
            emit: (event) => {
                emitted.push(event);
            },
        };
        const openTunnel = vi.fn(async () => ({
            tunnelId: "preview_tunnel_test",
            substreamId: "preview_substream_test",
            write: vi.fn(),
            endWrite: vi.fn(),
            read: () => chunks(["HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>"]),
            close: vi.fn(),
            abort: vi.fn(),
        }));

        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
            openTunnel,
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);
        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");
        const previewCookie = await exchangePreviewTokenForCookie({
            app,
            previewToken: previewToken!,
            path: "index.html",
        });

        const dataReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "index.html" },
            query: { vite: "1" },
            headers: { host: "app.happier.test", cookie: previewCookie },
        }, dataReply);

        expect(emitted.map((event) => event.kind)).toEqual([
            "http.request.started",
            "http.request.finished",
        ]);
        expect(emitted.every((event) => event.scope.kind === "machine" && event.scope.accountId === "user_1")).toBe(true);
        expect(emitted.every((event) => event.flow.productRef?.kind === "preview" && event.flow.productRef.id === "preview_1")).toBe(true);
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain("previewToken");
        expect(serialized).not.toContain("happier_preview_token");
    });

    it("emits PMS-9 private preview WebSocket observability with the registered account scope", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const emitted: PeerMediationObservabilityEventV1[] = [];
        const app = createUpgradeRouteApp() as ReturnType<typeof createUpgradeRouteApp> & {
            peerMediationObservability?: { emit(event: PeerMediationObservabilityEventV1): void };
        };
        app.peerMediationObservability = {
            emit: (event) => {
                emitted.push(event);
            },
        };
        const openTunnel = vi.fn(async () => ({
            tunnelId: "preview_tunnel_test",
            substreamId: "preview_substream_test",
            write: vi.fn(),
            endWrite: vi.fn(),
            read: () => chunks([
                switchingProtocolsResponse(["Sec-WebSocket-Protocol: vite-hmr"]),
            ]),
            close: vi.fn(),
            abort: vi.fn(),
        }));

        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
            openTunnel,
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);
        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");
        const previewCookie = await exchangePreviewTokenForCookie({
            app: app as ReturnType<typeof createFakeRouteApp>,
            previewToken: previewToken!,
            path: "@vite/client",
        });

        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/@vite/client",
            headers: {
                host: "app.happier.test",
                cookie: previewCookie,
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-key": ROUTE_WEBSOCKET_KEY,
                "sec-websocket-version": "13",
                "sec-websocket-protocol": "vite-hmr",
            },
            rawHeaders: [
                "Host", "app.happier.test",
                "Cookie", previewCookie,
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "Sec-WebSocket-Key", ROUTE_WEBSOCKET_KEY,
                "Sec-WebSocket-Version", "13",
                "Sec-WebSocket-Protocol", "vite-hmr",
            ],
        }, socket, new Uint8Array());
        await waitForObservabilityEvents(emitted, 2);

        expect(emitted.map((event) => event.kind)).toEqual([
            "websocket.opened",
            "websocket.closed",
        ]);
        expect(emitted.every((event) => event.scope.kind === "machine" && event.scope.accountId === "user_1")).toBe(true);
        expect(emitted.every((event) => event.flow.productRef?.kind === "preview" && event.flow.productRef.id === "preview_1")).toBe(true);
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain("previewToken");
        expect(serialized).not.toContain("happier_preview_token");
    });

    it("serves registered previews through the production PMS relay opener when the app exposes a relay transport factory", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const keyPair = tweetnacl.sign.keyPair();
        const app = createFakeRouteApp() as ReturnType<typeof createFakeRouteApp> & {
            createPeerTcpTunnelRelayTransport?: ReturnType<typeof createProductionRelayHarness>["createRelayTransport"];
        };
        const relay = createProductionRelayHarness();
        app.createPeerTcpTunnelRelayTransport = relay.createRelayTransport;

        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);

        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");
        const previewCookie = await exchangePreviewTokenForCookie({
            app,
            previewToken: previewToken!,
            path: "index.html",
        });

        const dataReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "index.html" },
            query: {},
            headers: { host: "app.happier.test", cookie: previewCookie },
        }, dataReply);

        expect(relay.createRelayTransport).toHaveBeenCalledWith({ accountId: "user_1" });
        expect(relay.sent[0]).toMatchObject({
            v: 1,
            scopeUserId: "user_1",
            recipient: { kind: "machine", machineId: "machine_1" },
            frame: {
                kind: "open",
                open: {
                    routeKind: "server_relay",
                    selectedEncoding: "binary_frame_v2",
                    allowV1Fallback: false,
                },
            },
        });
        expect(dataReply.statusCode).toBe(200);
        expect(dataReply.headers["content-type"]).toBe("text/html");
    });

    it("routes WebSocket preview upgrades through the production PMS relay opener when no test opener is injected", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const keyPair = tweetnacl.sign.keyPair();
        const app = createUpgradeRouteApp() as ReturnType<typeof createUpgradeRouteApp> & {
            createPeerTcpTunnelRelayTransport?: ReturnType<typeof createProductionRelayHarness>["createRelayTransport"];
        };
        const relay = createProductionRelayHarness(
            switchingProtocolsResponse(["Sec-WebSocket-Protocol: vite-hmr"]),
        );
        app.createPeerTcpTunnelRelayTransport = relay.createRelayTransport;

        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: "https://app.happier.test",
                HANDY_MASTER_SECRET: "master-secret",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: "true",
                [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: "5173",
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxBytes]: `${64 * 1024 * 1024}`,
                [FEATURE_ENV_KEYS.machinesTunnelServerRoutedMaxFrameBytes]: `${64 * 1024}`,
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningKeyId]: "grant-key-1",
                [FEATURE_ENV_KEYS.peerMediationRouteGrantSigningPrivateKey]: toBase64Url(keyPair.secretKey),
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);

        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");
        const previewCookie = await exchangePreviewTokenForCookie({
            app: app as ReturnType<typeof createFakeRouteApp>,
            previewToken: previewToken!,
            path: "@vite/client",
        });

        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/@vite/client",
            headers: {
                host: "app.happier.test",
                cookie: previewCookie,
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-key": ROUTE_WEBSOCKET_KEY,
                "sec-websocket-version": "13",
                "sec-websocket-protocol": "vite-hmr",
            },
            rawHeaders: [
                "Host", "app.happier.test",
                "Cookie", previewCookie,
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "Sec-WebSocket-Key", ROUTE_WEBSOCKET_KEY,
                "Sec-WebSocket-Version", "13",
                "Sec-WebSocket-Protocol", "vite-hmr",
            ],
        }, socket, new Uint8Array());
        await waitForSocketWrite(socket);

        expect(relay.createRelayTransport).toHaveBeenCalledWith({ accountId: "user_1" });
        expect(relay.sent[0]).toMatchObject({
            v: 1,
            scopeUserId: "user_1",
            recipient: { kind: "machine", machineId: "machine_1" },
            frame: {
                kind: "open",
                open: {
                    routeKind: "server_relay",
                    selectedEncoding: "binary_frame_v2",
                    allowV1Fallback: false,
                },
            },
        });
        const socketResponse = socket.write.mock.calls.map((call) => new TextDecoder().decode(call[0])).join("");
        expect(socketResponse).toContain("HTTP/1.1 101 Switching Protocols");
        expect(socketResponse).toContain("Sec-WebSocket-Protocol: vite-hmr");
    });

    // F-5 (review gate R1). The preview package's own `it.each` passes `publicBaseUrlSecure` as a
    // direct option, so it pins the CONSUMER — it stays green if this composition site is rewired
    // to a constant. What actually has to hold is the derivation at `registerRoutes.ts:212`:
    // `isHttpsUrl(resolvePublicBaseUrl(env))`. So this drives the whole composition from `env` and
    // nothing else. `env` is the only input that differs between the two rows, so no constant can
    // satisfy both, and wiring the option to the wrong consumer drops `Secure` on the https row.
    it.each([
        { name: "https deployment", publicServerUrl: "https://app.happier.test", expectSecure: true },
        { name: "http deployment", publicServerUrl: "http://app.happier.test", expectSecure: false },
    ])("derives the path-mode exchange cookie's Secure flag from the env public base URL on an $name", async ({ publicServerUrl, expectSecure }) => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: "1",
                HAPPIER_PUBLIC_SERVER_URL: publicServerUrl,
                HANDY_MASTER_SECRET: "master-secret",
            } as NodeJS.ProcessEnv,
            authorizeSessionAccess: vi.fn(() => true),
        });

        const registerReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/preview")({
            userId: "user_1",
            body: preview,
        }, registerReply);
        expect(registerReply.statusCode).toBe(201);

        const registered = registerReply.send.mock.calls[0]?.[0] as { accessUrl?: string } | undefined;
        const previewToken = registered?.accessUrl ? new URL(registered.accessUrl).searchParams.get("previewToken") : null;
        expect(previewToken).toBeTypeOf("string");

        const exchangeReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "" },
            query: { previewToken: previewToken! },
            headers: { host: "app.happier.test" },
        }, exchangeReply);

        expect(exchangeReply.statusCode).toBe(303);
        const setCookie = String(exchangeReply.headers["Set-Cookie"]);
        expect(setCookie).toContain("happier_preview_token=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie.includes("Secure")).toBe(expectSecure);
    });

    it("maps route purposes to the canonical session access levels", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.resolveLocalServiceRouteRequiredAccessLevel).toBeTypeOf("function");
        if (!mod?.resolveLocalServiceRouteRequiredAccessLevel) return;

        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("proxy")).toBe("view");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("register")).toBe("edit");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("unregister")).toBe("edit");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("public_exposure")).toBe("admin");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("public_revoke")).toBe("admin");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("public_status")).toBe("admin");
    });
});
