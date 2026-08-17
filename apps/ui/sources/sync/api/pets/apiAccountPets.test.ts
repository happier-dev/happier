import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthCredentials } from "@/auth/storage/tokenStorage";

vi.mock("@/sync/domains/server/serverRuntime", () => ({
    getActiveServerSnapshot: () => ({
        serverId: "test",
        serverUrl: "https://api.example.test",
        kind: "custom",
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: "token-1", secret: "secret-1" };

describe("apiAccountPets", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("fetches account pet metadata without requesting spritesheet bytes in the list response", async () => {
        const fetchSpy = vi.fn<typeof fetch>(async () => (
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
        vi.stubGlobal("fetch", fetchSpy);

        const { listAccountPets } = await import("./apiAccountPets");
        const result = await listAccountPets(credentials);

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error("expected account pet list success");
        expect(result.pets).toHaveLength(1);
        expect(result.pets[0]).toEqual(expect.not.objectContaining({
            spritesheetBytes: expect.anything(),
        }));
        const [input, init] = fetchSpy.mock.calls[0] ?? [];
        expect(String(input)).toContain("/v1/account/pets");
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    });

    it("returns the typed unavailable result from a conflict response", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => (
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
});
