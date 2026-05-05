import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPetSourceMetadata } from "@/sync/domains/pets/localPetSourceTypes";
import type { StoreGet, StoreSet } from "./_shared";

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

    function localMetadata(sourceKey: string): LocalPetSourceMetadata {
        return {
            sourceKey,
            source: {
                kind: "happierManagedLocal",
                packagePath: "/Users/tester/.happy-dev/pets/imports/blink",
                sourceKey,
            },
            displayName: "Blink local",
            manifest: {
                id: "blink-local",
                displayName: "Blink local",
                description: "Imported from Codex.",
                spritesheetPath: "spritesheet.webp",
            },
            mediaType: "image/webp",
            digest: "sha256:local",
            sizeBytes: 256,
            daemonTarget: {
                serverId: "server-pets",
                machineId: "machine-pets",
            },
        };
    }

    async function createState() {
        const { createPetsDomain } = await import("./pets");

        type State = ReturnType<typeof createPetsDomain>;
        let state: State | null = null;
        const get: StoreGet<State> = () => {
            if (!state) throw new Error("pets domain state was read before initialization");
            return state;
        };
        const set: StoreSet<State> = (updater) => {
            const current = get();
            state = typeof updater === "function" ? (updater(current) as State) : { ...current, ...updater };
        };
        const domain = createPetsDomain<State>({ get, set });
        state = domain;
        return {
            domain,
            getState: get,
        };
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

    it("normalizes local pet source metadata by sourceKey without storing preview bytes", async () => {
        const { getState } = await createState();
        type LocalPetsDomainForTest = ReturnType<typeof getState> & Readonly<{
            localPetSourcesBySourceKey?: Record<string, unknown>;
            upsertLocalPetSources?: (sources: readonly LocalPetSourceMetadata[]) => void;
        }>;
        const state = getState() as LocalPetsDomainForTest;

        expect(state.localPetSourcesBySourceKey).toEqual({});
        expect(typeof state.upsertLocalPetSources).toBe("function");

        state.upsertLocalPetSources?.([localMetadata("managed:blink")]);
        const nextState = getState() as LocalPetsDomainForTest;

        expect(Object.keys(nextState.localPetSourcesBySourceKey ?? {})).toEqual(["managed:blink"]);
        expect(nextState.localPetSourcesBySourceKey?.["managed:blink"]).toEqual(expect.objectContaining({
            sourceKey: "managed:blink",
            displayName: "Blink local",
            mediaType: "image/webp",
            digest: "sha256:local",
            sizeBytes: 256,
            daemonTarget: {
                serverId: "server-pets",
                machineId: "machine-pets",
            },
        }));
        expect(nextState.localPetSourcesBySourceKey?.["managed:blink"]).toEqual(expect.not.objectContaining({
            dataBase64: expect.anything(),
            bytes: expect.anything(),
            spritesheetBytes: expect.anything(),
        }));
    });

    it("removes local pet source metadata by source key", async () => {
        const { getState } = await createState();
        type LocalPetsDomainForTest = ReturnType<typeof getState> & Readonly<{
            localPetSourcesBySourceKey?: Record<string, unknown>;
            removeLocalPetSource?: (sourceKey: string) => void;
            upsertLocalPetSources?: (sources: readonly LocalPetSourceMetadata[]) => void;
        }>;
        const state = getState() as LocalPetsDomainForTest;

        state.upsertLocalPetSources?.([
            localMetadata("managed:blink"),
            localMetadata("managed:milo"),
        ]);
        expect(Object.keys((getState() as LocalPetsDomainForTest).localPetSourcesBySourceKey ?? {})).toEqual(["managed:blink", "managed:milo"]);
        expect(typeof state.removeLocalPetSource).toBe("function");

        state.removeLocalPetSource?.("managed:blink");

        expect(Object.keys((getState() as LocalPetsDomainForTest).localPetSourcesBySourceKey ?? {})).toEqual(["managed:milo"]);
    });

    it("hydrates local pet source metadata from device persistence", async () => {
        const { saveLocalPetSourcesBySourceKey } = await import("../../domains/state/persistence");
        saveLocalPetSourcesBySourceKey({
            "managed:blink": localMetadata("managed:blink"),
        });

        const { getState } = await createState();

        expect(getState().localPetSourcesBySourceKey).toEqual({
            "managed:blink": expect.objectContaining({
                sourceKey: "managed:blink",
                displayName: "Blink local",
            }),
        });
    });

    it("persists local pet source metadata updates and removals", async () => {
        const { loadLocalPetSourcesBySourceKey } = await import("../../domains/state/persistence");
        const { getState } = await createState();
        type LocalPetsDomainForTest = ReturnType<typeof getState> & Readonly<{
            removeLocalPetSource?: (sourceKey: string) => void;
            upsertLocalPetSources?: (sources: readonly LocalPetSourceMetadata[]) => void;
        }>;
        const state = getState() as LocalPetsDomainForTest;

        state.upsertLocalPetSources?.([localMetadata("managed:blink")]);
        expect(Object.keys(loadLocalPetSourcesBySourceKey())).toEqual(["managed:blink"]);

        state.removeLocalPetSource?.("managed:blink");
        expect(loadLocalPetSourcesBySourceKey()).toEqual({});
    });
});
