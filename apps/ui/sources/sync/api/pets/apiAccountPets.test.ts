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
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
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
            }),
        }));
        vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

        const { listAccountPets } = await import("./apiAccountPets");
        const result = await listAccountPets(credentials);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(expect.not.objectContaining({
            spritesheetBytes: expect.anything(),
        }));
        const [input, init] = fetchSpy.mock.calls[0] ?? [];
        expect(String(input)).toContain("/v1/account/pets");
        expect(init?.method).toBeUndefined();
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    });
});
