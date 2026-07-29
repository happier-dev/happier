import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { describe, expect, it, vi } from "vitest";
import * as previewRoutesModule from "./registerRoutes";

type PreviewRoutesModule = typeof import("./registerRoutes");
type RegisterLocalServicePreviewRoutes = PreviewRoutesModule["registerLocalServicePreviewRoutes"];
type PreviewProxyHttp = NonNullable<Parameters<RegisterLocalServicePreviewRoutes>[1]["proxyHttp"]>;

async function loadPreviewRoutesModule(): Promise<PreviewRoutesModule> {
    return previewRoutesModule;
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

    function createBackpressureUpgradeSocket() {
        const listeners = new Map<string, Array<() => void>>();
        const socket = {
            write: vi.fn((_chunk: Uint8Array) => false),
            end: vi.fn(),
            destroy: vi.fn(),
            once: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return socket;
            }),
            on: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return socket;
            }),
            off: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
                return socket;
            }),
            emit(event: string) {
                for (const listener of listeners.get(event) ?? []) {
                    listener();
                }
            },
        };
        return socket;
    }

    function createBackpressureRawReply() {
        const listeners = new Map<string, Array<() => void>>();
        const raw = {
            writeHead: vi.fn(),
            write: vi.fn((_chunk: Uint8Array) => false),
            end: vi.fn(),
            destroy: vi.fn(),
            once: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return raw;
            }),
            on: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return raw;
            }),
            off: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
                return raw;
            }),
            removeListener: vi.fn((event: string, listener: () => void) => {
                listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
                return raw;
            }),
            emit(event: string) {
                for (const listener of listeners.get(event) ?? []) {
                    listener();
                }
            },
        };
        return raw;
    }

    it("leaves host wildcard OPTIONS preflight to global CORS", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolvePreviewByHost: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        expect(getRouteEntry(app, "OPTIONS", "/v1/local-services/preview/:previewId/*")).toBeTruthy();
        expect(app.routes.has("OPTIONS /*")).toBe(false);
    });

    it("keeps preview lifecycle authenticated while data-plane handlers use preview-token access", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const exchangeAccessToken = vi.fn(() => ({
            ok: true as const,
            rawToken: "cookie_token_1",
            expiresAt: 61_000,
        }));
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess,
            exchangeAccessToken,
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

    it("passes downstream connection close as an abort signal to the HTTP adapter", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp = vi.fn<PreviewProxyHttp>(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const listeners = new Map<string, Set<() => void>>();
        const raw = {
            writeHead: vi.fn(),
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn((event: string, listener: () => void) => {
                const eventListeners = listeners.get(event) ?? new Set<() => void>();
                eventListeners.add(listener);
                listeners.set(event, eventListeners);
                return raw;
            }),
            off: vi.fn((event: string, listener: () => void) => {
                listeners.get(event)?.delete(listener);
                return raw;
            }),
            removeListener: vi.fn((event: string, listener: () => void) => {
                listeners.get(event)?.delete(listener);
                return raw;
            }),
        };

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        const reply = {
            ...createReplyStub(),
            raw,
        };
        await handler({
            params: { previewId: "preview_1", "*": "assets/app.js" },
            query: {},
            headers: { cookie: "happier_preview_token=token_1" },
            method: "GET",
        }, reply);

        expect(proxyHttp).toHaveBeenCalledTimes(1);
        const firstCall = proxyHttp.mock.calls[0];
        if (!firstCall) throw new Error("expected proxyHttp call");
        const signal = firstCall[0].request.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);

        for (const listener of listeners.get("close") ?? []) listener();

        expect(signal?.aborted).toBe(true);
    });

    it("waits for downstream HTTP response drain before resolving private preview response writes", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createFakeRouteApp();
        const raw = createBackpressureRawReply();
        const proxyHttp = vi.fn<PreviewProxyHttp>(async (input) => {
            input.response.writeHead(200, "OK", { "content-type": "text/plain" });
            let writeResolved = false;
            void Promise.resolve(input.response.write(new Uint8Array([1]))).then(() => {
                writeResolved = true;
            });

            await Promise.resolve();
            expect(writeResolved).toBe(false);
            raw.emit("drain");
            await Promise.resolve();
            expect(writeResolved).toBe(true);

            return { ok: true as const };
        });
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/preview/:previewId/*");
        await handler({
            params: { previewId: "preview_1", "*": "assets/app.js" },
            query: {},
            headers: { cookie: "happier_preview_token=token_1" },
            method: "GET",
        }, {
            ...createReplyStub(),
            raw,
        });

        expect(raw.write).toHaveBeenCalledWith(new Uint8Array([1]));
        expect(raw.once).toHaveBeenCalledWith("drain", expect.any(Function));
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
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        const exchangeAccessToken = vi.fn(() => ({
            ok: true as const,
            rawToken: "cookie_token_1",
            expiresAt: 61_000,
        }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess,
            exchangeAccessToken,
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

        expect(validateAccess).not.toHaveBeenCalled();
        expect(exchangeAccessToken).toHaveBeenCalledWith({
            previewId: "preview_1",
            rawToken: "token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        });
        expect(reply.statusCode).toBe(303);
        expect(reply.headers["Set-Cookie"]).toContain("happier_preview_token=cookie_token_1");
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
            hostOriginBaseDomain: "preview.example.test",
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        } as never);

        expect(getRouteEntry(app, "GET", "/*").opts.constraints).toEqual({
            host: expect.any(RegExp),
        });
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

    it("waits for downstream socket drain before resolving private preview WebSocket writes", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        const socket = createBackpressureUpgradeSocket();
        const proxyWebSocket = vi.fn<NonNullable<Parameters<RegisterLocalServicePreviewRoutes>[1]["proxyWebSocket"]>>(async (input) => {
            let writeResolved = false;
            void Promise.resolve(input.request.client.write(new Uint8Array([1]))).then(() => {
                writeResolved = true;
            });

            await Promise.resolve();
            expect(writeResolved).toBe(false);
            socket.emit("drain");
            await Promise.resolve();
            expect(writeResolved).toBe(true);

            return { ok: true as const };
        });

        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: true as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket,
        });

        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/@vite/client?previewToken=token_1",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        expect(socket.write).toHaveBeenCalledWith(new Uint8Array([1]));
        expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
    });

    it("dispatches host-origin preview WebSocket upgrades by host label", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const hostPreview: LocalServicePreviewResourceV1 = {
            ...preview,
            previewId: "preview_1",
            originMode: "host",
        };
        const app = createUpgradeRouteApp();
        const resolvePreviewByHost = vi.fn(() => hostPreview);
        const validateAccess = vi.fn(() => ({ ok: true as const }));
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => null),
            resolvePreviewByHost,
            hostOriginBaseDomain: "preview.example.test",
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket,
        } as never);

        const socket = {
            write: vi.fn(),
            end: vi.fn(),
            destroy: vi.fn(),
            on: vi.fn(),
        };
        await app.upgradeHandlers[0]?.({
            url: "/@vite/client?previewToken=token_1&hmr=1",
            headers: {
                host: "preview-1.preview.example.test",
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-protocol": "vite-hmr",
            },
            rawHeaders: [
                "Host", "preview-1.preview.example.test",
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "Sec-WebSocket-Protocol", "vite-hmr",
            ],
        }, socket, new Uint8Array());

        expect(resolvePreviewByHost).toHaveBeenCalledWith("preview-1.preview.example.test");
        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            previewId: "preview_1",
            rawToken: "token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        }));
        expect(proxyWebSocket).toHaveBeenCalledWith(expect.objectContaining({
            preview: hostPreview,
            request: expect.objectContaining({
                path: "/@vite/client",
                search: "?hmr=1",
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

    it("waits for downstream drain before closing private preview WebSocket error responses", async () => {
        const mod = await loadPreviewRoutesModule();
        expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePreviewRoutes) return;

        const app = createUpgradeRouteApp();
        const socket = createBackpressureUpgradeSocket();
        mod.registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "token_mismatch" })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket: vi.fn(async () => ({ ok: true as const })),
        });

        const pending = Promise.resolve(app.upgradeHandlers[0]?.({
            url: "/v1/local-services/preview/preview_1/socket?previewToken=bad",
            headers: {
                host: "app.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array()));

        await Promise.resolve();
        expect(socket.write).toHaveBeenCalled();
        expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
        expect(socket.destroy).not.toHaveBeenCalled();

        socket.emit("drain");
        await pending;
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("401 Unauthorized");
        expect(socket.destroy).toHaveBeenCalled();
    });

    it.each(["close", "error"] as const)(
        "closes private preview WebSocket error responses when the downstream emits %s before drain",
        async (event) => {
            const mod = await loadPreviewRoutesModule();
            expect(mod?.registerLocalServicePreviewRoutes).toBeTypeOf("function");
            if (!mod?.registerLocalServicePreviewRoutes) return;

            const app = createUpgradeRouteApp();
            const socket = createBackpressureUpgradeSocket();
            mod.registerLocalServicePreviewRoutes(app as never, {
                resolvePreview: vi.fn(() => preview),
                validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "token_mismatch" })),
                authorizeSessionAccess: allowSessionAccess(),
                proxyHttp: vi.fn(async () => ({ ok: true as const })),
                proxyWebSocket: vi.fn(async () => ({ ok: true as const })),
            });

            const pending = Promise.resolve(app.upgradeHandlers[0]?.({
                url: "/v1/local-services/preview/preview_1/socket?previewToken=bad",
                headers: {
                    host: "app.happier.test",
                    upgrade: "websocket",
                    connection: "Upgrade",
                },
                rawHeaders: [],
            }, socket, new Uint8Array()));

            await Promise.resolve();
            expect(socket.write).toHaveBeenCalled();
            expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
            expect(socket.destroy).not.toHaveBeenCalled();

            socket.emit(event);
            await expect(pending).resolves.toBeUndefined();
            expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("401 Unauthorized");
            expect(socket.destroy).toHaveBeenCalled();
        },
    );

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
