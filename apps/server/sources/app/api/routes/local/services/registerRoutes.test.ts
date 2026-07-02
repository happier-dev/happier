import type { LocalServicePreviewResourceV1, PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
} from "@happier-dev/protocol";
import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { describe, expect, it, vi } from "vitest";
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

describe("local service API route composition", () => {
    it("registers private preview routes behind the canonical feature gate", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServiceRoutes(app as never, {
            env: {} as NodeJS.ProcessEnv,
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
            env: {} as NodeJS.ProcessEnv,
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
            env: {} as NodeJS.ProcessEnv,
            runtimes: {
                preview: {
                    registerPreview: vi.fn(),
                    resolvePreview: vi.fn(() => preview),
                    resolvePreviewByHost: vi.fn(() => null),
                    resolvePreviewContext: vi.fn(() => ({ resource: preview, accountId: "user_1" })),
                    validateAccess: vi.fn(() => ({ ok: true as const })),
                    unregisterPreview: vi.fn(),
                },
                public: {
                    createExposure: vi.fn(),
                    resolveExposure: vi.fn(),
                    validateAccess: vi.fn(),
                    revokeExposure: vi.fn(),
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

    it("serves a registered preview resource through the minted preview token and PMS tunnel seam", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.registerLocalServiceRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServiceRoutes) return;

        const app = createFakeRouteApp();
        const tunnelWrites: string[] = [];
        const openTunnel = vi.fn(async () => ({
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

        const dataReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "index.html" },
            query: { vite: "1" },
            headers: { host: "app.happier.test", cookie: `happier_preview_token=${previewToken}` },
        }, dataReply);

        expect(openTunnel).toHaveBeenCalledWith({
            preview: expect.objectContaining({ previewId: "preview_1" }),
        });
        expect(tunnelWrites.join("")).toContain("GET /index.html?vite=1 HTTP/1.1\r\n");
        expect(dataReply.statusCode).toBe(200);
        expect(dataReply.headers["content-type"]).toBe("text/html");
        expect(dataReply.headers["Set-Cookie"]).toBeUndefined();
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

        const dataReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*")({
            method: "GET",
            params: { previewId: "preview_1", "*": "index.html" },
            query: {},
            headers: { host: "app.happier.test", cookie: `happier_preview_token=${previewToken}` },
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
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n",
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

        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: `/v1/local-services/preview/preview_1/@vite/client?previewToken=${previewToken}`,
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-protocol": "vite-hmr",
            },
            rawHeaders: [
                "Host", "app.happier.test",
                "Upgrade", "websocket",
                "Connection", "Upgrade",
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

    it("maps route purposes to the canonical session access levels", async () => {
        const mod = await loadLocalServiceRoutesModule();
        expect(mod?.resolveLocalServiceRouteRequiredAccessLevel).toBeTypeOf("function");
        if (!mod?.resolveLocalServiceRouteRequiredAccessLevel) return;

        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("proxy")).toBe("view");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("register")).toBe("edit");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("unregister")).toBe("edit");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("public_exposure")).toBe("admin");
        expect(mod.resolveLocalServiceRouteRequiredAccessLevel("public_revoke")).toBe("admin");
    });
});
