import { beforeEach, describe, expect, it, vi } from "vitest";

import { PET_PACKAGE_LIMITS_V1 } from "@happier-dev/protocol";

import { createRouteTestBuilder } from "@/app/api/testkit/routeTestBuilder";
import type { FakeRouteApp } from "@/app/api/testkit/routeHarness";
import type { Fastify } from "@/app/api/types";

const listAccountPetsForAccount = vi.fn();
const createAccountPetForAccount = vi.fn();
const readAccountPetAssetForAccount = vi.fn();
const deleteAccountPetForAccount = vi.fn();

vi.mock("./accountPetLibraryReadService", () => ({
    listAccountPetsForAccount,
    readAccountPetAssetForAccount,
}));

vi.mock("./accountPetLibraryWriteService", () => ({
    createAccountPetForAccount,
    deleteAccountPetForAccount,
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

function registerWithRouteHarness(app: FakeRouteApp, registerRoutes: (app: Fastify) => void): void {
    registerRoutes(app as unknown as Fastify);
}

function petMetadata() {
    return {
        accountPetId: "pet-1",
        packageFormat: "codex-compatible-atlas-v1",
        manifest: {
            id: "blink",
            displayName: "Blink",
            description: "Happier companion pet",
            spritesheetPath: "spritesheet.webp",
        },
        spritesheetAssetRef: {
            assetId: "asset-1",
            mediaType: "image/webp",
            digest: "sha256:asset",
            sizeBytes: 3,
        },
        digest: "sha256:package",
        sizeBytes: 128,
        createdAt: 1,
        updatedAt: 2,
        origin: { kind: "manualImport" },
    };
}

describe("accountPetLibraryRoutes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("registers a delete route for account-owned pet cleanup", async () => {
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v1/account/pets/:petId",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        expect(route.routeExists).toBe(true);
    });

    it("lists account pet metadata without spritesheet bytes", async () => {
        listAccountPetsForAccount.mockResolvedValue({ ok: true, pets: [petMetadata()] });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { response } = await route.invoke({ userId: "account-1" });

        expect(listAccountPetsForAccount).toHaveBeenCalledWith({ accountId: "account-1" });
        expect(response).toEqual({ ok: true, pets: [petMetadata()] });
        expect(JSON.stringify(response)).not.toContain("spritesheetBytes");
    });

    it("returns a typed unavailable result instead of omitting pets for an incompatible account or row mode", async () => {
        listAccountPetsForAccount.mockResolvedValue({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({ userId: "account-1" });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(response).toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
    });

    it("reads spritesheet bytes only through account-owned asset lookup", async () => {
        readAccountPetAssetForAccount.mockResolvedValue({
            ok: true,
            mediaType: "image/webp",
            bytes: Uint8Array.from([1, 2, 3]),
            digest: "sha256:asset",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets/:petId/assets/:assetId",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const request = route.createRequest({
            userId: "account-1",
            params: { petId: "pet-1", assetId: "asset-1" },
        });
        const reply = route.createReply();
        const response = await route.handler(request, reply);

        expect(readAccountPetAssetForAccount).toHaveBeenCalledWith({
            accountId: "account-1",
            petId: "pet-1",
            assetId: "asset-1",
        });
        expect(reply.header).toHaveBeenCalledWith("Content-Type", "image/webp");
        expect(reply.header).toHaveBeenCalledWith("ETag", "\"sha256:asset\"");
        expect(reply.header).toHaveBeenCalledWith("Cache-Control", "private");
        expect(response).toEqual(Uint8Array.from([1, 2, 3]));
    });

    it("does not read asset bytes when ownership lookup fails", async () => {
        readAccountPetAssetForAccount.mockResolvedValue(null);
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets/:petId/spritesheet",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({
            userId: "account-1",
            params: { petId: "pet-1" },
        });

        expect(readAccountPetAssetForAccount).toHaveBeenCalledWith({
            accountId: "account-1",
            petId: "pet-1",
            assetId: null,
        });
        expect(reply.code).toHaveBeenCalledWith(404);
        expect(response).toEqual({ error: "not_found" });
    });

    it("returns a typed unavailable result without asset headers or bytes for an incompatible account or row mode", async () => {
        readAccountPetAssetForAccount.mockResolvedValue({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets/:petId/assets/:assetId",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const request = route.createRequest({
            userId: "account-1",
            params: { petId: "pet-1", assetId: "asset-1" },
        });
        const reply = route.createReply();
        const response = await route.handler(request, reply);

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.header).not.toHaveBeenCalledWith("Content-Type", expect.anything());
        expect(response).toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
    });

    it("rejects invalid package uploads before creating account pet storage", async () => {
        createAccountPetForAccount.mockResolvedValue({
            ok: false,
            errorCode: "invalid_request",
            error: "invalid_request",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({
            userId: "account-1",
            body: {
                manifest: {
                    id: "bad",
                    displayName: "Bad",
                    description: "Bad payload",
                    spritesheetPath: "spritesheet.webp",
                },
                spritesheet: {
                    mediaType: "image/webp",
                    encoding: "base64",
                    data: Buffer.from("hello").toString("base64"),
                    sizeBytes: 5,
                    digest: "sha256:not-real",
                },
                origin: { kind: "manualImport" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "invalid_request",
        }));
    });

    it("registers a pet-specific create body limit below the global API body limit", async () => {
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const entry = route.app.routes.get("POST /v1/account/pets");

        expect(entry?.opts.bodyLimit).toEqual(expect.any(Number));
        expect(entry?.opts.bodyLimit).toBeGreaterThan(PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes);
        expect(entry?.opts.bodyLimit).toBeLessThan(100 * 1024 * 1024);
    });

    it("creates account pets with the route create status expected by e2e", async () => {
        createAccountPetForAccount.mockResolvedValue({
            ok: true,
            pet: petMetadata(),
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({
            userId: "account-1",
            body: {
                manifest: {
                    id: "blink",
                    displayName: "Blink",
                    description: "Happier companion pet",
                    spritesheetPath: "spritesheet.webp",
                },
                spritesheet: {
                    mediaType: "image/webp",
                    encoding: "base64",
                    data: Buffer.from("hello").toString("base64"),
                    sizeBytes: 5,
                    digest: "sha256:not-real",
                },
                origin: { kind: "manualImport" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(201);
        expect(response).toEqual({ ok: true, pet: petMetadata() });
    });

    it("returns a client error when account pet quota is exceeded", async () => {
        createAccountPetForAccount.mockResolvedValue({
            ok: false,
            errorCode: "quota_exceeded",
            error: "quota_exceeded",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({
            userId: "account-1",
            body: {
                manifest: {
                    id: "blink",
                    displayName: "Blink",
                    description: "Happier companion pet",
                    spritesheetPath: "spritesheet.webp",
                },
                spritesheet: {
                    mediaType: "image/webp",
                    encoding: "base64",
                    data: Buffer.from("hello").toString("base64"),
                    sizeBytes: 5,
                    digest: "sha256:not-real",
                },
                origin: { kind: "manualImport" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "quota_exceeded",
        }));
    });

    it("returns a client error when custom pet sync requires plaintext storage", async () => {
        createAccountPetForAccount.mockResolvedValue({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
            error: "custom_pet_sync_requires_plaintext",
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v1/account/pets",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { reply, response } = await route.invoke({
            userId: "account-1",
            body: {
                manifest: {
                    id: "blink",
                    displayName: "Blink",
                    description: "Happier companion pet",
                    spritesheetPath: "spritesheet.webp",
                },
                spritesheet: {
                    mediaType: "image/webp",
                    encoding: "base64",
                    data: Buffer.from("hello").toString("base64"),
                    sizeBytes: 5,
                    digest: "sha256:not-real",
                },
                origin: { kind: "manualImport" },
            },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(response).toEqual(expect.objectContaining({
            ok: false,
            errorCode: "custom_pet_sync_requires_plaintext",
        }));
    });

    it("deletes an account pet through the account-owned write service", async () => {
        deleteAccountPetForAccount.mockResolvedValue({
            ok: true,
            accountPetId: "pet-1",
            deletedAt: 123,
        });
        const { registerAccountPetLibraryRoutes } = await import("./accountPetLibraryRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v1/account/pets/:petId",
            registerRoutes(app) {
                registerWithRouteHarness(app, registerAccountPetLibraryRoutes);
            },
        });

        const { response } = await route.invoke({
            userId: "account-1",
            params: { petId: "pet-1" },
        });

        expect(deleteAccountPetForAccount).toHaveBeenCalledWith({
            accountId: "account-1",
            petId: "pet-1",
        });
        expect(response).toEqual({
            ok: true,
            accountPetId: "pet-1",
            deletedAt: 123,
        });
    });
});
