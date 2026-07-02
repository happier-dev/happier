import type { LocalServicePreviewResourceV1, LocalServicePublicExposureV1 } from "@happier-dev/protocol";
import { auth } from "@/app/auth/auth";
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { describe, expect, it, vi } from "vitest";
import type { RegisterLocalServicePublicRoutesOptions } from "./registerRoutes";

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

async function decodeBody(body: AsyncIterable<Uint8Array> | undefined): Promise<string> {
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of body ?? []) {
        out += decoder.decode(chunk);
    }
    return out;
}

describe("local service public exposure routes", () => {
    function allowSessionAccess() {
        return vi.fn(() => true);
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
        expect(getRouteEntry(app, "DELETE", "/v1/local-services/public/:exposureId").opts.preHandler).toBe(app.authenticate);
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
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
                rateLimitProfileId: "default",
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
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
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
                previewId: "preview_1",
                mode: "secret_link",
                ttlMs: 120_000,
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
        }, reply);

        expect(revokeExposure).not.toHaveBeenCalled();
        expect(reply.statusCode).toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: "session_not_authorized",
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
            query: { publicToken: "token_1", v: "1" },
            headers: { host: "preview.happier.test" },
            method: "GET",
        }, reply);

        expect(validateAccess).toHaveBeenCalledWith({
            exposureId: "public_preview_1",
            rawToken: "token_1",
            authenticated: false,
        });
        expect(proxyInputs[0]).toEqual(expect.objectContaining({
            preview,
            request: expect.objectContaining({
                path: "/assets/app.js",
                search: "?v=1",
            }),
        }));
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
            query: { publicToken: "token_1" },
            headers: { "content-type": "application/json" },
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
            query: { publicToken: "token_1" },
            headers: {
                origin: "https://consumer.example",
                "access-control-request-method": "PUT",
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
});
