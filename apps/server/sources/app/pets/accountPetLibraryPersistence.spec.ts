import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, isPrismaErrorCode } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("accountPetLibraryPersistence", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-pets-persistence-db-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountPetAsset.deleteMany(),
            () => db.accountPetPackage.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("rejects an asset whose account does not match the owning package account", async () => {
        await db.account.createMany({
            data: [
                {
                    id: "account-1",
                    publicKey: "account-1-public-key",
                    encryptionMode: "plain",
                },
                {
                    id: "account-2",
                    publicKey: "account-2-public-key",
                    encryptionMode: "plain",
                },
            ],
        });
        await db.accountPetPackage.create({
            data: {
                id: "pet-1",
                accountId: "account-1",
                packageFormat: "codexAtlasV1",
                contentMode: "plain",
                manifest: { id: "blink" },
                digest: "sha256:pet",
                sizeBytes: 123,
                origin: { kind: "manualImport" },
            },
        });

        let error: unknown = null;
        try {
            await db.accountPetAsset.create({
                data: {
                    id: "asset-1",
                    accountId: "account-2",
                    petPackageId: "pet-1",
                    contentMode: "plain",
                    storageKind: "privateFile",
                    objectKey: "objects/pets/asset-1",
                    byteLength: 123,
                    mediaType: "image/webp",
                    digest: "sha256:asset",
                },
            });
        } catch (nextError) {
            error = nextError;
        }

        expect(isPrismaErrorCode(error, "P2003")).toBe(true);
    });
});
