import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createAuthenticatedTestApp } from "../../testkit/sqliteFastify";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accountRoutes pets.sync routes", () => {
    const tempDirs: string[] = [];
    let harness: LightSqliteHarness;

    type OptionalAccountPetDb = Readonly<{
        accountPetAsset?: { deleteMany: () => Promise<unknown> };
        accountPetPackage?: { deleteMany: () => Promise<unknown> };
    }>;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-pets-routes-db-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: undefined,
            HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(harness.baseDir, "private-files"),
        });
    });

    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
        harness.resetEnv();
        const petDb = db as unknown as OptionalAccountPetDb;
        await harness.resetDbTables([
            () => petDb.accountPetAsset?.deleteMany() ?? Promise.resolve(),
            () => petDb.accountPetPackage?.deleteMany() ?? Promise.resolve(),
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createSpritesheetPng(): Promise<Buffer> {
        const raw = Buffer.alloc(PET_ATLAS_V1.width * PET_ATLAS_V1.height * 4);
        for (const row of PET_ANIMATION_ROWS_V1) {
            for (let frame = 0; frame < row.frames; frame += 1) {
                const x = frame * PET_ATLAS_V1.cellWidth + Math.floor(PET_ATLAS_V1.cellWidth / 2);
                const y = row.row * PET_ATLAS_V1.cellHeight + Math.floor(PET_ATLAS_V1.cellHeight / 2);
                const offset = (y * PET_ATLAS_V1.width + x) * 4;
                raw[offset] = 30;
                raw[offset + 1] = 30;
                raw[offset + 2] = 30;
                raw[offset + 3] = 255;
            }
        }

        return await sharp(raw, {
            raw: {
                width: PET_ATLAS_V1.width,
                height: PET_ATLAS_V1.height,
                channels: 4,
            },
        }).png().toBuffer();
    }

    function digest(bytes: Uint8Array): string {
        return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    }

    async function createAccount(
        accountId: string,
        options: Readonly<{ publicKey?: string | null; encryptionMode?: "plain" | "e2ee" }> = {},
    ): Promise<void> {
        const publicKey = options.publicKey === undefined ? `${accountId}-public-key` : options.publicKey;
        const encryptionMode = options.encryptionMode ?? "plain";
        await db.account.upsert({
            where: { id: accountId },
            update: {
                publicKey,
                encryptionMode,
            },
            create: {
                id: accountId,
                publicKey,
                encryptionMode,
            },
        });
    }

    it("registers account pet library routes under /v1/account/pets", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
        });
        const { accountRoutes } = await import("./accountRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets",
            registerRoutes(app) {
                accountRoutes(app as any);
            },
        });

        expect(route.routeExists).toBe(true);
    });

    it("returns the canonical disabled-route shape when pets.sync is denied", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "0",
        });
        const { accountRoutes } = await import("./accountRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v1/account/pets",
            registerRoutes(app) {
                accountRoutes(app as any);
            },
        });

        expect(route.routeExists).toBe(true);
        const { reply, response } = await route.invoke({ userId: "u1" });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(response).toBeUndefined();
    });

    it("creates and lists account pet metadata through the real route stack", async () => {
        const privateFilesDir = await mkdtemp(join(tmpdir(), "happier-account-pets-routes-"));
        tempDirs.push(privateFilesDir);
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: privateFilesDir,
        });
        await createAccount("account-1");
        const { accountRoutes } = await import("./accountRoutes");
        const app = createAuthenticatedTestApp();
        accountRoutes(app);
        await app.ready();
        try {
            const spritesheet = await createSpritesheetPng();
            const createResponse = await app.inject({
                method: "POST",
                url: "/v1/account/pets",
                headers: {
                    "x-test-user-id": "account-1",
                    "content-type": "application/json",
                },
                payload: {
                    manifest: {
                        id: "blink",
                        displayName: "Blink",
                        description: "Happier companion pet",
                        spritesheetPath: "spritesheet.png",
                    },
                    spritesheet: {
                        mediaType: "image/png",
                        encoding: "base64",
                        data: spritesheet.toString("base64"),
                        sizeBytes: spritesheet.byteLength,
                        digest: digest(spritesheet),
                    },
                    origin: { kind: "manualImport" },
                },
            });
            expect(createResponse.statusCode).toBe(201);
            const created = createResponse.json();
            expect(created.ok).toBe(true);
            expect(JSON.stringify(created)).not.toContain("spritesheetBytes");
            expect(typeof created.pet?.accountPetId).toBe("string");

            const listResponse = await app.inject({
                method: "GET",
                url: "/v1/account/pets",
                headers: { "x-test-user-id": "account-1" },
            });
            expect(listResponse.statusCode).toBe(200);
            expect(listResponse.json()).toEqual({
                ok: true,
                pets: [created.pet],
            });
            expect(JSON.stringify(listResponse.json())).not.toContain("spritesheetBytes");
        } finally {
            await app.close();
        }
    });

    it("denies account pet uploads for e2ee accounts before storing bytes", async () => {
        const privateFilesDir = await mkdtemp(join(tmpdir(), "happier-account-pets-routes-"));
        tempDirs.push(privateFilesDir);
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: privateFilesDir,
        });
        await createAccount("account-1", { publicKey: "account-1-public-key", encryptionMode: "e2ee" });
        const { accountRoutes } = await import("./accountRoutes");
        const app = createAuthenticatedTestApp();
        accountRoutes(app);
        await app.ready();
        try {
            const spritesheet = await createSpritesheetPng();
            const createResponse = await app.inject({
                method: "POST",
                url: "/v1/account/pets",
                headers: {
                    "x-test-user-id": "account-1",
                    "content-type": "application/json",
                },
                payload: {
                    manifest: {
                        id: "blink",
                        displayName: "Blink",
                        description: "Happier companion pet",
                        spritesheetPath: "spritesheet.png",
                    },
                    spritesheet: {
                        mediaType: "image/png",
                        encoding: "base64",
                        data: spritesheet.toString("base64"),
                        sizeBytes: spritesheet.byteLength,
                        digest: digest(spritesheet),
                    },
                    origin: { kind: "manualImport" },
                },
            });

            expect(createResponse.statusCode).toBe(400);
            expect(createResponse.json()).toEqual({
                ok: false,
                errorCode: "custom_pet_sync_requires_plaintext",
                error: "custom_pet_sync_requires_plaintext",
            });
            await expect(db.accountPetPackage.count()).resolves.toBe(0);
            await expect(readdir(privateFilesDir)).resolves.toEqual([]);
        } finally {
            await app.close();
        }
    });

    it("keeps account pet metadata durable across route runtime recreation", async () => {
        const privateFilesDir = await mkdtemp(join(tmpdir(), "happier-account-pets-routes-"));
        tempDirs.push(privateFilesDir);
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: privateFilesDir,
        });
        await createAccount("account-1");
        const spritesheet = await createSpritesheetPng();

        const firstModule = await import("./accountRoutes");
        const firstApp = createAuthenticatedTestApp();
        firstModule.accountRoutes(firstApp);
        await firstApp.ready();
        const createResponse = await firstApp.inject({
            method: "POST",
            url: "/v1/account/pets",
            headers: {
                "x-test-user-id": "account-1",
                "content-type": "application/json",
            },
            payload: {
                manifest: {
                    id: "blink",
                    displayName: "Blink",
                    description: "Happier companion pet",
                    spritesheetPath: "spritesheet.png",
                },
                spritesheet: {
                    mediaType: "image/png",
                    encoding: "base64",
                    data: spritesheet.toString("base64"),
                    sizeBytes: spritesheet.byteLength,
                    digest: digest(spritesheet),
                },
                origin: { kind: "manualImport" },
            },
        });
        await firstApp.close();
        expect(createResponse.statusCode).toBe(201);
        const created = createResponse.json();
        expect(created.ok).toBe(true);

        const secondModule = await import("./accountRoutes");
        const secondApp = createAuthenticatedTestApp();
        secondModule.accountRoutes(secondApp);
        await secondApp.ready();
        try {
            const listResponse = await secondApp.inject({
                method: "GET",
                url: "/v1/account/pets",
                headers: { "x-test-user-id": "account-1" },
            });

            expect(listResponse.statusCode).toBe(200);
            expect(listResponse.json()).toEqual({ ok: true, pets: [created.pet] });
        } finally {
            await secondApp.close();
        }
    });

    it("rejects the older e2e draft create shape as a client contract mismatch instead of a server error", async () => {
        const privateFilesDir = await mkdtemp(join(tmpdir(), "happier-account-pets-routes-"));
        tempDirs.push(privateFilesDir);
        harness.resetEnv({
            HAPPIER_FEATURE_PETS_SYNC__ENABLED: "1",
            HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: privateFilesDir,
        });
        await createAccount("account-1");
        const { accountRoutes } = await import("./accountRoutes");
        const app = createAuthenticatedTestApp();
        accountRoutes(app);
        await app.ready();
        try {
            const spritesheet = await createSpritesheetPng();
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/pets",
                headers: {
                    "x-test-user-id": "account-1",
                    "content-type": "application/json",
                },
                payload: {
                    packageFormat: "codex-pet-package-v1",
                    manifest: {
                        id: "blink",
                        displayName: "Blink",
                        description: "Happier companion pet",
                        spritesheetPath: "spritesheet.png",
                    },
                    spritesheetBase64: spritesheet.toString("base64"),
                },
            });

            expect(response.statusCode).toBe(400);
        } finally {
            await app.close();
        }
    });
});
