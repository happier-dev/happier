import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAccountScope } from "@/sync/domains/scope/serverAccountScope";

const persistedStore = vi.hoisted(() => new Map<string, string>());

vi.mock("react-native-mmkv", () => {
    class MMKV {
        getString(key: string) {
            return persistedStore.get(key);
        }

        set(key: string, value: string) {
            persistedStore.set(key, value);
        }

        delete(key: string) {
            persistedStore.delete(key);
        }

        clearAll() {
            persistedStore.clear();
        }
    }

    return { MMKV };
});

type LocalPetSourceMetadata = Readonly<{
    kind: "detectedCodexHome" | "happierManagedLocal";
    sourceKey: string;
    petId: string;
    displayName: string;
    mediaType?: "image/png" | "image/webp";
    digest?: string;
    sizeBytes?: number;
    daemonTarget: Readonly<{
        machineId: string;
        serverId: string;
    }>;
}>;

describe("createPetsDomain", () => {
    beforeEach(() => {
        persistedStore.clear();
    });

    function metadata(accountPetId: string) {
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
        } as const;
    }

    async function createState() {
        const { createPetsDomain } = await import("./pets");

        type State = ReturnType<typeof createPetsDomain>;
        let state = {} as State;
        const get = () => state;
        const set = (updater: (draft: State) => State) => {
            state = updater(state);
        };
        const domain = createPetsDomain({ get, set } as any);
        state = domain;
        return {
            domain,
            getState: () => state,
        };
    }

    function localSourceMetadata(sourceKey: string): LocalPetSourceMetadata {
        return {
            kind: "happierManagedLocal",
            sourceKey,
            petId: "blink",
            displayName: "Blink",
            mediaType: "image/webp",
            digest: "sha256:managed",
            sizeBytes: 128,
            daemonTarget: {
                machineId: "machine-pets",
                serverId: "server-pets",
            },
        };
    }

    function requireScopedMethods(
        state: ReturnType<Awaited<ReturnType<typeof createState>>["getState"]> & {
            activatePetsScope?: (scope: ServerAccountScope) => void;
            clearPetsScope?: () => void;
            applyAccountPetsForScope?: (scope: ServerAccountScope, pets: readonly ReturnType<typeof metadata>[]) => void;
        },
    ): asserts state is ReturnType<Awaited<ReturnType<typeof createState>>["getState"]> & Required<{
        activatePetsScope: (scope: ServerAccountScope) => void;
        clearPetsScope: () => void;
        applyAccountPetsForScope: (scope: ServerAccountScope, pets: readonly ReturnType<typeof metadata>[]) => void;
    }> {
        expect(state.activatePetsScope, "pets domain should expose activatePetsScope").toBeTypeOf("function");
        expect(state.clearPetsScope, "pets domain should expose clearPetsScope").toBeTypeOf("function");
        expect(state.applyAccountPetsForScope, "pets domain should expose applyAccountPetsForScope").toBeTypeOf("function");
    }

    it("normalizes account pet metadata by id without storing spritesheet bytes", async () => {
        const { domain, getState } = await createState();

        domain.applyAccountPets([metadata("pet-1")]);

        expect(Object.keys(getState().accountPetsById)).toEqual(["pet-1"]);
        expect(getState().accountPetsById["pet-1"]).toEqual(expect.not.objectContaining({
            spritesheetBytes: expect.anything(),
        }));
    });

    it("upserts account pet metadata by accountPetId", async () => {
        const { domain, getState } = await createState();

        domain.upsertAccountPet(metadata("pet-1"));

        expect(Object.keys(getState().accountPetsById)).toEqual(["pet-1"]);
    });

    it("hydrates only the active account pet projection for the selected server/account scope", async () => {
        const scopeA: ServerAccountScope = { serverId: "server-a", accountId: "account-a" };
        const scopeB: ServerAccountScope = { serverId: "server-a", accountId: "account-b" };
        const { domain, getState } = await createState();
        const scopedState = getState() as ReturnType<typeof getState> & {
            activatePetsScope?: (scope: ServerAccountScope) => void;
            clearPetsScope?: () => void;
            applyAccountPetsForScope?: (scope: ServerAccountScope, pets: readonly ReturnType<typeof metadata>[]) => void;
        };

        requireScopedMethods(scopedState);

        scopedState.activatePetsScope(scopeA);
        scopedState.applyAccountPetsForScope(scopeA, [metadata("pet-a")]);
        expect(Object.keys(getState().accountPetsById)).toEqual(["pet-a"]);

        scopedState.activatePetsScope(scopeB);
        expect(getState().accountPetsById).toEqual({});

        scopedState.applyAccountPetsForScope(scopeB, [metadata("pet-b")]);
        expect(Object.keys(getState().accountPetsById)).toEqual(["pet-b"]);

        scopedState.activatePetsScope(scopeA);
        expect(Object.keys(getState().accountPetsById)).toEqual(["pet-a"]);

        scopedState.clearPetsScope();
        expect(getState().accountPetsById).toEqual({});
    });

    it("does not let stale different-scope account pet updates mutate the active projection", async () => {
        const scopeA: ServerAccountScope = { serverId: "server-a", accountId: "account-a" };
        const scopeB: ServerAccountScope = { serverId: "server-a", accountId: "account-b" };
        const { getState } = await createState();
        const scopedState = getState() as ReturnType<typeof getState> & {
            activatePetsScope?: (scope: ServerAccountScope) => void;
            clearPetsScope?: () => void;
            applyAccountPetsForScope?: (scope: ServerAccountScope, pets: readonly ReturnType<typeof metadata>[]) => void;
        };

        requireScopedMethods(scopedState);

        scopedState.activatePetsScope(scopeA);
        scopedState.applyAccountPetsForScope(scopeB, [metadata("pet-b")]);

        expect(getState().accountPetsById).toEqual({});
    });

    it("upserts local pet source metadata by source key without storing package paths or bytes", async () => {
        const { domain, getState } = await createState();
        const petsDomain = domain as typeof domain & {
            upsertLocalPetSource?: (source: LocalPetSourceMetadata) => void;
        };

        expect(typeof petsDomain.upsertLocalPetSource).toBe("function");

        petsDomain.upsertLocalPetSource?.(localSourceMetadata("managed:blink"));

        const state = getState() as ReturnType<typeof getState> & {
            localPetSourcesBySourceKey: Record<string, LocalPetSourceMetadata>;
        };
        expect(Object.keys(state.localPetSourcesBySourceKey)).toEqual(["managed:blink"]);
        expect(state.localPetSourcesBySourceKey["managed:blink"]).toEqual(
            expect.objectContaining({
                sourceKey: "managed:blink",
                daemonTarget: {
                    machineId: "machine-pets",
                    serverId: "server-pets",
                },
            }),
        );
        expect(JSON.stringify(state.localPetSourcesBySourceKey)).not.toContain("/Users/");
        expect(JSON.stringify(state.localPetSourcesBySourceKey)).not.toContain("dataBase64");
    });

    it("hydrates local pet source metadata from device persistence", async () => {
        const { saveLocalPetSourcesBySourceKey } = await import("../../domains/state/persistence");
        saveLocalPetSourcesBySourceKey({
            "managed:blink": localSourceMetadata("managed:blink"),
        });

        const { getState } = await createState();

        expect(getState().localPetSourcesBySourceKey).toEqual({
            "managed:blink": expect.objectContaining({
                sourceKey: "managed:blink",
                displayName: "Blink",
            }),
        });
    });

    it("persists local pet source metadata updates and removals", async () => {
        const { loadLocalPetSourcesBySourceKey } = await import("../../domains/state/persistence");
        const { domain } = await createState();
        const petsDomain = domain as typeof domain & {
            upsertLocalPetSource?: (source: LocalPetSourceMetadata) => void;
            removeLocalPetSource?: (sourceKey: string) => void;
        };

        petsDomain.upsertLocalPetSource?.(localSourceMetadata("managed:blink"));
        expect(Object.keys(loadLocalPetSourcesBySourceKey())).toEqual(["managed:blink"]);

        petsDomain.removeLocalPetSource?.("managed:blink");
        expect(loadLocalPetSourcesBySourceKey()).toEqual({});
    });
});
