import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';
import { sealAccountPetPackageV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';
import { buildAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/importActionV1';
import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { encodeBase64 } from '@/encryption/base64';
import type { AccountPetMetadata } from "./accountPetLibraryTypes";
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const resolveRuntimeFeatureDecisionOrThrow = vi.hoisted(() => vi.fn());

vi.mock("@/sync/domains/features/featureDecisionInputs", () => ({
    resolveRuntimeFeatureDecisionOrThrow,
}));

const credentials: AuthCredentials = { token: "token-1" };
const legacySecret = new Uint8Array(32).fill(11);
const legacyCredentials: AuthCredentials = { token: "token-1", secret: encodeBase64(legacySecret, 'base64url') };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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

/** The sealed entry an E2EE Home stores for a package its owner validated and sealed. */
async function sealedEntry(accountPetId: string, secret: Uint8Array) {
    const validated = await validateAccountPetCreateRequestV1(buildAccountPetCreateRequestV1({
        manifest: { id: 'tide', displayName: 'Tide', description: 'A pet.', spritesheetPath: 'spritesheet.png' },
        mediaType: 'image/png', spritesheetBytes: PNG, origin: { kind: 'registry', sourceId: 'petdex', itemId: 'tide' },
    }), { inspectAtlas: async () => ({ width: 1536, height: 1872, hasAlpha: true }) });
    if (!validated.ok) throw new Error(validated.reason);
    const sealed = sealAccountPetPackageV1({ validated, material: { type: 'legacy', secret },
        randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
    if (!sealed.ok) throw new Error(sealed.reason);
    return { accountPetId, packageFormat: 'codex-compatible-atlas-v1', content: sealed.request.content,
        spritesheetAssetRef: { assetId: 'asset-1', digest: sealed.request.spritesheet.digest, sizeBytes: sealed.request.spritesheet.sizeBytes },
        digest: 'sha256:ciphertext', sizeBytes: sealed.request.spritesheet.sizeBytes, createdAt: 1, updatedAt: 2 };
}

/** The Home boundary: Account currentness and the pet list answer by path. */
function home(currentness: unknown, list: unknown, listStatus = 200) {
    return vi.fn(async (path: string) => path === '/v1/account/encryption/currentness'
        ? Response.json(currentness)
        : Response.json(list, { status: listStatus }));
}

describe("fetchAndApplyAccountPets", () => {
    beforeEach(() => {
        resolveRuntimeFeatureDecisionOrThrow.mockReset();
        resolveRuntimeFeatureDecisionOrThrow.mockResolvedValue({ state: "enabled" });
    });

    it("fetches and materializes account pets when pets.sync is enabled", async () => {
        const pets = [metadata("pet-1")];
        const request = home(createPlainAccountEncryptionCurrentnessFixture(), { ok: true, pets });
        const resolvePetsSyncEnabled = vi.fn(async () => true);
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            serverId: "server-1",
            resolvePetsSyncEnabled,
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "applied", count: 1 });
        expect(resolvePetsSyncEnabled).toHaveBeenCalledWith({ serverId: "server-1" });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/account/encryption/currentness', '/v1/account/pets']);
        expect(applyAccountPets).toHaveBeenCalledWith(pets);
    });

    it("opens an E2EE Account's sealed library with its own material", async () => {
        const request = home(createLegacyAccountEncryptionCurrentnessFixture({ secret: legacySecret }),
            { ok: true, pets: [await sealedEntry('pet-sealed', legacySecret)] });
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials: legacyCredentials, request, resolvePetsSyncEnabled: async () => true, applyAccountPets,
        });

        expect(result).toEqual({ status: "applied", count: 1 });
        expect(applyAccountPets).toHaveBeenCalledWith([expect.objectContaining({
            accountPetId: 'pet-sealed', manifest: expect.objectContaining({ displayName: 'Tide' }),
            spritesheetAssetRef: expect.objectContaining({ mediaType: 'image/png', sizeBytes: PNG.byteLength }),
        })]);
    });

    it("omits sealed entries that do not open and plaintext entries on an E2EE Account", async () => {
        const request = home(createLegacyAccountEncryptionCurrentnessFixture({ secret: legacySecret }),
            { ok: true, pets: [await sealedEntry('other-key', new Uint8Array(32).fill(12)), metadata('retained-plain-pet')] });
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials: legacyCredentials, request, resolvePetsSyncEnabled: async () => true, applyAccountPets,
        });

        expect(result).toEqual({ status: "applied", count: 0 });
        expect(applyAccountPets).toHaveBeenCalledWith([]);
    });

    it("does not call account pet routes when pets.sync is disabled", async () => {
        const request = home(createPlainAccountEncryptionCurrentnessFixture(), { ok: true, pets: [metadata("pet-1")] });
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: vi.fn(async () => false),
            applyAccountPets,
            shouldContinue: () => true,
        });

        expect(result).toEqual({ status: "disabled" });
        expect(request).not.toHaveBeenCalled();
        expect(applyAccountPets).toHaveBeenCalledWith([]);
    });

    it("preserves the last-known-good library when the feature decision is temporarily unavailable", async () => {
        const error = Object.assign(new Error("feature probe unavailable"), { retryable: true });
        resolveRuntimeFeatureDecisionOrThrow.mockRejectedValue(error);
        const request = home(createPlainAccountEncryptionCurrentnessFixture(), { ok: true, pets: [] });
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        await expect(fetchAndApplyAccountPets({
            credentials,
            request,
            applyAccountPets,
        })).rejects.toBe(error);
        expect(request).not.toHaveBeenCalled();
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("preserves the last-known-good library and returns typed unavailable", async () => {
        const request = home(createPlainAccountEncryptionCurrentnessFixture(), {
            ok: false, errorCode: "custom_pet_sync_unavailable", error: "custom_pet_sync_unavailable",
        }, 409);
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: async () => true,
            applyAccountPets,
        });

        expect(result).toEqual({
            status: "unavailable",
            reason: "custom_pet_sync_unavailable",
        });
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("does not request pet metadata when E2EE currentness has no matching material", async () => {
        const request = home(createLegacyAccountEncryptionCurrentnessFixture({ secret: legacySecret }), { ok: true, pets: [] });
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials, request, resolvePetsSyncEnabled: async () => true, applyAccountPets,
        });

        expect(result).toEqual({ status: "unavailable", reason: "custom_pet_sync_unavailable" });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/account/encryption/currentness']);
        expect(applyAccountPets).not.toHaveBeenCalled();
    });

    it("does not request pet metadata when strict currentness is unavailable", async () => {
        const request = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
        const applyAccountPets = vi.fn();
        const { fetchAndApplyAccountPets } = await import("./syncAccountPets");

        const result = await fetchAndApplyAccountPets({
            credentials,
            request,
            resolvePetsSyncEnabled: async () => true,
            applyAccountPets,
        });

        expect(result).toEqual({
            status: "unavailable",
            reason: "custom_pet_sync_unavailable",
        });
        expect(request).toHaveBeenCalledOnce();
        expect(applyAccountPets).not.toHaveBeenCalled();
    });
});
