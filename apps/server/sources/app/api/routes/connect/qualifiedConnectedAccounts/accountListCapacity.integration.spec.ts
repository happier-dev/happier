import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { buildAccountConnectedServicesProjection } from "../../account/connectedServicesProjection";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    listQualifiedConnectedAccounts,
    mutateQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    deleteQualifiedConnectedAccountGroup,
    listQualifiedConnectedAccountGroups,
} from "./groupRepository";
import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountServiceDigest,
    createServiceAccountTokenIdentityFields,
} from "./identity";
import {
    deleteQualifiedProviderAccountUsageRecord,
    readQualifiedProviderAccountUsageRecord,
    writeQualifiedProviderAccountUsageRecord,
} from "./usageRepository";

const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "list-capacity",
});
const serviceDigest = createQualifiedConnectedAccountServiceDigest(service);
const providerAccountId = "provider-list-capacity";
const inventorySize = 501;

/**
 * Directly seeded rows model inventory produced by a released predecessor or
 * retained by an Account migration. They must remain readable and mutable.
 */
async function retainGroupRows(accountId: string, count: number) {
    await db.connectedServiceAuthGroup.createMany({
        data: Array.from({ length: count }, (_, index) => {
            const groupId = `retained-${index}`;
            return {
                accountId,
                servicePluginId: service.pluginId,
                serviceLocalId: service.localId,
                qualifiedServiceDigest: serviceDigest,
                qualifiedGroupDigest:
                    createQualifiedConnectedAccountGroupDigest({
                        service,
                        groupId,
                    }),
                groupId,
                policyJson: "{}",
                stateJson: "{}",
            };
        }),
    });
}

async function createCredential(
    accountId: string,
    connectedAccountId = "qualified-account",
) {
    const ref = { service, accountId: connectedAccountId };
    const credential = await mutateQualifiedConnectedServiceCredential({
        accountId,
        ref,
        expectedCredentialRevision: null,
        authenticationModeId: "api-key",
        content: { t: "plain", v: { token: `credential-${connectedAccountId}` } },
        metadata: {
            scopes: [],
            providerIdentity: { accountId: providerAccountId },
        },
    });
    if (credential.status !== "written") {
        throw new Error("Expected qualified credential create");
    }
    return { credential, ref };
}

describe("qualified Connected Account inventory", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-inventory-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.connectedServiceAuthGroup.deleteMany();
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    async function account() {
        return await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
    }

    it("creates and lists 501 qualified credentials", async () => {
        const owner = await account();
        await db.serviceAccountToken.createMany({
            data: Array.from({ length: inventorySize - 1 }, (_, index) => ({
                accountId: owner.id,
                ...createServiceAccountTokenIdentityFields({
                    ref: { service, accountId: `retained/account/${index}` },
                    authenticationModeId: "api-key",
                }),
                token: Buffer.from("opaque-token", "utf8"),
            })),
        });
        await createCredential(owner.id, "retained/account/500");

        await expect(listQualifiedConnectedAccounts({
            accountId: owner.id,
            service,
        })).resolves.toHaveLength(inventorySize);
    }, 120_000);

    it("creates, projects, and deletes 501 groups", async () => {
        const owner = await account();
        await retainGroupRows(owner.id, inventorySize - 1);
        await expect(createQualifiedConnectedAccountGroup({
            accountId: owner.id,
            service,
            group: { groupId: "retained-500" },
        })).resolves.toMatchObject({ status: "written" });

        const listed = await listQualifiedConnectedAccountGroups({
            accountId: owner.id,
            service,
        });
        expect(listed).toHaveLength(inventorySize);

        // The Account-wide projection is what every connected-service mutation
        // republishes.
        const projection = await inTx(async (tx) => (
            await buildAccountConnectedServicesProjection({
                tx,
                accountId: owner.id,
                includeGroups: true,
            })
        ));
        expect(projection.connectedAccountGroupsV4).toHaveLength(inventorySize);

        const target = listed[0]!;
        await expect(deleteQualifiedConnectedAccountGroup({
            accountId: owner.id,
            service,
            groupId: target.ref.groupId,
            expectedGeneration: target.generation,
            expectedIncarnation: target.incarnation,
        })).resolves.toMatchObject({ status: "deleted" });
        await expect(db.connectedServiceAuthGroup.count({
            where: { accountId: owner.id },
        })).resolves.toBe(inventorySize - 1);
    }, 120_000);

    it("opens and deletes a usage record linked through 501 sources", async () => {
        const owner = await account();
        const { credential, ref } = await createCredential(owner.id);
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: providerAccountId,
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
            planLabel: "retained-inventory",
        });
        await writeQualifiedProviderAccountUsageRecord({
            accountId: owner.id,
            source: { ref, bindingKind: "account" },
            expectedCredentialRevision: credential.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        // One source per group membership joins the account binding already
        // written above, exercising a large retained source inventory.
        const stored = await db.connectedServiceUsageSource
            .findFirstOrThrow({
                where: { accountId: owner.id },
            });
        await db.connectedServiceUsageSource.createMany({
            data: Array.from({
                length: inventorySize - 1,
            }, (_, index) => ({
                accountId: stored.accountId,
                servicePluginId: stored.servicePluginId,
                serviceLocalId: stored.serviceLocalId,
                qualifiedServiceDigest: stored.qualifiedServiceDigest,
                connectedAccountId: stored.connectedAccountId,
                qualifiedIdentityDigest: stored.qualifiedIdentityDigest,
                credentialId: stored.credentialId,
                sourceKey: `${stored.sourceKey}:group:${index}`,
                providerAccountUsageRecordId:
                    stored.providerAccountUsageRecordId,
                bindingKind: "group_member",
                groupId: `retained-${index}`,
                groupGeneration: 1,
            })),
        });

        const opened = await readQualifiedProviderAccountUsageRecord({
            accountId: owner.id,
            recordId: snapshot.recordId,
        });
        expect(opened).toMatchObject({
            status: "resolved",
            sources: expect.any(Array),
        });
        if (opened.status !== "resolved") {
            throw new Error("Expected qualified usage record");
        }
        expect(opened.sources).toHaveLength(inventorySize);

        await expect(deleteQualifiedProviderAccountUsageRecord({
            accountId: owner.id,
            recordId: snapshot.recordId,
        })).resolves.toBe("deleted");
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: owner.id },
        })).resolves.toBe(0);
    }, 120_000);
});
