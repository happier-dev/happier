import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { upsertAndActivateServer } from "@/sync/domains/server/serverRuntime";
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from "@/utils/system/runtimeFetch";
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from "@/dev/testkit/fixtures/accountEncryptionCurrentness";
import { decodeBase64, encodeBase64 } from "@/encryption/base64";
import type { ServerFetch } from "@/sync/http/client";
import { validateAccountPetCreateRequestV1 } from "@happier-dev/protocol/pets/accountPetCreateValidation";
import { sealAccountPetPackageV1 } from "@happier-dev/protocol/pets/accountPetEncryptionV1";
import { buildAccountPetCreateRequestV1 } from "@happier-dev/protocol/pets/importActionV1";

const credentials: AuthCredentials = { token: "token-1" };

describe("apiAccountPets", () => {
    beforeEach(async () => {
        await upsertAndActivateServer({ serverUrl: "https://api.example.test", scope: "tab" });
    });

    afterEach(() => {
        resetRuntimeFetch();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("fetches account pet metadata without requesting spritesheet bytes in the list response", async () => {
        const fetchSpy = vi.fn<RuntimeFetch>(async (input) => String(input).endsWith('/v1/account/encryption/currentness')
            ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : (
            new Response(JSON.stringify({
                ok: true,
                pets: [
                    {
                        accountPetId: "pet-1",
                        packageFormat: "codex-compatible-atlas-v1",
                        manifest: {
                            id: "blink",
                            displayName: "Blink",
                            description: "Built-in compatible pet",
                            spritesheetPath: "spritesheet.webp",
                        },
                        spritesheetAssetRef: {
                            assetId: "asset-1",
                            mediaType: "image/webp",
                            digest: "sha256:abc",
                            sizeBytes: 3,
                        },
                        digest: "sha256:pkg",
                        sizeBytes: 128,
                        createdAt: 1,
                        updatedAt: 2,
                        origin: { kind: "manualImport" },
                    },
                ],
            }), { status: 200 })
        ));
        setRuntimeFetch(fetchSpy);

        const { listAccountPets } = await import("./apiAccountPets");
        const result = await listAccountPets(credentials);

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error("expected account pet list success");
        expect(result.pets).toHaveLength(1);
        expect(result.pets[0]).toEqual(expect.not.objectContaining({
            spritesheetBytes: expect.anything(),
        }));
        const [input, init] = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/account/pets')) ?? [];
        expect(String(input)).toContain("/v1/account/pets");
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    });

    it("returns the typed unavailable result from a conflict response", async () => {
        setRuntimeFetch(vi.fn<RuntimeFetch>(async (input) => String(input).endsWith('/v1/account/encryption/currentness')
            ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : (
            new Response(JSON.stringify({
                ok: false,
                errorCode: "custom_pet_sync_unavailable",
                error: "custom_pet_sync_unavailable",
            }), { status: 409 })
        )));

        const { listAccountPets } = await import("./apiAccountPets");

        await expect(listAccountPets(credentials)).resolves.toEqual({
            ok: false,
            errorCode: "custom_pet_sync_unavailable",
            error: "custom_pet_sync_unavailable",
        });
    });

    it("draws an E2EE pet's decrypted spritesheet bound to its opened entry, and fails closed otherwise", async () => {
        const secret = new Uint8Array(32).fill(31);
        const e2eeCredentials: AuthCredentials = { token: "token-1", secret: encodeBase64(secret, "base64url") };
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
        const validated = await validateAccountPetCreateRequestV1(buildAccountPetCreateRequestV1({
            manifest: { id: "tide", displayName: "Tide", description: "A pet.", spritesheetPath: "spritesheet.png" },
            mediaType: "image/png", spritesheetBytes: png, origin: { kind: "manualImport" },
        }), { inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }) });
        if (!validated.ok) throw new Error(validated.reason);
        const sealed = sealAccountPetPackageV1({ validated, material: { type: "legacy", secret },
            randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
        if (!sealed.ok) throw new Error(sealed.reason);
        const ciphertext = decodeBase64(sealed.request.spritesheet.data, "base64");
        const request = vi.fn<ServerFetch>(async (path) => path === "/v1/account/encryption/currentness"
            ? Response.json(createLegacyAccountEncryptionCurrentnessFixture({ secret }))
            : new Response(new Uint8Array(ciphertext).buffer, { status: 200, headers: { "Content-Type": "application/octet-stream" } }));
        const { readAccountPetSpritesheet } = await import("./apiAccountPets");
        const expected = { mediaType: "image/png" as const, digest: validated.request.spritesheet.digest };

        const opened = await readAccountPetSpritesheet(e2eeCredentials, "pet-1", { request, expected });
        expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(png));
        await expect(readAccountPetSpritesheet(e2eeCredentials, "pet-1", { request,
            expected: { ...expected, digest: "sha256:other" } })).resolves.toMatchObject({ ok: false, errorCode: "custom_pet_sync_unavailable" });
        // Without the opened entry there is nothing to bind the bytes to.
        await expect(readAccountPetSpritesheet(e2eeCredentials, "pet-1", { request }))
            .resolves.toMatchObject({ ok: false, errorCode: "custom_pet_sync_unavailable" });
    });
});
