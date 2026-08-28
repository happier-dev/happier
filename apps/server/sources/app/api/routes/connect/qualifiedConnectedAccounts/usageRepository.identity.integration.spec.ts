import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    ConnectedServiceUsageSourceBindingError,
} from "../providerAccountUsage/types";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    mutateQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
} from "./groupRepository";
import {
    listQualifiedUsageSourcesForRecord,
    readQualifiedConnectedAccountUsageRecord,
    unlinkQualifiedConnectedAccountQuota,
    writeQualifiedProviderAccountUsageRecord,
} from "./usageRepository";

const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "identity-guard",
});
const providerAccountId = "provider-identity-guard";

describe("qualified Connected Account usage stored identity", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-usage-identity-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    async function createCredential(accountId: string) {
        const ref = {
            service,
            accountId: "qualified-account",
        };
        const credential =
            await mutateQualifiedConnectedServiceCredential({
                accountId,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: {
                    t: "plain",
                    v: { token: "credential" },
                },
                metadata: {
                    scopes: [],
                    providerIdentity: {
                        accountId: providerAccountId,
                    },
                },
            });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential create");
        }
        return { credential, ref };
    }

    function buildUsageWrite(
        accountId: string,
        params: Readonly<{
            credentialRevision: string;
            source: Parameters<
                typeof writeQualifiedProviderAccountUsageRecord
            >[0]["source"];
            fetchedAt: number;
            planLabel: string;
        }>,
    ) {
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: providerAccountId,
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: params.fetchedAt,
            recordKey,
            planLabel: params.planLabel,
        });
        return {
            accountId,
            source: params.source,
            expectedCredentialRevision:
                params.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1" as const,
            status: "ok" as const,
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        };
    }

    it("rejects a group binding whose stored structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const groupRef = {
            service,
            groupId: "qualified-group",
        };
        const createdGroup =
            await createQualifiedConnectedAccountGroup({
                accountId: account.id,
                service,
                group: { groupId: groupRef.groupId },
            });
        if (createdGroup.status !== "written") {
            throw new Error("Expected qualified group create");
        }
        const withMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration: createdGroup.group.generation,
                    expectedRuntimeStateRevision:
                        createdGroup.group.runtimeStateRevision,
                },
            });
        if (withMember.status !== "written") {
            throw new Error("Expected qualified group member create");
        }
        const storedGroup =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    groupId: groupRef.groupId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            });
        await db.connectedServiceAuthGroup.update({
            where: { id: storedGroup.id },
            data: {
                servicePluginId: "corrupt.group.identity",
            },
        });

        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: {
                ref,
                bindingKind: "group_member",
                groupId: groupRef.groupId,
                groupGeneration: withMember.group.generation,
            },
            fetchedAt: Date.now(),
            planLabel: "must-not-persist",
        });
        await expect(
            writeQualifiedProviderAccountUsageRecord(write),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: { id: storedGroup.id },
                select: {
                    servicePluginId: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            }),
        ).resolves.toEqual({
            servicePluginId: "corrupt.group.identity",
            qualifiedServiceDigest:
                storedGroup.qualifiedServiceDigest,
            qualifiedGroupDigest:
                storedGroup.qualifiedGroupDigest,
        });
    });

    it("rejects projection from a usage row whose structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                serviceLocalId: "corrupt-usage-identity",
            },
        });

        await expect(listQualifiedUsageSourcesForRecord({
            accountId: account.id,
            recordId: write.recordId,
        })).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            }),
        ).resolves.toEqual({
            serviceLocalId: "corrupt-usage-identity",
            qualifiedServiceDigest:
                source.qualifiedServiceDigest,
            qualifiedIdentityDigest:
                source.qualifiedIdentityDigest,
        });
    });

    it("finds a valid account source after more than fifty earlier unproven sources", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } = await createCredential(account.id);
        const validWrite = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "valid-after-unproven-sources",
        });
        await writeQualifiedProviderAccountUsageRecord(validWrite);

        const storedCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
            },
        });
        const laterUpdatedAt = new Date(Date.now() + 60_000);
        for (let index = 0; index < 50; index += 1) {
            const recordId = `unproven-record-${index}`;
            await db.providerAccountUsageRecord.create({
                data: {
                    accountId: account.id,
                    providerId: `unproven-provider-${index}`,
                    recordId,
                    accountSubjectId: `unproven-subject-${index}`,
                    subjectKind: "workspace",
                    quotaScope: "workspace",
                    quotaScopeId: `unproven-scope-${index}`,
                    quotaScopeIdKey: `unproven-scope-${index}`,
                    recordKeyJson: {},
                    payloadMode: "plain_json_v1",
                    status: "ok",
                    updatedAt: laterUpdatedAt,
                },
            });
            await db.connectedServiceUsageSource.create({
                data: {
                    accountId: account.id,
                    servicePluginId: storedCredential.servicePluginId,
                    serviceLocalId: storedCredential.serviceLocalId,
                    qualifiedServiceDigest:
                        storedCredential.qualifiedServiceDigest,
                    connectedAccountId:
                        storedCredential.connectedAccountId,
                    qualifiedIdentityDigest:
                        storedCredential.qualifiedIdentityDigest,
                    credentialId: storedCredential.id,
                    sourceKey: `unproven-source-${index}`,
                    providerAccountUsageRecordId: recordId,
                    bindingKind: "account",
                    updatedAt: laterUpdatedAt,
                },
            });
        }

        await expect(readQualifiedConnectedAccountUsageRecord({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({ recordId: validWrite.recordId });
    });

    it("rolls back a usage write instead of repairing a corrupt source tuple through its digest lookup", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const firstWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(
            firstWrite,
        );
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId:
                        firstWrite.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                connectedAccountId:
                    "corrupt-usage-account",
            },
        });
        const replacementWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: firstWrite.fetchedAt + 1,
            planLabel: "must-not-replace",
        });

        await expect(
            writeQualifiedProviderAccountUsageRecord(
                replacementWrite,
            ),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.providerAccountUsageRecord.findUniqueOrThrow({
                where: {
                    accountId_recordId: {
                        accountId: account.id,
                        recordId: firstWrite.recordId,
                    },
                },
                select: { snapshot: true },
            }),
        ).resolves.toMatchObject({
            snapshot: {
                planLabel: "original",
            },
        });
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    connectedAccountId: true,
                    providerAccountUsageRecordId: true,
                },
            }),
        ).resolves.toEqual({
            connectedAccountId:
                "corrupt-usage-account",
            providerAccountUsageRecordId:
                firstWrite.recordId,
        });
    });

    it("refuses digest-addressed unlink when a matched source has a corrupt structured tuple", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "must-remain-linked",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                servicePluginId:
                    "corrupt.unlink.identity",
            },
        });

        await expect(
            unlinkQualifiedConnectedAccountQuota({
                accountId: account.id,
                ref,
            }),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.count({
                where: { id: source.id },
            }),
        ).resolves.toBe(1);
    });
});
