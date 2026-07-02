import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "@/app/api/testkit/routeHarness";
import fastifyCors from "@fastify/cors";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

type PreviewRoutesModule = typeof import("./registerRoutes");

async function loadPreviewRoutesModule(): Promise<PreviewRoutesModule | null> {
    return import("./registerRoutes.js").catch(() => null) as Promise<PreviewRoutesModule | null>;
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
    policy: {
        allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"],
        cookiePolicy: "drop",
        compressionPolicy: "identity",
        redirectPolicy: "rewrite_path_mode",
        maxRequestBodyBytes: 1024 * 1024,
        maxResponseBodyBytes: 1024 * 1024,
    },
};

describe("local service preview routes", () => {
    function allowSessionAccess() {
        return vi.fn(() => true);
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

    it("composes host wildcard data-plane routes with global CORS preflight", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = Fastify({ logger: false });
        app.decorate("authenticate", async () => {});
        app.register(fastifyCors, {
            origin: "*",
            allowedHeaders: ["authorization", "content-type"],
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        });
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolvePreviewByHost: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        try {
            await app.ready();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("keeps preview lifecycle authenticated while data-plane handlers use preview-token access", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const route = getRouteEntry(app, "GET", "/v1/local-services/preview/:previewId/*");
        expect(route.opts.preHandler).toBeUndefined();
        expect(route.opts.exposeHeadRoute).toBe(false);
        expect(getRouteEntry(app, "POST", "/v1/local-services/preview/:previewId/*").opts.preHandler).toBeUndefined();
        expect(app.routes.get("HEAD /v1/local-services/preview/:previewId/*")?.opts.preHandler).toBeUndefined();
        expect(app.routes.get("OPTIONS /v1/local-services/preview/:previewId/*")?.opts.preHandler).toBeUndefined();
        expect(getRouteEntry(app, "POST", "/v1/local-services/preview").opts.preHandler).toBe(app.authenticate);
        expect(getRouteEntry(app, "DELETE", "/v1/local-services/preview/:previewId").opts.preHandler).toBe(app.authenticate);
    });

    it("validates cookie token access and passes the preserved path/query to the HTTP adapter", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            params: { previewId: "preview_1", "*": "assets/app.js" },
            query: { v: "1" },
            headers: { host: "app.happier.test", cookie: "happier_preview_token=token_1" },
            method: "GET",
        }, reply);

        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            previewId: "preview_1",
            rawToken: "token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        }));
        expect(proxyHttp).toHaveBeenCalledWith(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                method: "GET",
                path: "/assets/app.js",
                search: "?v=1",
            }),
        }));
    });

    it("fails closed when preview access is missing", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "token_mismatch" })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            params: { previewId: "preview_1", "*": "" },
            query: {},
            headers: {},
            method: "GET",
        }, reply);

        expect(proxyHttp).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(401);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            error: "preview_access_denied",
        }));
    });

    it("treats malformed preview token cookies as missing token material", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: false as const, reasonCode: "preview_token_missing" }));
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            params: { previewId: "preview_1", "*": "" },
            query: {},
            headers: { cookie: "happier_preview_token=%" },
            method: "GET",
        }, reply);

        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            rawToken: null,
        }));
        expect(proxyHttp).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(401);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "preview_token_missing",
        }));
    });

    it("registers a private preview resource through the runtime owner", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const registerPreview = vi.fn(() => ({
            ok: true as const,
            resource: preview,
            accessUrl: "https://app.happier.test/v1/local-services/preview/preview_1/?previewToken=token_1",
            expiresAt: 61_000,
        }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            registerPreview,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/preview");
        const reply = createReplyStub();
        await handler({ userId: "user_1", body: preview }, reply);

        expect(registerPreview).toHaveBeenCalledWith({
            resource: preview,
            accountId: "user_1",
        });
        expect(reply.statusCode).toBe(201);
        expect(reply.send).toHaveBeenCalledWith({
            resource: preview,
            accessUrl: "https://app.happier.test/v1/local-services/preview/preview_1/?previewToken=token_1",
            expiresAt: 61_000,
        });
    });

    it("fails closed before registering a preview when session access is denied", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const registerPreview = vi.fn(() => ({
            ok: true as const,
            resource: preview,
            accessUrl: "https://app.happier.test/v1/local-services/preview/preview_1/?previewToken=token_1",
            expiresAt: 61_000,
        }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: vi.fn(() => false),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            registerPreview,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/preview");
        const reply = createReplyStub();
        await handler({ userId: "user_2", body: preview }, reply);

        expect(registerPreview).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "session_not_authorized",
        }));
    });

    it("allows cookie-token-authenticated data-plane requests without bearer session auth", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: vi.fn(() => false),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = createReplyStub();
        await handler({
            userId: "user_2",
            params: { previewId: "preview_1", "*": "" },
            query: {},
            headers: { cookie: "happier_preview_token=token_1" },
            method: "GET",
        }, reply);

        expect(proxyHttp).toHaveBeenCalled();
        expect(reply.send).not.toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "session_not_authorized",
        }));
    });

    it("routes token-authenticated OPTIONS preflight through the preview data-plane", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: vi.fn(() => false),
            proxyHttp,
        });

        const entry = app.routes.get("OPTIONS /v1/local-services/preview/:previewId/*");
        expect(entry?.handler).toBeTypeOf("function");
        const reply = createReplyStub();
        await entry?.handler({
            params: { previewId: "preview_1", "*": "api/data" },
            query: {},
            headers: {
                cookie: "happier_preview_token=token_1",
                origin: "https://app.happier.test",
                "access-control-request-method": "PUT",
            },
            method: "OPTIONS",
        }, reply);

        expect(proxyHttp).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                method: "OPTIONS",
                path: "/api/data",
                search: "",
            }),
        }));
    });

    it("exchanges query preview tokens into a scoped HTTP-only preview cookie and redirects to a tokenless URL", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = createReplyStub();
        await handler({
            params: { previewId: "preview_1", "*": "" },
            query: { previewToken: "token_1", v: "1" },
            headers: {},
            method: "GET",
        }, reply);

        expect(reply.statusCode).toBe(303);
        expect(reply.headers["Set-Cookie"]).toContain("happier_preview_token=token_1");
        expect(reply.headers["Set-Cookie"]).toContain("Path=/v1/local-services/preview/preview_1/");
        expect(reply.headers["Set-Cookie"]).toContain("HttpOnly");
        expect(reply.headers.Location).toBe("/v1/local-services/preview/preview_1/?v=1");
    });

    it("dispatches host-origin preview HTTP requests by host label", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const hostPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            previewId: "preview_1",
            originMode: "host",
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
        };
        const app = createFakeRouteApp();
        const resolvePreviewByHost = vi.fn(() => hostPreview);
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => null),
            resolvePreviewByHost,
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        } as never);

        const handler = getRouteHandler(app, "GET", "/*");
        const reply = createReplyStub();
        await handler({
            params: { "*": "dashboard" },
            query: { v: "1" },
            headers: {
                host: "preview-1.preview.example.test",
                cookie: "happier_preview_token=token_1",
            },
            method: "GET",
        }, reply);

        expect(resolvePreviewByHost).toHaveBeenCalledWith("preview-1.preview.example.test");
        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            previewId: "preview_1",
            rawToken: "token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        }));
        expect(proxyHttp).toHaveBeenCalledWith(expect.objectContaining({
            preview: hostPreview,
            request: expect.objectContaining({
                method: "GET",
                path: "/dashboard",
                search: "?v=1",
            }),
        }));
    });

    it("unregisters a private preview resource through the runtime owner", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const unregisterPreview = vi.fn(() => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            unregisterPreview,
        });

        const handler = getRouteHandler(app, "DELETE", "/v1/local-services/preview/:previewId");
        const reply = createReplyStub();
        await handler({ userId: "user_1", params: { previewId: "preview_1" } }, reply);

        expect(unregisterPreview).toHaveBeenCalledWith("preview_1");
        expect(reply.send).toHaveBeenCalledWith({ ok: true });
    });

    it("registers a raw WebSocket upgrade handler that validates preview token access", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket,
        });

        expect(app.server.on).toHaveBeenCalledWith("upgrade", expect.any(Function));
        const socket = {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn(),
        };
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/@vite/client?previewToken=token_1&v=1",
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

        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            previewId: "preview_1",
            rawToken: "token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        }));
        expect(proxyWebSocket).toHaveBeenCalledWith(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                path: "/@vite/client",
                search: "?v=1",
                rawHeaders: expect.arrayContaining(["Sec-WebSocket-Protocol", "vite-hmr"]),
            }),
        }));
    });

    it("fails WebSocket upgrades closed before proxying when preview token access is denied", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "token_mismatch" })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket,
        });

        const socket = {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn(),
        };
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/socket?previewToken=bad",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        expect(proxyWebSocket).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("401 Unauthorized");
        expect(socket.destroy).toHaveBeenCalled();
    });

    it("fails WebSocket upgrades closed when the proxy transport rejects", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket: vi.fn(async () => {
                throw new Error("transport down");
            }),
        });

        const socket = {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn(),
        };
        app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/socket?previewToken=token_1",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("502 Bad Gateway");
        expect(socket.destroy).toHaveBeenCalled();
    });

    it("fails malformed WebSocket preview paths closed instead of throwing", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket,
        });

        const socket = {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn(),
        };
        app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/%/socket?previewToken=token_1",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(proxyWebSocket).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("400 Bad Request");
        expect(socket.destroy).toHaveBeenCalled();
    });
});
