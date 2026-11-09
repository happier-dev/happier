import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import type { AccountPetMetadata } from "./accountPetLibraryTypes";
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const resolveRuntimeFeatureDecisionOrThrow = vi.hoisted(() => vi.fn());

vi.mock("@/sync/domains/features/featureDecisionInputs", () => ({
    resolveRuntimeFeatureDecisionOrThrow,
}));

const credentials: AuthCredentials = { token: "token-1" };
const request = vi.fn(async () => Response.json(createPlainAccountEncryptionCurrentnessFixture()));

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
    beforeEach(() => {
        request.mockReset();
        request.mockImplementation(async () => Response.json(createPlainAccountEncryptionCurrentnessFixture()));
        resolveRuntimeFeatureDecisionOrThrow.mockReset();
        resolveRuntimeFeatureDecisionOrThrow.mockResolvedValue({ state: "enabled" });
    });

    it("fetches and materializes account pets when pets.sync is enabled", async () => {
        const pets = [metadata("pet-1")];
        const resolvePetsSyncEnabled = vi.fn(async () => true);
        const listPets = vi.fn(async () => ({ ok: true as const, pets }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            serverId: "server-1",
            resolvePetsSyncEnabled,
            listPets,
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "applied", count: 1 });
        expect(resolvePetsSyncEnabled).toHaveBeenCalledWith({ serverId: "server-1" });
        expect(request.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
            listPets.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
        expect(listPets).toHaveBeenCalledWith(credentials);
        expect(applyAccountPets).toHaveBeenCalledWith(pets);
    });

    it("does not call account pet routes when pets.sync is disabled", async () => {
        const resolvePetsSyncEnabled = vi.fn(async () => false);
        const listPets = vi.fn(async () => ({
            ok: true as const,
            pets: [metadata("pet-1")],
        }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled,
            listPets,
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "disabled" });
        expect(listPets).not.toHaveBeenCalled();
        expect(applyAccountPets).toHaveBeenCalledWith([]);
    });

    it("preserves the last-known-good library when the feature decision is temporarily unavailable", async () => {
        const error = Object.assign(new Error("feature probe unavailable"), { retryable: true });
        resolveRuntimeFeatureDecisionOrThrow.mockRejectedValue(error);
        const listPets = vi.fn();
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        await expect(fetchAndApplyAccountPets({
            credentials,
            request,
            listPets,
            applyAccountPets,
        })).rejects.toBe(error);
        expect(listPets).not.toHaveBeenCalled();
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("preserves the last-known-good library and returns typed unavailable", async () => {
        const listPets = vi.fn(async () => ({
            ok: false as const,
            errorCode: "custom_pet_sync_unavailable" as const,
            error: "custom_pet_sync_unavailable",
        }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: async () => true,
            listPets,
            applyAccountPets,
        });

        expect(result).toEqual({
            status: "unavailable",
            reason: "custom_pet_sync_unavailable",
        });
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("does not request predecessor pet metadata when currentness reports e2ee", async () => {
        request.mockImplementation(async () => Response.json(
            createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(11) }),
        ));
        const listPets = vi.fn(async () => ({
            ok: true as const,
            pets: [metadata("retained-plain-pet")],
        }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: async () => true,
            listPets,
            applyAccountPets,
        });

        expect(result).toEqual({
            status: "unavailable",
            reason: "custom_pet_sync_unavailable",
        });
        expect(request).toHaveBeenCalledOnce();
        expect(listPets).not.toHaveBeenCalled();
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("does not request predecessor pet metadata when strict currentness is unavailable", async () => {
        request.mockImplementation(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
        const listPets = vi.fn(async () => ({
            ok: true as const,
            pets: [metadata("retained-plain-pet")],
        }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: async () => true,
            listPets,
            applyAccountPets,
        });

        expect(result).toEqual({
            status: "unavailable",
            reason: "custom_pet_sync_unavailable",
        });
        expect(listPets).not.toHaveBeenCalled();
        expect(applyAccountPets).not.toHaveBeenCalled();
    });
});
