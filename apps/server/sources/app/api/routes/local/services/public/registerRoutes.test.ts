import type {
    LocalServicePreviewResourceV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
    PeerMediationObservabilityEventV1,
} from "@happier-dev/protocol";
import { auth } from "@/app/auth/auth";
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { createPeerMediationWebSocketEvent } from "@/app/api/socket/peer/mediation/observability/events";
import { describe, expect, it, vi } from "vitest";
import type { RegisterLocalServicePublicRoutesOptions } from "./registerRoutes";

const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: (...args: unknown[]) => dbAccountFindUniqueMock(...args),
        },
    },
}));

type PublicRoutesModule = typeof import("./registerRoutes");

async function loadPublicRoutesModule(): Promise<PublicRoutesModule | null> {
    return import("./registerRoutes.js").catch(() => null) as Promise<PublicRoutesModule | null>;
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

const exposure: LocalServicePublicExposureV1 = {
    exposureId: "public_preview_1",
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    mode: "secret_link",
    state: "active",
    publicUrl: "https://preview.happier.test/v1/local-services/public/public_preview_1?publicToken=token_1",
    issuedAt: 1_000,
    expiresAt: 61_000,
    auditEventIds: ["audit_create_1"],
    rateLimitProfileId: "default",
};

const publicSnapshot: LocalServicePublicPreviewSnapshotV1 = {
    v: 1,
    machineId: "machine_1",
    sessionId: "session_1",
    previewId: "preview_1",
    generatedAt: 2_000,
    refreshState: "idle",
    policy: {
        enabled: true,
        allowedModes: ["secret_link"],
        maxTtlMs: 60_000,
        dnsTlsRequired: false,
        auditRequired: true,
        rateLimitProfileIds: [],
    },
    exposures: [exposure],
    diagnostics: [],
};

async function decodeBody(body: AsyncIterable<Uint8Array> | undefined): Promise<string> {
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of body ?? []) {
        out += decoder.decode(chunk);
    }
    return out;
}

describe("local service public exposure routes", () => {
    // The upgrade path awaits the caller's identity resolution (S-2) before it writes, so tests
    // that observe an in-flight write must drain the queue rather than count microtasks.
    async function flushAsyncWork(): Promise<void> {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }

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
            async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
                return;
            },
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

    it("registers authenticated public exposure control routes and an unauthenticated read route", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        expect(getRouteEntry(app, "POST", "/v1/local-services/public").opts.preHandler).toBe(app.authenticate);
        expect(getRouteEntry(app, "POST", "/v1/local-services/public/status").opts.preHandler).toBe(app.authenticate);
        expect(getRouteEntry(app, "DELETE", "/v1/local-services/public/:exposureId").opts.preHandler).toBe(app.authenticate);
        const rootReadRoute = getRouteEntry(app, "GET", "/v1/local-services/public/:exposureId");
        expect(rootReadRoute.opts.preHandler).toBeUndefined();
        expect(rootReadRoute.opts.exposeHeadRoute).toBe(false);
        const readRoute = getRouteEntry(app, "GET", "/v1/local-services/public/:exposureId/*");
        expect(readRoute.opts.preHandler).toBeUndefined();
        expect(readRoute.opts.exposeHeadRoute).toBe(false);
        expect(getRouteEntry(app, "POST", "/v1/local-services/public/:exposureId/*").opts.preHandler).toBeUndefined();
        expect(getRouteEntry(app, "OPTIONS", "/v1/local-services/public/:exposureId/*").opts.preHandler).toBeUndefined();
    });

    it("creates a public exposure only for a resolved private preview", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        const authorizeSessionAccess = allowSessionAccess();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess,
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            dnsTlsValid: true,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                rateLimitProfileId: "default",
                confirmation: { acknowledged: true },
            },
        }, reply);

        expect(createExposure).toHaveBeenCalledWith({
            preview,
            requestedMode: "secret_link",
            requestedTtlMs: 120_000,
            actorId: "user_1",
            sessionAuthorized: true,
            dnsTlsValid: true,
            rateLimitProfileId: "default",
        });
        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "user_1",
            sessionId: "session_1",
            purpose: "public_exposure",
        });
        expect(reply.statusCode).toBe(201);
        expect(reply.send).toHaveBeenCalledWith({ exposure });
    });

    it("rejects public exposure creation when confirmation acknowledgement is missing", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                rateLimitProfileId: "default",
            },
        }, reply);

        expect(createExposure).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "confirmation_required",
        }));
    });

    it("rejects public exposure creation before mutation when the requested binding does not match the preview", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        const authorizeSessionAccess = allowSessionAccess();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess,
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            body: {
                machineId: "machine_2",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                confirmation: { acknowledged: true },
            },
        }, reply);

        expect(createExposure).not.toHaveBeenCalled();
        expect(authorizeSessionAccess).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "preview_binding_mismatch",
        }));
    });

    it("returns an authenticated public preview status snapshot after admin session authorization", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const getStatus = vi.fn(() => publicSnapshot);
        const authorizeSessionAccess = allowSessionAccess();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess,
            getStatus,
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public/status");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
            },
        }, reply);

        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "user_1",
            sessionId: "session_1",
            purpose: "public_status",
        });
        expect(getStatus).toHaveBeenCalledWith({
            machineId: "machine_1",
            sessionId: "session_1",
            previewId: "preview_1",
        });
        expect(reply.send).toHaveBeenCalledWith({
            protocolVersion: 1,
            snapshot: publicSnapshot,
        });
    });

    it("keeps public HTTP control and proxy routes behind the featureEnabled gate", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const proxyHttp = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
            featureEnabled: () => false,
        });

        const createReply = createReplyStub();
        await getRouteHandler(app, "POST", "/v1/local-services/public")({
            userId: "user_1",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                rateLimitProfileId: "default",
            },
        }, createReply);

        expect(createReply.statusCode).toBe(404);
        expect(createReply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(createExposure).not.toHaveBeenCalled();

        const proxyReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*")({
            params: { exposureId: "public_preview_1", "*": "assets/app.js" },
            query: { publicToken: "token_1" },
            headers: { host: "preview.happier.test" },
            method: "GET",
        }, proxyReply);

        expect(proxyReply.statusCode).toBe(404);
        expect(proxyReply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(validateAccess).not.toHaveBeenCalled();
        expect(proxyHttp).not.toHaveBeenCalled();
    });

    it("does not assume DNS/TLS readiness when creating a public exposure", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                confirmation: { acknowledged: true },
            },
        }, reply);

        expect(createExposure).toHaveBeenCalledWith(expect.objectContaining({
            dnsTlsValid: false,
        }));
    });

    it("fails closed before creating a public exposure when session access is denied", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const createExposure = vi.fn(() => ({ ok: true as const, exposure }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure,
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: vi.fn(() => false),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public");
        const reply = createReplyStub();
        await handler({
            userId: "user_2",
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                confirmation: { acknowledged: true },
            },
        }, reply);

        expect(createExposure).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "session_not_authorized",
        }));
    });

    it("fails closed before revoking a public exposure when session access is denied", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const revokeExposure = vi.fn(() => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure,
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: vi.fn(() => false),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "DELETE", "/v1/local-services/public/:exposureId");
        const reply = createReplyStub();
        await handler({
            userId: "user_2",
            params: { exposureId: "public_preview_1" },
            body: {
                machineId: "machine_1",
                sessionId: "session_1",
                previewId: "preview_1",
                exposureId: "public_preview_1",
            },
        }, reply);

        expect(revokeExposure).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "session_not_authorized",
        }));
    });

    it("rejects public exposure revocation before mutation when the requested binding does not match the exposure", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const revokeExposure = vi.fn(() => ({ ok: true as const }));
        const authorizeSessionAccess = allowSessionAccess();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure,
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess,
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "DELETE", "/v1/local-services/public/:exposureId");
        const reply = createReplyStub();
        await handler({
            userId: "user_1",
            params: { exposureId: "public_preview_1" },
            body: {
                machineId: "machine_2",
                sessionId: "session_1",
                previewId: "preview_1",
                exposureId: "public_preview_1",
            },
        }, reply);

        expect(revokeExposure).not.toHaveBeenCalled();
        expect(authorizeSessionAccess).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "exposure_binding_mismatch",
        }));
    });

    it("validates public access before proxying a public request", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const proxyInputs: Parameters<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>[0][] = [];
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            proxyInputs.push(input);
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1", "*": "assets/app.js" },
            query: { v: "1" },
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "GET",
        }, reply);

        expect(validateAccess).toHaveBeenCalledWith({
            exposureId: "public_preview_1",
            rawToken: "cookie_token_1",
            authenticated: false,
            sessionAuthorized: false,
            clientKey: "unknown",
        });
        expect(proxyInputs[0]).toEqual(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                path: "/assets/app.js",
                search: "?v=1",
            }),
        }));
    });

    it("adds no-referrer privacy headers to public preview HTTP responses", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            input.response.writeHead(200, "OK", {
                "content-type": "text/html",
                "referrer-policy": "unsafe-url",
            });
            input.response.end();
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1", "*": "index.html" },
            query: {},
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "GET",
        }, reply);

        expect(reply.headers["Referrer-Policy"]).toBe("no-referrer");
        expect(reply.headers["referrer-policy"]).toBeUndefined();
    });

    it("adds no-referrer privacy headers to public preview access errors", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "public_token_mismatch" as const })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1", "*": "index.html" },
            query: {},
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "GET",
        }, reply);

        expect(reply.statusCode).toBe(403);
        expect(reply.headers["Referrer-Policy"]).toBe("no-referrer");
    });

    it("adds no-referrer privacy headers to disabled public preview not-found responses", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            featureEnabled: () => false,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1" },
            query: { publicToken: "token_1" },
            headers: { host: "preview.happier.test" },
            method: "GET",
        }, reply);

        expect(reply.statusCode).toBe(404);
        expect(reply.headers["Referrer-Policy"]).toBe("no-referrer");
    });

    it("exchanges the minted root public exposure URL before proxying", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const exchangeAccessToken = vi.fn(() => ({
            ok: true as const,
            exposureId: "public_preview_1",
            rawToken: "cookie_token_1",
            expiresAt: 61_000,
        }));
        const proxyInputs: Parameters<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>[0][] = [];
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            proxyInputs.push(input);
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            exchangeAccessToken,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const publicUrl = new URL(exposure.publicUrl);
        expect(publicUrl.pathname).toBe("/v1/local-services/public/public_preview_1");
        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1" },
            query: Object.fromEntries(publicUrl.searchParams),
            headers: { host: publicUrl.host },
            method: "GET",
        }, reply);

        expect(validateAccess).not.toHaveBeenCalled();
        expect(proxyInputs).toEqual([]);
        expect(exchangeAccessToken).toHaveBeenCalledWith({
            exposureId: "public_preview_1",
            rawToken: "token_1",
        });
        expect(reply.statusCode).toBe(303);
        expect(reply.headers["Set-Cookie"]).toContain("happier_public_token=cookie_token_1");
        expect(reply.headers["Set-Cookie"]).toContain("Path=/v1/local-services/public/public_preview_1");
        expect(reply.headers["Set-Cookie"]).toContain("HttpOnly");
        expect(reply.headers.Location).toBe("/v1/local-services/public/public_preview_1");
    });

    it("proxies public exposure requests with an exchanged public cookie token", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const proxyInputs: Parameters<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>[0][] = [];
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            proxyInputs.push(input);
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1" },
            query: { v: "1" },
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "GET",
        }, reply);

        expect(validateAccess).toHaveBeenCalledWith({
            exposureId: "public_preview_1",
            rawToken: "cookie_token_1",
            authenticated: false,
            sessionAuthorized: false,
            clientKey: "unknown",
        });
        expect(proxyInputs[0]).toEqual(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                path: "/",
                search: "?v=1",
            }),
        }));
    });

    it("passes downstream connection close as an abort signal to the public HTTP adapter", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const proxyHttp = vi.fn<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>(async () => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
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

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = {
            ...createReplyStub(),
            raw,
        };
        await handler({
            params: { exposureId: "public_preview_1", "*": "assets/app.js" },
            query: {},
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
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

    it("waits for downstream HTTP response drain before resolving public preview response writes", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const raw = createBackpressureRawReply();
        const proxyHttp = vi.fn<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>(async (input) => {
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
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        await handler({
            params: { exposureId: "public_preview_1", "*": "assets/app.js" },
            query: {},
            headers: {
                host: "preview.happier.test",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "GET",
        }, {
            ...createReplyStub(),
            raw,
        });

        expect(raw.write).toHaveBeenCalledWith(new Uint8Array([1]));
        expect(raw.once).toHaveBeenCalledWith("drain", expect.any(Function));
    });

    it("forwards public mutation requests through the preview adapter after access validation", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const proxyInputs: Parameters<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>[0][] = [];
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            proxyInputs.push(input);
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "POST", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1", "*": "api/save" },
            query: {},
            headers: {
                "content-type": "application/json",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "POST",
            body: { name: "preview" },
        }, reply);

        const forwardedInput = proxyInputs[0];
        expect(forwardedInput).toBeDefined();
        if (!forwardedInput) return;
        const forwardedRequest = forwardedInput.request;
        expect(forwardedRequest).toEqual(expect.objectContaining({
            method: "POST",
            path: "/api/save",
            search: "",
        }));
        await expect(decodeBody(forwardedRequest?.body)).resolves.toBe(JSON.stringify({ name: "preview" }));
    });

    it("forwards public OPTIONS preflight through the preview adapter after access validation", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        const proxyInputs: Parameters<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]>>[0][] = [];
        const proxyHttp: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyHttp"]> = async (input) => {
            proxyInputs.push(input);
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp,
        });

        const handler = getRouteHandler(app, "OPTIONS", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            params: { exposureId: "public_preview_1", "*": "api/save" },
            query: {},
            headers: {
                origin: "https://consumer.example",
                "access-control-request-method": "PUT",
                cookie: "happier_public_token=cookie_token_1",
            },
            method: "OPTIONS",
        }, reply);

        expect(proxyInputs[0]?.request).toEqual(expect.objectContaining({
            method: "OPTIONS",
            path: "/api/save",
            search: "",
        }));
    });

    it("treats a valid bearer token as authenticated without requiring the strict auth prehandler", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = "public-preview-route-auth-secret";
        dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0 });
        await auth.init();
        const token = await auth.createToken("user_1");
        const app = createFakeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        try {
            await handler({
                params: { exposureId: "public_preview_1", "*": "" },
                query: {},
                headers: { authorization: `Bearer ${token}` },
                method: "GET",
            }, reply);
        } finally {
            if (typeof previousMasterSecret === "string") {
                process.env.HANDY_MASTER_SECRET = previousMasterSecret;
            } else {
                delete process.env.HANDY_MASTER_SECRET;
            }
        }

        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            authenticated: true,
        }));
        expect(app.authenticate).not.toHaveBeenCalled();
    });

    it("routes exchanged-cookie public WebSocket upgrades through the shared preview adapter", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createUpgradeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            openTunnel: vi.fn(),
            proxyWebSocket,
        } as never);

        expect(app.server.on).toHaveBeenCalledWith("upgrade", expect.any(Function));
        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/@vite/client?v=1",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
                cookie: "happier_public_token=cookie_token_1",
                "sec-websocket-protocol": "vite-hmr",
            },
            rawHeaders: [
                "Host", "preview.happier.test",
                "Upgrade", "websocket",
                "Connection", "Upgrade",
                "Cookie", "happier_public_token=cookie_token_1",
                "Sec-WebSocket-Protocol", "vite-hmr",
            ],
        }, socket, new Uint8Array([1, 2, 3]));

        expect(validateAccess).toHaveBeenCalledWith({
            exposureId: "public_preview_1",
            rawToken: "cookie_token_1",
            authenticated: false,
            sessionAuthorized: false,
            clientKey: "unknown",
        });
        expect(proxyWebSocket).toHaveBeenCalledWith(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                path: "/@vite/client",
                search: "?v=1",
                headers: expect.objectContaining({
                    upgrade: "websocket",
                    connection: "Upgrade",
                }),
                rawHeaders: expect.arrayContaining(["Sec-WebSocket-Protocol", "vite-hmr"]),
                head: new Uint8Array([1, 2, 3]),
                client: expect.objectContaining({
                    write: expect.any(Function),
                    read: expect.any(Function),
                    end: expect.any(Function),
                    destroy: expect.any(Function),
                }),
            }),
        }));
        expect(socket.destroy).not.toHaveBeenCalled();
    });

    it("rejects public WebSocket upgrades that try to use the URL exchange token directly", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createUpgradeRouteApp();
        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            openTunnel: vi.fn(),
            proxyWebSocket,
        } as never);

        const socket = createUpgradeSocket();
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/@vite/client?publicToken=token_1&v=1",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        expect(validateAccess).not.toHaveBeenCalled();
        expect(proxyWebSocket).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("403 Forbidden");
    });

    it("waits for downstream socket drain before resolving public preview WebSocket writes", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createUpgradeRouteApp();
        const socket = createBackpressureUpgradeSocket();
        const proxyWebSocket = vi.fn<NonNullable<RegisterLocalServicePublicRoutesOptions["proxyWebSocket"]>>(async (input) => {
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

        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            openTunnel: vi.fn(),
            proxyWebSocket,
        } as never);

        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/@vite/client",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
                cookie: "happier_public_token=cookie_token_1",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        expect(socket.write).toHaveBeenCalledWith(new Uint8Array([1]));
        expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
    });

    it("waits for downstream drain before closing public preview WebSocket error responses", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createUpgradeRouteApp();
        const socket = createBackpressureUpgradeSocket();
        const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "public_token_mismatch" })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            openTunnel: vi.fn(),
            proxyWebSocket,
        } as never);

        const pending = Promise.resolve(app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/@vite/client",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
                cookie: "happier_public_token=bad",
            },
            rawHeaders: [],
        }, socket, new Uint8Array()));

        await flushAsyncWork();
        expect(socket.write).toHaveBeenCalled();
        expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
        expect(socket.destroy).not.toHaveBeenCalled();

        socket.emit("drain");
        await pending;
        expect(proxyWebSocket).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("403 Forbidden");
        expect(socket.destroy).toHaveBeenCalled();
    });

    it.each(["close", "error"] as const)(
        "closes public preview WebSocket error responses when the downstream emits %s before drain",
        async (event) => {
            const mod = await loadPublicRoutesModule();
            expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
            if (!mod?.registerLocalServicePublicRoutes) return;

            const app = createUpgradeRouteApp();
            const socket = createBackpressureUpgradeSocket();
            const proxyWebSocket = vi.fn(async () => ({ ok: true as const }));
            mod.registerLocalServicePublicRoutes(app as never, {
                resolvePreview: vi.fn(() => preview),
                createExposure: vi.fn(() => ({ ok: true as const, exposure })),
                revokeExposure: vi.fn(() => ({ ok: true as const })),
                validateAccess: vi.fn(() => ({ ok: false as const, reasonCode: "public_token_mismatch" })),
                authorizeSessionAccess: allowSessionAccess(),
                proxyHttp: vi.fn(async () => ({ ok: true as const })),
                openTunnel: vi.fn(),
                proxyWebSocket,
            } as never);

            const pending = Promise.resolve(app.upgradeHandlers[0]?.({
                url: "/v1/local-services/public/public_preview_1/@vite/client",
                headers: {
                    host: "preview.happier.test",
                    upgrade: "websocket",
                    connection: "Upgrade",
                    cookie: "happier_public_token=bad",
                },
                rawHeaders: [],
            }, socket, new Uint8Array()));

            await flushAsyncWork();
            expect(socket.write).toHaveBeenCalled();
            expect(socket.once).toHaveBeenCalledWith("drain", expect.any(Function));
            expect(socket.destroy).not.toHaveBeenCalled();

            socket.emit(event);
            await expect(pending).resolves.toBeUndefined();
            expect(proxyWebSocket).not.toHaveBeenCalled();
            expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("403 Forbidden");
            expect(socket.destroy).toHaveBeenCalled();
        },
    );

    it("publishes public-scoped WebSocket observability without leaking preview scope", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const emitted: PeerMediationObservabilityEventV1[] = [];
        const app = createUpgradeRouteApp();
        const proxyWebSocket: NonNullable<RegisterLocalServicePublicRoutesOptions["proxyWebSocket"]> = async (input) => {
            input.observability?.emit(createPeerMediationWebSocketEvent({
                kind: "websocket.opened",
                accountId: "account_1",
                machineId: "machine_1",
                previewId: "preview_1",
                tunnelId: "tunnel_1",
                substreamId: "substream_1",
                socketId: "socket_1",
                url: "/@vite/client?publicToken=secret&tab=hmr",
                headers: {
                    cookie: "happier_public_token=secret",
                    "sec-websocket-protocol": "vite-hmr",
                },
                nowMs: 1_000,
            }));
            return { ok: true };
        };
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            openTunnel: vi.fn(),
            proxyWebSocket,
            observability: {
                emit: (event: PeerMediationObservabilityEventV1) => {
                    emitted.push(event);
                },
            },
        } as never);

        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/@vite/client",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
                cookie: "happier_public_token=cookie_token_1",
            },
            rawHeaders: [],
        }, createUpgradeSocket(), new Uint8Array());

        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.scope).toEqual({
            kind: "publicPreview",
            publicExposureId: "public_preview_1",
        });
        expect(emitted[0]?.flow).toMatchObject({
            productRef: {
                kind: "publicExposure",
                id: "public_preview_1",
                redacted: false,
            },
        });
        const serialized = JSON.stringify(emitted[0]);
        expect(serialized).not.toContain("publicToken");
        expect(serialized).not.toContain('"kind":"preview"');
        expect(serialized).not.toContain('"id":"preview_1"');
        expect(serialized).not.toContain("secret");
    });

    // S-1 (lane C1). Fastify's router percent-decodes the proxy wildcard, so a client path of
    // `foo%0d%0a…` reaches the handler as a REAL CRLF inside `params['*']`. Both public-preview
    // sinks are CRLF-terminated: the raw HTTP/1.1 request line written to the upstream tunnel,
    // and the `Location` header of the public-token exchange redirect.
    const ROUTER_DECODED_CRLF_PATH = "foo\r\nX-Injected: yes\r\n\r\nGET /admin HTTP/1.1";
    const CANONICAL_ENCODED_CRLF_PATH = "/foo%0D%0AX-Injected:%20yes%0D%0A%0D%0AGET%20/admin%20HTTP/1.1";

    function upstreamRequestLines(upstream: string): readonly string[] {
        return upstream.split("\r\n").filter((line) => /\sHTTP\/1\.1$/u.test(line));
    }

    function createRecordingTunnelOpener(writes: string[]) {
        return async () => ({
            tunnelId: "public_tunnel_test",
            substreamId: "public_substream_test",
            write: (bytes: Uint8Array) => {
                writes.push(new TextDecoder().decode(bytes));
            },
            endWrite: vi.fn(),
            read: async function* (): AsyncIterableIterator<Uint8Array> {
                yield new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            },
            close: vi.fn(),
            abort: vi.fn(),
        });
    }

    it("never writes a second upstream request line for a router-decoded CRLF proxy path", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const writes: string[] = [];
        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            authorizeSessionAccess: allowSessionAccess(),
            openTunnel: createRecordingTunnelOpener(writes) as never,
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            method: "GET",
            params: { exposureId: "public_preview_1", "*": ROUTER_DECODED_CRLF_PATH },
            query: {},
            headers: { host: "preview.happier.test", cookie: "happier_public_token=token_1" },
        }, reply);

        const upstream = writes.join("");
        expect(upstream.split("\r\n\r\n")).toHaveLength(2);
        expect(upstreamRequestLines(upstream)).toHaveLength(1);
        expect(upstream).not.toMatch(/\r\nX-Injected:/u);
        expect(upstream.split("\r\n")[0]).toBe(`GET ${CANONICAL_ENCODED_CRLF_PATH} HTTP/1.1`);
    });

    it("never emits a CRLF Location header when exchanging a public token on a decoded CRLF path", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess: vi.fn(() => ({ ok: true as const, preview })),
            exchangeAccessToken: vi.fn(() => ({
                ok: true as const,
                exposureId: "public_preview_1",
                rawToken: "rotated_token_1",
                expiresAt: 61_000,
            })),
            authorizeSessionAccess: allowSessionAccess(),
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        const reply = createReplyStub();
        await handler({
            method: "GET",
            params: { exposureId: "public_preview_1", "*": ROUTER_DECODED_CRLF_PATH },
            query: { publicToken: "token_1" },
            headers: { host: "preview.happier.test" },
        }, reply);

        expect(reply.statusCode).toBe(303);
        expect(reply.headers.Location).not.toMatch(/[\r\n]/u);
        expect(reply.headers.Location).toBe(
            `/v1/local-services/public/public_preview_1${CANONICAL_ENCODED_CRLF_PATH}`,
        );
    });

    // S-2: `authenticated` proved only that the caller held SOME account on this server. The
    // route must resolve access to the exposure's bound session and hand that fact to the runtime,
    // on BOTH data planes.
    it("resolves session authorization for the exposure owner on the HTTP data plane", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const validateAccess = vi.fn(() => ({ ok: true as const, preview }));
        const authorizeSessionAccess = vi.fn(() => false);
        const app = createFakeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess,
            readOptionalUserId: async () => "co_tenant_user",
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
        });

        const handler = getRouteHandler(app, "GET", "/v1/local-services/public/:exposureId/*");
        await handler({
            method: "GET",
            ip: "203.0.113.9",
            params: { exposureId: "public_preview_1", "*": "index.html" },
            query: {},
            headers: { host: "preview.happier.test" },
        }, createReplyStub());

        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "co_tenant_user",
            sessionId: "session_1",
            purpose: "public_access",
        });
        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            exposureId: "public_preview_1",
            authenticated: true,
            sessionAuthorized: false,
            clientKey: "203.0.113.9",
        }));
    });

    it("resolves session authorization for the exposure owner on the WebSocket data plane", async () => {
        const mod = await loadPublicRoutesModule();
        expect(mod?.registerLocalServicePublicRoutes).toBeTypeOf("function");
        if (!mod?.registerLocalServicePublicRoutes) return;

        const validateAccess = vi.fn(() => ({ ok: false as const, reasonCode: "session_not_authorized" as const }));
        const authorizeSessionAccess = vi.fn(() => false);
        const app = createUpgradeRouteApp();
        mod.registerLocalServicePublicRoutes(app as never, {
            resolvePreview: vi.fn(() => preview),
            resolveExposure: vi.fn(() => exposure),
            createExposure: vi.fn(() => ({ ok: true as const, exposure })),
            revokeExposure: vi.fn(() => ({ ok: true as const })),
            validateAccess,
            authorizeSessionAccess,
            readOptionalUserId: async () => "co_tenant_user",
            proxyHttp: vi.fn(async () => ({ ok: true as const })),
            proxyWebSocket: vi.fn(async () => ({ ok: true as const })),
        } as never);

        const socket = { ...createUpgradeSocket(), remoteAddress: "203.0.113.9" };
        await app.upgradeHandlers[0]?.({
            url: "/v1/local-services/public/public_preview_1/socket",
            headers: {
                host: "preview.happier.test",
                upgrade: "websocket",
                connection: "Upgrade",
            },
            rawHeaders: [],
        }, socket, new Uint8Array());

        expect(authorizeSessionAccess).toHaveBeenCalledWith({
            userId: "co_tenant_user",
            sessionId: "session_1",
            purpose: "public_access",
        });
        expect(validateAccess).toHaveBeenCalledWith(expect.objectContaining({
            exposureId: "public_preview_1",
            authenticated: true,
            sessionAuthorized: false,
            clientKey: "203.0.113.9",
        }));
        expect(new TextDecoder().decode(socket.write.mock.calls[0]?.[0])).toContain("403 Forbidden");
    });
});
