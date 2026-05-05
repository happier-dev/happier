import { describe, expect, it, vi } from "vitest";
import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import type { AccountPetMetadata } from "./accountPetLibraryTypes";

const credentials: AuthCredentials = { token: "token-1", secret: "secret-1" };

function metadata(accountPetId: string): AccountPetMetadata {
    return {
        accountPetId,
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
    };
}

describe("fetchAndApplyAccountPets", () => {
    it("fetches and materializes account pets when pets.sync is enabled", async () => {
        const pets = [metadata("pet-1")];
        const resolvePetsSyncEnabled = vi.fn(async () => true);
        const listPets = vi.fn(async () => pets);
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            serverId: "server-1",
            resolvePetsSyncEnabled,
            listPets,
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "applied", count: 1 });
        expect(resolvePetsSyncEnabled).toHaveBeenCalledWith({ serverId: "server-1" });
        expect(listPets).toHaveBeenCalledWith(credentials);
        expect(applyAccountPets).toHaveBeenCalledWith(pets);
    });

    it("does not call account pet routes when pets.sync is disabled", async () => {
        const resolvePetsSyncEnabled = vi.fn(async () => false);
        const listPets = vi.fn(async () => [metadata("pet-1")]);
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            resolvePetsSyncEnabled,
            listPets,
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "disabled" });
        expect(listPets).not.toHaveBeenCalled();
        expect(applyAccountPets).toHaveBeenCalledWith([]);
    });
});
