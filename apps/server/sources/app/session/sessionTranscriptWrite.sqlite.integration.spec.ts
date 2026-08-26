import { createHash, randomUUID } from "node:crypto";

import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    makeExternalSessionHistoricalImportBatchIdV1,
    projectSessionSharedMetadataV1,
    UsageAnalyticsQueryRequestSchema,
} from "@happier-dev/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    buildSessionMessagePublicationWhere,
    loadSessionTranscriptPublication,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { createSessionMessageFromPending } from "@/app/session/pending/pendingMessageTranscriptCommit";
import {
    writeHistoricalSessionMessageBatch,
    writeHistoricalSessionMessageBatchInTx,
} from "@/app/session/sessionTranscriptWrite";
import {
    executeExternalSessionHistoricalImportCommand as executeExternalSessionHistoricalImportCommandWithLimits,
} from "@/app/session/externalSessionHistoricalImportCommand";
import { deriveSessionSystemRecordAddressKeys } from "@/app/session/systemRecords/sessionSystemRecordAddressKeys";
import { loadUsageMessageStatsForQuery } from "@/app/usage/query/loadUsageMessageStatsForQuery";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionRoutes } from "@/app/api/routes/session/sessionRoutes";
import { publicShareRoutes } from "@/app/api/routes/share/publicShareRoutes";

const defaultHistoricalImportSocketLimits = {
    maxItems: 200,
    maxSerializedBytes: 512 * 1024,
} as const;
const LIVE_EXTERNAL_LINK_OWNER_METADATA =
    "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
const RETIRED_EXTERNAL_LINK_OWNER_METADATA =
    "oRohIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh6m869PVe0miAb8CnDsASVAnt9+tG1Zg==";
const LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE = {
    t: "encrypted",
    c: LIVE_EXTERNAL_LINK_OWNER_METADATA,
} as const;
const RETIRED_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE = {
    t: "encrypted",
    c: RETIRED_EXTERNAL_LINK_OWNER_METADATA,
} as const;
const STORED_PLAIN_OWNER_METADATA_ENVELOPE = JSON.stringify(
    createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 }),
);
const STORED_SHARED_METADATA = JSON.stringify(
    projectSessionSharedMetadataV1({ metadata: {} }),
);
const CURRENT_ACCOUNT_STORED_CONTENT_HEADERS =
    buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );

async function executeExternalSessionHistoricalImportCommand(
    params: Omit<
        Parameters<typeof executeExternalSessionHistoricalImportCommandWithLimits>[0],
        "limits"
    > & Readonly<{
        limits?: Parameters<typeof executeExternalSessionHistoricalImportCommandWithLimits>[0]["limits"];
    }>,
) {
    return await executeExternalSessionHistoricalImportCommandWithLimits({
        ...params,
        limits: params.limits ?? defaultHistoricalImportSocketLimits,
    });
}

function hostSystemRecordUniqueWhere(params: Readonly<{
    accountId: string;
    sessionId: string;
    namespace: string;
    localId: string;
}>) {
    const keys = deriveSessionSystemRecordAddressKeys({
        ownerKind: "host",
        pluginId: null,
        namespace: params.namespace,
        localId: params.localId,
    });
    return {
        accountId_sessionId_recordAddressKey: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            recordAddressKey: keys.recordAddressKey,
        },
    };
}

describe("canonical transcript sequence writer on SQLite", () => {
    let harness: LightSqliteHarness;
    let previousStoragePolicy: string | undefined;

    beforeAll(async () => {
        previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-historical-import-writer-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (previousStoragePolicy === undefined) {
            delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        } else {
            process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
        }
        await harness.close();
    });

    it("creates fresh SQLite transcript tables with the private Message row revision", async () => {
        const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(
            "SELECT name FROM pragma_table_info('SessionMessage')",
        );

        expect(columns.map((column) => column.name)).toContain("rowRevision");
    });

    it("keeps non-owner recency byte-stable during hidden catch-up and advances it only on publication", async () => {
        const owner = await db.account.create({
            data: { publicKey: `c1-recency-owner-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const viewer = await db.account.create({
            data: { publicKey: `c1-recency-viewer-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const publicationBase = 1_700_000_000_000;
        const sessionIds = Array.from({ length: 151 }, (_, index) => `c1-recency-${randomUUID()}-${index}`);
        const targetIndex = 75;
        const boundaryIndex = 150;
        const publicationAtForIndex = (index: number) => publicationBase + ((151 - index) * 1_000);

        await db.session.createMany({
            data: sessionIds.map((id, index) => ({
                id,
                tag: `c1-recency-tag-${randomUUID()}-${index}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: STORED_SHARED_METADATA,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA_ENVELOPE,
                currentStorageState: "snapshot_complete",
                materializationPublicationId: `publication-${index}`,
                materializedThroughSourceAt: BigInt(publicationAtForIndex(index)),
                publishedThroughServerSeq: 0,
                meaningfulActivityAt: new Date(publicationAtForIndex(index)),
                createdAt: new Date(publicationAtForIndex(index)),
                updatedAt: new Date(publicationAtForIndex(index)),
            })),
        });
        await db.sessionShare.createMany({
            data: sessionIds.map((sessionId, index) => ({
                id: `c1-recency-share-${randomUUID()}-${index}`,
                sessionId,
                sharedByUserId: owner.id,
                sharedWithUserId: viewer.id,
                accessLevel: "view",
            })),
        });

        const publicToken = `c1-recency-public-${randomUUID()}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: sessionIds[targetIndex]!,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(publicToken, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        const beginCatchup = async (index: number) => {
            const claim = {
                sessionId: sessionIds[index]!,
                operationId: `recency-operation-${index}`,
                operationClaimId: `recency-claim-${index}`,
            } as const;
            const expectedPublication = {
                materializationPublicationId: `publication-${index}`,
                materializedThroughSourceAt: publicationAtForIndex(index),
                publishedThroughServerSeq: 0,
            } as const;
            await expect(executeExternalSessionHistoricalImportCommand({
                actorUserId: owner.id,
                transportMachineId: "machine-recency",
                command: {
                    v: 1,
                    kind: "begin",
                    claim,
                    expectedRevision: 0,
                    expectedPriorStableStorage: {
                        state: "snapshot_complete",
                        publication: expectedPublication,
                    },
                },
            })).resolves.toMatchObject({ kind: "ready" });
            await expect(executeExternalSessionHistoricalImportCommand({
                actorUserId: owner.id,
                transportMachineId: "machine-recency",
                command: {
                    v: 1,
                    kind: "batch",
                    claim,
                    expectedRevision: 0,
                    batchId: makeExternalSessionHistoricalImportBatchIdV1([
                        `recency-item-${index}`,
                    ]),
                    items: [{
                        localId: `recency-item-${index}`,
                        sidechainId: null,
                        messageRole: "agent",
                        content: { t: "plain", v: { text: `hidden-${index}` } },
                    }],
                },
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                acceptedThroughServerSeq: 1,
            });
            return claim;
        };

        const targetClaim = await beginCatchup(targetIndex);
        await beginCatchup(boundaryIndex);

        await withAuthenticatedTestApp(
            (app) => {
                sessionRoutes(app as never);
                publicShareRoutes(app as never);
            },
            async (app) => {
                const readV1 = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: "/v1/sessions",
                        headers: {
                            "x-test-user-id": viewer.id,
                            ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                        },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().sessions as Array<{ id: string; updatedAt: number }>;
                };
                const readV2Detail = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/v2/sessions/${sessionIds[targetIndex]}`,
                        headers: {
                            "x-test-user-id": viewer.id,
                            ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                        },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().session as { updatedAt: number };
                };
                const readV2List = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: "/v2/sessions?limit=200",
                        headers: {
                            "x-test-user-id": viewer.id,
                            ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                        },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().sessions as Array<{ id: string; updatedAt: number }>;
                };
                const readPublic = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/v1/public-share/${encodeURIComponent(publicToken)}`,
                        headers: CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().session as { updatedAt: number };
                };

                const expectedBaselineIds = sessionIds.slice(0, 150);
                const hiddenList = await readV1();
                expect(hiddenList.map((session) => session.id)).toEqual(expectedBaselineIds);
                expect(hiddenList.find((session) => session.id === sessionIds[targetIndex])?.updatedAt)
                    .toBe(publicationAtForIndex(targetIndex));
                expect(hiddenList.some((session) => session.id === sessionIds[boundaryIndex])).toBe(false);
                await expect(readV2Detail()).resolves.toMatchObject({
                    updatedAt: publicationAtForIndex(targetIndex),
                });
                const hiddenV2List = await readV2List();
                expect(hiddenV2List.map((session) => session.id)).toEqual(sessionIds);
                expect(hiddenV2List[targetIndex]).toMatchObject({
                    id: sessionIds[targetIndex],
                    updatedAt: publicationAtForIndex(targetIndex),
                });
                await expect(readPublic()).resolves.toMatchObject({
                    updatedAt: publicationAtForIndex(targetIndex),
                });

                await expect(executeExternalSessionHistoricalImportCommand({
                    actorUserId: owner.id,
                    transportMachineId: "machine-recency",
                    command: {
                        v: 1,
                        kind: "finalize",
                        claim: targetClaim,
                        expectedRevision: 0,
                        expectedAcceptedThroughServerSeq: 0,
                    },
                })).resolves.toMatchObject({
                    kind: "error",
                    errorCode: "stale_revision",
                });
                expect(await readV1()).toEqual(hiddenList);
                await expect(readV2Detail()).resolves.toMatchObject({
                    updatedAt: publicationAtForIndex(targetIndex),
                });
                expect(await readV2List()).toEqual(hiddenV2List);
                await expect(readPublic()).resolves.toMatchObject({
                    updatedAt: publicationAtForIndex(targetIndex),
                });

                const finalized = await executeExternalSessionHistoricalImportCommand({
                    actorUserId: owner.id,
                    transportMachineId: "machine-recency",
                    command: {
                        v: 1,
                        kind: "finalize",
                        claim: targetClaim,
                        expectedRevision: 0,
                        expectedAcceptedThroughServerSeq: 1,
                    },
                });
                expect(finalized).toMatchObject({
                    kind: "finalized",
                    publication: {
                        publishedThroughServerSeq: 1,
                        materializedThroughSourceAt: expect.any(Number),
                    },
                });
                if (finalized.kind !== "finalized") {
                    throw new Error("Expected catch-up finalization.");
                }

                const publishedAt = finalized.publication.materializedThroughSourceAt;
                const publishedList = await readV1();
                expect(publishedList[0]).toMatchObject({
                    id: sessionIds[targetIndex],
                    updatedAt: publishedAt,
                });
                expect(publishedList.some((session) => session.id === sessionIds[boundaryIndex])).toBe(false);
                await expect(readV2Detail()).resolves.toMatchObject({ updatedAt: publishedAt });
                const publishedV2List = await readV2List();
                expect(publishedV2List.map((session) => session.id)).toEqual([
                    sessionIds[targetIndex],
                    ...sessionIds.filter((_, index) => index !== targetIndex),
                ]);
                expect(publishedV2List[0]).toMatchObject({
                    id: sessionIds[targetIndex],
                    updatedAt: publishedAt,
                });
                await expect(readPublic()).resolves.toMatchObject({ updatedAt: publishedAt });
            },
        );
    }, 120_000);

    it("refuses the reserved Agent-transition divider namespace at the historical batch owner", async () => {
        // The reserved namespace is enforced at THIS owner rather than at the
        // hosted `/transcript/import` adapter, because the batch writer has two
        // callers: the hosted import route and the external-Session historical
        // import command. Guarding the adapter alone would leave the second one
        // able to plant `agent-transition:<inputLocalId>` and permanently block
        // the owner-only transition's divider append on that Session.
        const account = await db.account.create({
            data: { publicKey: `reserved-divider-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `reserved-divider-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });

        const planted = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "agent-transition:submitted-1",
                sidechainId: null,
                messageRole: "event" as const,
                content: { t: "plain" as const, v: { role: "agent", text: "planted" } },
            }],
        });
        expect(planted).toEqual({ ok: false, error: "reserved-local-id" });

        // A whole batch is refused when ANY item is reserved: a partial write
        // would still let the attacker choose what lands.
        const mixed = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [
                {
                    localId: "history:legitimate",
                    sidechainId: null,
                    messageRole: "user" as const,
                    content: { t: "plain" as const, v: { role: "user", text: "history" } },
                },
                {
                    localId: "agent-transition:submitted-2",
                    sidechainId: null,
                    messageRole: "event" as const,
                    content: { t: "plain" as const, v: { role: "agent", text: "planted" } },
                },
            ],
        });
        expect(mixed).toEqual({ ok: false, error: "reserved-local-id" });

        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
            .toEqual({ seq: 0 });
    }, 60_000);

    it("keeps historical, Pending, and ordinary writes gapless while fencing stale historical retries after storage transfer", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const historyItems = [{
            localId: "history:item-1",
            sidechainId: "child-thread-1",
            messageRole: "user" as const,
            content: { t: "plain" as const, v: { role: "user", text: "history" } },
        }];

        const history = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: historyItems,
        });
        expect(history).toMatchObject({ ok: true, didWrite: true, firstSeq: 1, lastSeq: 1 });

        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "hosted" },
        });

        const pending = await inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId: session.id,
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending:item-1",
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", text: "pending" } },
        }));
        expect(pending).toMatchObject({ ok: true, didWrite: true, message: { seq: 2 } });

        const ordinary = await createSessionMessage({
            actorUserId: account.id,
            sessionId: session.id,
            localId: "ordinary:item-1",
            messageRole: "event",
            content: { t: "plain", v: { role: "agent", content: { type: "event", data: { type: "ready" } } } },
        });
        expect(ordinary).toMatchObject({ ok: true, didWrite: true, message: { seq: 3 } });

        const retry = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: historyItems,
        });
        // A storage-owner transfer is a fence, not a read capability: an exact
        // historical local-id retry must be rejected before it can inspect the
        // hosted transcript. Same-owner retries and finalized import receipts
        // retain their own canonical idempotency coverage.
        expect(retry).toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_storage_authority_mismatch",
        });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
            .toEqual({ seq: 3 });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(3);

        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "machine_only" },
        });

        await expect(inTx(async (tx) => {
            const result = await writeHistoricalSessionMessageBatchInTx(tx, {
                sessionId: session.id,
                storagePolicy: "optional",
                items: [{
                    localId: "history:rolled-back",
                    sidechainId: null,
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", text: "rollback" } },
                }],
            });
            expect(result).toMatchObject({ ok: true, didWrite: true, firstSeq: 4, lastSeq: 4 });
            throw new Error("rollback historical batch");
        })).rejects.toThrow("rollback historical batch");

        const modeConflict = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "history:encrypted",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "ciphertext" },
            }],
        });
        expect(modeConflict).toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_encryption_mode_mismatch",
        });

        const stored = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true, sidechainId: true },
        });
        expect(stored).toEqual([
            { seq: 1, localId: "history:item-1", sidechainId: "child-thread-1" },
            { seq: 2, localId: "pending:item-1", sidechainId: null },
            { seq: 3, localId: "ordinary:item-1", sidechainId: null },
        ]);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
            .toEqual({ seq: 3 });
    }, 120_000);

    it("rejects preactivation structured snapshots at the HTTP, Pending, and historical-import entries without allocating a message", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-structured-presentation-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-structured-presentation-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        const structuredContent = {
            t: "plain" as const,
            v: {
                v: 1,
                profile: "pluginTranscriptV1",
                owner: { pluginId: "acme.preview", contributionLocalId: "review-card" },
                snapshot: { kind: "text", text: "must wait for a reader floor" },
            },
        };
        const expectNoMessageMutation = async () => {
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { seq: true },
            })).resolves.toEqual({ seq: 0 });
            await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        };

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as never),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: `/v2/sessions/${session.id}/messages`,
                    headers: {
                        "x-test-user-id": account.id,
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                    payload: { content: structuredContent, localId: "http:structured-presentation" },
                });

                expect(response.statusCode, response.body).toBe(400);
                expect(response.json()).toMatchObject({
                    error: "Invalid parameters",
                    code: "session_structured_presentation_unavailable",
                });
            },
        );
        await expectNoMessageMutation();

        await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId: session.id,
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending:structured-presentation",
            messageRole: "agent",
            content: structuredContent,
        }))).resolves.toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_unavailable",
        });
        await expectNoMessageMutation();

        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "machine_only" },
        });
        await expect(writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "import:structured-presentation",
                sidechainId: null,
                messageRole: "agent",
                content: structuredContent,
            }],
        })).resolves.toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_unavailable",
        });
        await expectNoMessageMutation();

        // Pending settlement normally updates an existing row directly to
        // backfill its role. It must not make a previously supplied snapshot
        // current merely because it avoids the insert writer.
        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "hosted", seq: 1 },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId: "pending:existing-structured-presentation",
                sidechainId: null,
                messageRole: null,
                content: structuredContent,
            },
        });
        await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
            sessionId: session.id,
            sessionEncryptionMode: "plain",
            storagePolicy: "optional",
            localId: "pending:existing-structured-presentation",
            messageRole: "agent",
            content: structuredContent,
        }))).resolves.toEqual({
            ok: false,
            error: "storage-mode-conflict",
            code: "session_structured_presentation_unavailable",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true },
        })).resolves.toEqual({ seq: 1 });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: {
                sessionId_localId: {
                    sessionId: session.id,
                    localId: "pending:existing-structured-presentation",
                },
            },
            select: { messageRole: true, content: true },
        })).resolves.toEqual({
            messageRole: null,
            content: structuredContent,
        });
    }, 120_000);

    it.each(["machine_only", "server_partial", "snapshot_complete"] as const)(
        "rejects ordinary and Pending transcript writes while %s owns transcript storage",
        async (currentStorageState) => {
            const account = await db.account.create({
                data: { publicKey: `c1-storage-authority-${currentStorageState}-${randomUUID()}` },
                select: { id: true },
            });
            const session = await db.session.create({
                data: {
                    tag: `c1-storage-authority-${currentStorageState}-${randomUUID()}`,
                    accountId: account.id,
                    metadata: "metadata",
                    encryptionMode: "plain",
                    currentStorageState,
                },
                select: { id: true },
            });
            const baselineContent = { t: "plain" as const, v: { text: "historical baseline" } };
            await expect(writeHistoricalSessionMessageBatch({
                sessionId: session.id,
                storagePolicy: "optional",
                items: [{
                    localId: `existing:${currentStorageState}`,
                    sidechainId: null,
                    messageRole: "agent",
                    content: baselineContent,
                }],
            })).resolves.toMatchObject({
                ok: true,
                didWrite: true,
                firstSeq: 1,
                lastSeq: 1,
            });

            await expect(createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: `ordinary:${currentStorageState}`,
                messageRole: "user",
                content: { t: "plain", v: { text: "ordinary" } },
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            });
            await expect(createSessionMessage({
                actorUserId: account.id,
                sessionId: session.id,
                localId: `existing:${currentStorageState}`,
                messageRole: "agent",
                content: baselineContent,
            })).resolves.toEqual({
                ok: false,
                error: "invalid-params",
                code: "session_storage_authority_mismatch",
            });

            await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
                sessionId: session.id,
                sessionEncryptionMode: "plain",
                storagePolicy: "optional",
                localId: `pending:${currentStorageState}`,
                messageRole: "agent",
                content: { t: "plain", v: { text: "pending" } },
            }))).resolves.toEqual({
                ok: false,
                error: "storage-mode-conflict",
                code: "session_storage_authority_mismatch",
            });
            await expect(inTx(async (tx) => await createSessionMessageFromPending(tx, {
                sessionId: session.id,
                sessionEncryptionMode: "plain",
                storagePolicy: "optional",
                localId: `existing:${currentStorageState}`,
                messageRole: "agent",
                content: baselineContent,
            }))).resolves.toEqual({
                ok: false,
                error: "storage-mode-conflict",
                code: "session_storage_authority_mismatch",
            });

            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { seq: true },
            })).resolves.toEqual({ seq: 1 });
            await expect(db.sessionMessage.count({
                where: { sessionId: session.id },
            })).resolves.toBe(1);
        },
        120_000,
    );

    it("fails closed when a historical import digest lookup resolves another raw host address", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-address-collision-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-address-collision-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-address-collision",
            operationClaimId: "materialize-claim-address-collision",
        } as const;
        const expectedLocalId = `historical-import:${claim.operationId}`;
        const addressKeys = deriveSessionSystemRecordAddressKeys({
            ownerKind: "host",
            pluginId: null,
            namespace: "external_sessions",
            localId: expectedLocalId,
        });
        await db.sessionSystemRecord.create({
            data: {
                accountId: account.id,
                sessionId: session.id,
                namespace: "other_private_namespace",
                kind: "historical_import",
                localId: "another-private-job",
                content: { v: 1 },
                ownerKind: "host",
                pluginId: null,
                namespaceAddressKey: addressKeys.namespaceAddressKey,
                recordAddressKey: addressKeys.recordAddressKey,
                version: 1,
            },
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-address-collision",
            command: { v: 1, kind: "inspect", claim, expectedRevision: 0 },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "internal_error",
        });
    });

    it("fails closed without overwriting another kind at the exact historical import address", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-kind-conflict-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-kind-conflict-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-kind-conflict",
            operationClaimId: "materialize-claim-kind-conflict",
        } as const;
        const command = {
            v: 1 as const,
            kind: "begin" as const,
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" as const },
        };

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-kind-conflict",
            command,
        })).resolves.toMatchObject({ kind: "ready" });

        const record = await db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
            select: { id: true, content: true },
        });
        await db.sessionSystemRecord.update({
            where: { id: record.id },
            data: { kind: "another_private_kind" },
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-kind-conflict",
            command: { v: 1, kind: "inspect", claim, expectedRevision: 0 },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "internal_error",
        });
        await expect(db.sessionSystemRecord.findUniqueOrThrow({
            where: { id: record.id },
            select: { kind: true, content: true },
        })).resolves.toEqual({
            kind: "another_private_kind",
            content: record.content,
        });
    });

    it("binds one historical import claim, fences partial rows, and publishes atomically", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-1",
            operationClaimId: "materialize-claim-1",
        } as const;
        const unsafeHosted = await db.session.create({
            data: {
                tag: `c1-materialize-unsafe-hosted-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "hosted",
                seq: 1,
            },
            select: { id: true },
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "begin",
                claim: { ...claim, sessionId: unsafeHosted.id, operationId: "unsafe-hosted" },
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "storage_mode_conflict",
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "inspect", claim, expectedRevision: 0 },
        })).resolves.toMatchObject({
            kind: "authority",
            claim,
            revision: 0,
            priorStableStorage: { state: "machine_only" },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { currentStorageState: true },
        })).resolves.toEqual({ currentStorageState: "hosted" });
        await expect(db.sessionSystemRecord.count({
            where: {
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
            },
        })).resolves.toBe(0);
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "begin",
                claim,
                expectedRevision: 0,
                expectedPriorStableStorage: {
                    state: "snapshot_complete",
                    publication: {
                        materializationPublicationId: "stale-publication",
                        materializedThroughSourceAt: 1,
                        publishedThroughServerSeq: 0,
                    },
                },
            },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "storage_mode_conflict",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { currentStorageState: true },
        })).resolves.toEqual({ currentStorageState: "hosted" });
        await expect(db.sessionSystemRecord.count({
            where: {
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
            },
        })).resolves.toBe(0);

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "begin",
                claim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            },
        })).resolves.toMatchObject({
            kind: "ready",
            claim,
            revision: 0,
            priorStableStorage: { state: "machine_only" },
        });

        const partial = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                publishedThroughServerSeq: true,
            },
        });
        expect(partial).toEqual({
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "inspect", claim, expectedRevision: 1 },
        })).resolves.toMatchObject({
            kind: "authority",
            claim,
            revision: 1,
            priorStableStorage: { state: "machine_only" },
        });
        const jobAfterInspect = await db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
            select: {
                content: true,
                ownerKind: true,
                pluginId: true,
                namespaceAddressKey: true,
                recordAddressKey: true,
                version: true,
            },
        });
        expect(jobAfterInspect.content).toMatchObject({ revision: 0 });
        expect(jobAfterInspect).toMatchObject({
            ownerKind: "host",
            pluginId: null,
            version: 1,
        });
        expect(Buffer.from(jobAfterInspect.namespaceAddressKey ?? []).toString("hex")).toBe(
            "923c641e9011f00d5b9f88e837139f7e8f70fcc155261e72faf1b4fe2735ee60",
        );
        expect(Buffer.from(jobAfterInspect.recordAddressKey ?? []).toString("hex")).toBe(
            "864dc2d19471d84126662539e3ffae7f8337dd1aa199525662de882f977466b7",
        );
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "resume", claim, expectedRevision: 1 },
        })).resolves.toMatchObject({
            kind: "ready",
            revision: 1,
            priorStableStorage: { state: "machine_only" },
        });

        const batch = {
            v: 1 as const,
            kind: "batch" as const,
            claim,
            expectedRevision: 1,
            batchId: makeExternalSessionHistoricalImportBatchIdV1(["history:oldest"]),
            items: [{
                localId: "history:oldest",
                sidechainId: null,
                messageRole: "user" as const,
                content: { t: "plain" as const, v: { role: "user", text: "oldest" } },
            }],
        };
        const concurrentBatchResults = await Promise.all([
            executeExternalSessionHistoricalImportCommand({
                actorUserId: account.id,
                transportMachineId: "machine-1",
                command: batch,
            }),
            executeExternalSessionHistoricalImportCommand({
                actorUserId: account.id,
                transportMachineId: "machine-1",
                command: batch,
            }),
        ]);
        expect(concurrentBatchResults).toEqual([
            expect.objectContaining({
                kind: "batch_accepted",
                batchId: batch.batchId,
                acceptedThroughServerSeq: 1,
            }),
            expect.objectContaining({
                kind: "batch_accepted",
                batchId: batch.batchId,
                acceptedThroughServerSeq: 1,
            }),
        ]);
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                ...batch,
                items: [{
                    ...batch.items[0]!,
                    content: { t: "plain", v: { role: "user", text: "changed" } },
                }],
            },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "batch_conflict",
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: batch,
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-2",
            command: {
                ...batch,
                batchId: makeExternalSessionHistoricalImportBatchIdV1(["history:foreign"]),
                items: [{ ...batch.items[0]!, localId: "history:foreign" }],
            },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "wrong_machine_socket",
        });

        const privateTail = await writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "history:not-published",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { text: "not published" } },
            }],
        });
        expect(privateTail).toMatchObject({
            ok: true,
            didWrite: true,
            firstSeq: 2,
            lastSeq: 2,
        });
        const readVisibleRows = async () => {
            const publication = await loadSessionTranscriptPublication(db, session.id);
            return await db.sessionMessage.findMany({
                where: buildSessionMessagePublicationWhere({
                    where: { sessionId: session.id },
                    publication,
                }),
                orderBy: { seq: "asc" },
                select: { seq: true, localId: true },
            });
        };
        await expect(readVisibleRows()).resolves.toEqual([
            { seq: 1, localId: "history:oldest" },
        ]);
        await expect(loadUsageMessageStatsForQuery(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({}),
            [session.id],
        )).resolves.toEqual({ messageCount: 1 });

        const finalized = await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "finalize",
                claim,
                expectedRevision: 1,
                expectedAcceptedThroughServerSeq: 1,
            },
        });
        expect(finalized).toMatchObject({
            kind: "finalized",
            acceptedThroughServerSeq: 1,
            publication: {
                materializationPublicationId: expect.any(String),
                materializedThroughSourceAt: expect.any(Number),
                publishedThroughServerSeq: 1,
            },
        });

        const published = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                latestReadyEventSeq: true,
                latestTurnId: true,
                pendingCount: true,
            },
        });
        expect(published).toMatchObject({
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 1,
            latestReadyEventSeq: null,
            latestTurnId: null,
            pendingCount: 0,
        });
        expect(published.materializationPublicationId).toEqual(expect.any(String));
        expect(published.materializedThroughSourceAt).not.toBeNull();
        if (
            published.materializationPublicationId === null
            || published.materializedThroughSourceAt === null
        ) {
            throw new Error("Expected finalized publication fields.");
        }
        const expectedPublication = {
            materializationPublicationId: published.materializationPublicationId,
            materializedThroughSourceAt: Number(published.materializedThroughSourceAt),
            publishedThroughServerSeq: 1,
        };
        expect(finalized).toMatchObject({ publication: expectedPublication });
        await expect(readVisibleRows()).resolves.toEqual([
            { seq: 1, localId: "history:oldest" },
        ]);
        await expect(loadUsageMessageStatsForQuery(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({}),
            [session.id],
        )).resolves.toEqual({ messageCount: 1 });

        const replacementClaim = {
            ...claim,
            operationId: "materialize-operation-2",
            operationClaimId: "materialize-claim-2",
        };
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "inspect",
                claim: replacementClaim,
                expectedRevision: 0,
            },
        })).resolves.toMatchObject({
            kind: "authority",
            claim: replacementClaim,
            revision: 0,
            priorStableStorage: {
                state: "snapshot_complete",
                publication: expectedPublication,
            },
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "begin",
                claim: replacementClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: {
                    state: "snapshot_complete",
                    publication: expectedPublication,
                },
            },
        })).resolves.toMatchObject({
            kind: "ready",
            claim: replacementClaim,
            revision: 0,
            priorStableStorage: {
                state: "snapshot_complete",
                publication: expectedPublication,
            },
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "finalize",
                claim,
                expectedRevision: 1,
                expectedAcceptedThroughServerSeq: 1,
            },
        })).resolves.toMatchObject({
            kind: "finalized",
            claim,
            revision: 1,
            acceptedThroughServerSeq: 1,
            publication: expectedPublication,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "resume", claim, expectedRevision: 3 },
        })).resolves.toMatchObject({
            kind: "finalized",
            claim,
            revision: 3,
            acceptedThroughServerSeq: 1,
            publication: expectedPublication,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "resume", claim, expectedRevision: 3 },
        })).resolves.toMatchObject({
            kind: "finalized",
            claim,
            revision: 3,
            acceptedThroughServerSeq: 1,
            publication: expectedPublication,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: { v: 1, kind: "resume", claim, expectedRevision: 2 },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "stale_revision",
        });
    }, 120_000);

    it.each([
        ["zero-batch lower", 0, 2, "error"],
        ["lower", 1, 2, "error"],
        ["equal", 2, 2, "finalized"],
        ["higher", 3, 3, "finalized"],
    ] as const)(
        "keeps an existing shared publication monotone for a %s update import",
        async (_caseName, acceptedCeiling, expectedVisibleCount, expectedKind) => {
            const owner = await db.account.create({
                data: { publicKey: `c1-materialize-monotone-owner-${randomUUID()}` },
                select: { id: true },
            });
            const viewer = await db.account.create({
                data: { publicKey: `c1-materialize-monotone-viewer-${randomUUID()}` },
                select: { id: true },
            });
            const session = await db.session.create({
                data: {
                    tag: `c1-materialize-monotone-${randomUUID()}`,
                    accountId: owner.id,
                    metadata: "metadata",
                    encryptionMode: "plain",
                    currentStorageState: "machine_only",
                },
                select: { id: true },
            });
            const execute = async (command: unknown) =>
                await executeExternalSessionHistoricalImportCommand({
                    actorUserId: owner.id,
                    transportMachineId: "machine-materialize-monotone",
                    command,
                });
            const items = [
                {
                    localId: "history:monotone-first",
                    sidechainId: null,
                    messageRole: "user" as const,
                    content: { t: "plain" as const, v: { text: "first" } },
                },
                {
                    localId: "history:monotone-second",
                    sidechainId: null,
                    messageRole: "agent" as const,
                    content: { t: "plain" as const, v: { text: "second" } },
                },
                {
                    localId: "history:monotone-third",
                    sidechainId: null,
                    messageRole: "agent" as const,
                    content: { t: "plain" as const, v: { text: "third" } },
                },
            ];
            const initialClaim = {
                sessionId: session.id,
                operationId: `materialize-monotone-initial-${randomUUID()}`,
                operationClaimId: `materialize-monotone-initial-claim-${randomUUID()}`,
            } as const;

            await expect(execute({
                v: 1,
                kind: "begin",
                claim: initialClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            })).resolves.toMatchObject({ kind: "ready" });
            await expect(execute({
                v: 1,
                kind: "batch",
                claim: initialClaim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1(
                    items.slice(0, 2).map((item) => item.localId),
                ),
                items: items.slice(0, 2),
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                acceptedThroughServerSeq: 2,
            });
            const initialFinalized = await execute({
                v: 1,
                kind: "finalize",
                claim: initialClaim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: 2,
            });
            expect(initialFinalized).toMatchObject({ kind: "finalized" });
            if (initialFinalized.kind !== "finalized") {
                throw new Error("Expected initial historical import to finalize.");
            }
            await db.sessionShare.create({
                data: {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: viewer.id,
                    accessLevel: "view",
                },
            });

            const publicationSelect = {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
            } as const;
            const rowSelect = {
                seq: true,
                localId: true,
                messageRole: true,
                content: true,
            } as const;
            const initialPublication = await db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: publicationSelect,
            });
            const initialRows = await db.sessionMessage.findMany({
                where: { sessionId: session.id },
                orderBy: { seq: "asc" },
                select: rowSelect,
            });
            const updateClaim = {
                sessionId: session.id,
                operationId: `materialize-monotone-update-${randomUUID()}`,
                operationClaimId: `materialize-monotone-update-claim-${randomUUID()}`,
            } as const;

            await expect(execute({
                v: 1,
                kind: "begin",
                claim: updateClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: {
                    state: "snapshot_complete",
                    publication: initialFinalized.publication,
                },
            })).resolves.toMatchObject({ kind: "ready" });
            if (acceptedCeiling > 0) {
                const updateItems = items.slice(0, acceptedCeiling);
                await expect(execute({
                    v: 1,
                    kind: "batch",
                    claim: updateClaim,
                    expectedRevision: 0,
                    batchId: makeExternalSessionHistoricalImportBatchIdV1(
                        updateItems.map((item) => item.localId),
                    ),
                    items: updateItems,
                })).resolves.toMatchObject({
                    kind: "batch_accepted",
                    acceptedThroughServerSeq: acceptedCeiling,
                });
            }
            const jobWhere = hostSystemRecordUniqueWhere({
                accountId: owner.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${updateClaim.operationId}`,
            });
            const jobBeforeFinalize = await db.sessionSystemRecord.findUniqueOrThrow({
                where: jobWhere,
                select: { content: true, version: true },
            });

            const result = await execute({
                v: 1,
                kind: "finalize",
                claim: updateClaim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: acceptedCeiling,
            });
            expect(result).toMatchObject(expectedKind === "error"
                ? { kind: "error", errorCode: "invalid_state" }
                : {
                    kind: "finalized",
                    acceptedThroughServerSeq: acceptedCeiling,
                    publication: { publishedThroughServerSeq: acceptedCeiling },
                });

            const publication = await db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: publicationSelect,
            });
            const rows = await db.sessionMessage.findMany({
                where: { sessionId: session.id },
                orderBy: { seq: "asc" },
                select: rowSelect,
            });
            if (expectedKind === "error") {
                expect(publication).toEqual(initialPublication);
                expect(rows).toEqual(initialRows);
                await expect(db.sessionSystemRecord.findUniqueOrThrow({
                    where: jobWhere,
                    select: { content: true, version: true },
                })).resolves.toEqual(jobBeforeFinalize);
                const recoveryItems = items.slice(0, 2);
                await expect(execute({
                    v: 1,
                    kind: "batch",
                    claim: updateClaim,
                    expectedRevision: 0,
                    batchId: makeExternalSessionHistoricalImportBatchIdV1(
                        recoveryItems.map((item) => item.localId),
                    ),
                    items: recoveryItems,
                })).resolves.toMatchObject({
                    kind: "batch_accepted",
                    acceptedThroughServerSeq: 2,
                });
                await expect(execute({
                    v: 1,
                    kind: "finalize",
                    claim: updateClaim,
                    expectedRevision: 0,
                    expectedAcceptedThroughServerSeq: 2,
                })).resolves.toMatchObject({
                    kind: "finalized",
                    acceptedThroughServerSeq: 2,
                    publication: { publishedThroughServerSeq: 2 },
                });
            } else {
                expect(publication).toMatchObject({
                    currentStorageState: "snapshot_complete",
                    acceptedThroughServerSeq: null,
                    publishedThroughServerSeq: acceptedCeiling,
                });
            }
            const visiblePublication = await loadSessionTranscriptPublication(db, session.id);
            await expect(db.sessionMessage.findMany({
                where: buildSessionMessagePublicationWhere({
                    where: { sessionId: session.id },
                    publication: visiblePublication,
                }),
                orderBy: { seq: "asc" },
                select: { seq: true },
            })).resolves.toHaveLength(expectedVisibleCount);
        },
        120_000,
    );

    it.each([
        ["same", false],
        ["advanced", true],
    ] as const)(
        "replays a finalized job receipt after a later %s-ceiling publication",
        async (_ceilingKind, advancesCeiling) => {
            const account = await db.account.create({
                data: { publicKey: `c1-materialize-receipt-${randomUUID()}` },
                select: { id: true },
            });
            const session = await db.session.create({
                data: {
                    tag: `c1-materialize-receipt-${randomUUID()}`,
                    accountId: account.id,
                    metadata: "metadata",
                    encryptionMode: "plain",
                    currentStorageState: "machine_only",
                },
                select: { id: true },
            });
            const firstClaim = {
                sessionId: session.id,
                operationId: `materialize-receipt-first-${randomUUID()}`,
                operationClaimId: `materialize-receipt-first-claim-${randomUUID()}`,
            } as const;
            const execute = async (command: unknown) =>
                await executeExternalSessionHistoricalImportCommand({
                    actorUserId: account.id,
                    transportMachineId: "machine-materialize-receipt",
                    command,
                });

            await expect(execute({
                v: 1,
                kind: "begin",
                claim: firstClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            })).resolves.toMatchObject({ kind: "ready" });
            await expect(execute({
                v: 1,
                kind: "batch",
                claim: firstClaim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([
                    "history:receipt-first",
                ]),
                items: [{
                    localId: "history:receipt-first",
                    sidechainId: null,
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", text: "first" } },
                }],
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                acceptedThroughServerSeq: 1,
            });
            const firstFinalized = await execute({
                v: 1,
                kind: "finalize",
                claim: firstClaim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: 1,
            });
            expect(firstFinalized).toMatchObject({
                kind: "finalized",
                claim: firstClaim,
                acceptedThroughServerSeq: 1,
            });
            if (firstFinalized.kind !== "finalized") {
                throw new Error("Expected the first historical import to finalize.");
            }

            const secondClaim = {
                sessionId: session.id,
                operationId: `materialize-receipt-second-${randomUUID()}`,
                operationClaimId: `materialize-receipt-second-claim-${randomUUID()}`,
            } as const;
            await expect(execute({
                v: 1,
                kind: "begin",
                claim: secondClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: {
                    state: "snapshot_complete",
                    publication: firstFinalized.publication,
                },
            })).resolves.toMatchObject({ kind: "ready" });
            await expect(execute({
                v: 1,
                kind: "batch",
                claim: secondClaim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([
                    "history:receipt-first",
                ]),
                items: [{
                    localId: "history:receipt-first",
                    sidechainId: null,
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", text: "first" } },
                }],
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                acceptedThroughServerSeq: 1,
            });
            if (advancesCeiling) {
                await expect(execute({
                    v: 1,
                    kind: "batch",
                    claim: secondClaim,
                    expectedRevision: 0,
                    batchId: makeExternalSessionHistoricalImportBatchIdV1([
                        "history:receipt-second",
                    ]),
                    items: [{
                        localId: "history:receipt-second",
                        sidechainId: null,
                        messageRole: "agent",
                        content: { t: "plain", v: { text: "second" } },
                    }],
                })).resolves.toMatchObject({
                    kind: "batch_accepted",
                    acceptedThroughServerSeq: 2,
                });
            }
            const secondFinalized = await execute({
                v: 1,
                kind: "finalize",
                claim: secondClaim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: advancesCeiling ? 2 : 1,
            });
            expect(secondFinalized).toMatchObject({ kind: "finalized" });
            if (secondFinalized.kind !== "finalized") {
                throw new Error("Expected the second historical import to finalize.");
            }
            expect(secondFinalized.publication.materializationPublicationId)
                .not.toBe(firstFinalized.publication.materializationPublicationId);

            await expect(execute({
                v: 1,
                kind: "finalize",
                claim: firstClaim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: 1,
            })).resolves.toEqual(firstFinalized);
            await expect(execute({
                v: 1,
                kind: "begin",
                claim: firstClaim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            })).resolves.toEqual(firstFinalized);
            await expect(execute({
                v: 1,
                kind: "resume",
                claim: firstClaim,
                expectedRevision: 0,
            })).resolves.toEqual(firstFinalized);
        },
        120_000,
    );

    it("keeps unpublished discard ownership compact across many accepted batches", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-compact-job-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-compact-job-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "compact-job-operation",
            operationClaimId: "compact-job-claim",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-compact-job",
            command,
        });

        await expect(execute({
            v: 1,
            kind: "begin",
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({ kind: "ready" });
        const jobAddress = {
            accountId: account.id,
            sessionId: session.id,
            namespace: "external_sessions",
            localId: `historical-import:${claim.operationId}`,
        } as const;
        const currentRecord = await db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere(jobAddress),
            select: { content: true },
        });
        await db.sessionSystemRecord.update({
            where: hostSystemRecordUniqueWhere(jobAddress),
            data: {
                content: {
                    ...(currentRecord.content as Readonly<Record<string, unknown>>),
                    lastBatchId: "legacy-current-dev-batch",
                    lastBatchContentSha256: "legacy-current-dev-content",
                },
            },
        });
        for (let index = 0; index < 100; index += 1) {
            await expect(execute({
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([`history:${index}`]),
                items: [{
                    localId: `history:${index}`,
                    sidechainId: null,
                    messageRole: index % 2 === 0 ? "user" : "agent",
                    content: { t: "plain", v: { index } },
                }],
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                acceptedThroughServerSeq: index + 1,
            });
        }

        const record = await db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere(jobAddress),
            select: {
                content: true,
                ownerKind: true,
                pluginId: true,
                namespaceAddressKey: true,
                recordAddressKey: true,
                version: true,
            },
        });
        expect(record.content).toMatchObject({
            insertedSequenceSpans: [{ firstSeq: 1, lastSeq: 100 }],
        });
        expect(record.content).not.toHaveProperty("insertedMessageIds");
        expect(record.content).not.toHaveProperty("lastBatchId");
        expect(record.content).not.toHaveProperty("lastBatchContentSha256");
        expect(new TextEncoder().encode(JSON.stringify(record.content)).byteLength).toBeLessThan(1_024);
        expect(record.ownerKind).toBe("host");
        expect(record.pluginId).toBeNull();
        expect(record.version).toBeGreaterThan(1);
        expect(Buffer.from(record.namespaceAddressKey ?? []).toString("hex")).toBe(
            "923c641e9011f00d5b9f88e837139f7e8f70fcc155261e72faf1b4fe2735ee60",
        );
        expect(Buffer.from(record.recordAddressKey ?? []).toString("hex")).toBe(
            "9e6a7df5fa4362a7bc6c60eefb4ca08e07feb6b1f759c54e10c6741b0db3dbb7",
        );
    }, 120_000);

    it("binds every historical batch identity to its ordered stable local ids", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-batch-identity-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-batch-identity-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "batch-identity-operation",
            operationClaimId: "batch-identity-claim",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-batch-identity",
            command,
        });
        await expect(execute({
            v: 1,
            kind: "begin",
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({ kind: "ready" });

        const itemA1 = {
            localId: "history:a1",
            sidechainId: null,
            messageRole: "user" as const,
            content: { t: "plain" as const, v: { text: "a1" } },
        };
        const itemA2 = {
            localId: "history:a2",
            sidechainId: null,
            messageRole: "agent" as const,
            content: { t: "plain" as const, v: { text: "a2" } },
        };
        const batchA = {
            v: 1 as const,
            kind: "batch" as const,
            claim,
            expectedRevision: 0,
            batchId:
                "historical-import-batch:v1:e964cb33899184fd7b084505878464f4983b1c053d1bac0e95a92132766646b6",
            items: [itemA1, itemA2],
        };
        const batchB = {
            ...batchA,
            batchId:
                "historical-import-batch:v1:8cea95ea99e541d44ced96750b9fc47991126c007fd971964c0c7b9708659d53",
            items: [{
                localId: "history:b",
                sidechainId: null,
                messageRole: "user" as const,
                content: { t: "plain" as const, v: { text: "b" } },
            }],
        };
        await expect(execute(batchA)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchA.batchId,
            acceptedThroughServerSeq: 2,
        });
        await expect(execute(batchB)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchB.batchId,
            acceptedThroughServerSeq: 3,
        });
        await expect(execute(batchA)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchA.batchId,
            acceptedThroughServerSeq: 3,
        });
        await expect(execute(batchB)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchB.batchId,
            acceptedThroughServerSeq: 3,
        });
        await expect(execute({
            ...batchA,
            items: [{
                localId: "history:fresh",
                sidechainId: null,
                messageRole: "user" as const,
                content: { t: "plain" as const, v: { text: "mutated a" } },
            }],
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "batch_conflict",
        });
        await expect(execute(batchB)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchB.batchId,
            acceptedThroughServerSeq: 3,
        });
        await expect(execute({
            ...batchA,
            items: [{ ...itemA1, content: { t: "plain", v: { text: "changed" } } }, itemA2],
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "batch_conflict",
        });
        await expect(execute(batchB)).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: batchB.batchId,
            acceptedThroughServerSeq: 3,
        });
        await expect(execute({
            ...batchA,
            items: [itemA2, itemA1],
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "batch_conflict",
        });

        const state = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { seq: true, acceptedThroughServerSeq: true },
        });
        expect(state).toEqual({ seq: 3, acceptedThroughServerSeq: 3 });
        await expect(db.sessionMessage.count({
            where: { sessionId: session.id },
        })).resolves.toBe(3);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: {
                localId: true,
                transcriptObservationProvenance: true,
                inputAdmissionReceipt: true,
            },
        })).resolves.toEqual([
            {
                localId: "history:a1",
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                inputAdmissionReceipt: null,
            },
            {
                localId: "history:a2",
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                inputAdmissionReceipt: null,
            },
            {
                localId: "history:b",
                transcriptObservationProvenance: { kind: "non_dependent", source: "history" },
                inputAdmissionReceipt: null,
            },
        ]);
    }, 120_000);

    it("rejects a batch above its negotiated socket limit before any transcript or job write", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-socket-limit-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-socket-limit-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-socket-limit",
            operationClaimId: "materialize-claim-socket-limit",
        } as const;
        const admittedLimits = { maxItems: 200, maxSerializedBytes: 256 } as const;

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-socket-limit",
            command: {
                v: 1,
                kind: "begin",
                claim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            },
            limits: admittedLimits,
        }))
            .resolves.toMatchObject({ kind: "ready", limits: admittedLimits });

        const sessionBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                publishedThroughServerSeq: true,
            },
        });
        const jobBefore = await db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
            select: { content: true },
        });

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-socket-limit",
            command: {
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([
                    "history:socket-limit",
                ]),
                items: [{
                    localId: "history:socket-limit",
                    sidechainId: null,
                    messageRole: "user",
                    content: {
                        t: "plain",
                        v: { role: "user", text: "x".repeat(1_024) },
                    },
                }],
            },
            limits: admittedLimits,
        }))
            .resolves.toMatchObject({
                kind: "error",
                errorCode: "serialized_bytes_exceeded",
            });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                publishedThroughServerSeq: true,
            },
        })).resolves.toEqual(sessionBefore);
        await expect(db.sessionSystemRecord.findUniqueOrThrow({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
            select: { content: true },
        })).resolves.toEqual(jobBefore);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } }))
            .resolves.toBe(0);
    }, 120_000);

    it("rejects cross-account and cross-machine claim reuse while the bound machine reconnect converges", async () => {
        const owner = await db.account.create({
            data: { publicKey: `c1-claim-owner-${randomUUID()}` },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: `c1-claim-other-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-claim-session-${randomUUID()}`,
                accountId: owner.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-bound-machine",
            operationClaimId: "materialize-claim-bound-machine",
        } as const;
        const begin = {
            v: 1 as const,
            kind: "begin" as const,
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" as const },
        };

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: owner.id,
            transportMachineId: "bound-machine",
            command: begin,
        })).resolves.toMatchObject({
            kind: "ready",
            historicalImportJobId: `historical-import:${claim.operationId}`,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: otherAccount.id,
            transportMachineId: "bound-machine",
            command: begin,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "wrong_session",
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: owner.id,
            transportMachineId: "different-machine",
            command: begin,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "wrong_machine_socket",
        });

        // A reconnected socket reaches this owner with the same authenticated machine identity.
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: owner.id,
            transportMachineId: "bound-machine",
            command: begin,
        })).resolves.toMatchObject({
            kind: "ready",
            historicalImportJobId: `historical-import:${claim.operationId}`,
        });
        await expect(db.sessionSystemRecord.count({
            where: {
                accountId: owner.id,
                sessionId: session.id,
                namespace: "external_sessions",
            },
        })).resolves.toBe(1);
        await expect(db.sessionSystemRecord.count({
            where: { accountId: otherAccount.id },
        })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } }))
            .resolves.toBe(0);
    }, 120_000);

    it("does not repair hosted storage for an unbound non-begin socket command", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-unbound-import-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-unbound-import-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "unbound-operation",
            operationClaimId: "unbound-claim",
        } as const;

        for (const command of [
            { v: 1 as const, kind: "resume" as const, claim, expectedRevision: 0 },
            {
                v: 1 as const,
                kind: "finalize" as const,
                claim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: 0,
            },
        ]) {
            await expect(executeExternalSessionHistoricalImportCommand({
                actorUserId: account.id,
                transportMachineId: "machine-1",
                command,
            })).resolves.toMatchObject({
                kind: "error",
                errorCode: "wrong_operation",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { currentStorageState: true },
            })).resolves.toEqual({ currentStorageState: "hosted" });
        }
    }, 120_000);

    it("imports more than 1,000 historical rows through bounded contiguous batches", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-batched-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-batched-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-batched",
            operationClaimId: "materialize-claim-batched",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command,
        });

        await expect(execute({
            v: 1,
            kind: "begin",
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({
            kind: "ready",
            limits: { maxItems: 200 },
        });

        const items = Array.from({ length: 1_001 }, (_, index) => ({
            localId: `history:batched:${index + 1}`,
            sidechainId: null,
            messageRole: index % 2 === 0 ? ("user" as const) : ("agent" as const),
            content: { t: "plain" as const, v: { text: `historical row ${index + 1}` } },
        }));
        for (let offset = 0; offset < items.length; offset += 200) {
            const batch = items.slice(offset, offset + 200);
            const batchId = makeExternalSessionHistoricalImportBatchIdV1(
                batch.map((item) => item.localId),
            );
            await expect(execute({
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId,
                items: batch,
            })).resolves.toMatchObject({
                kind: "batch_accepted",
                batchId,
                acceptedThroughServerSeq: offset + batch.length,
            });
        }
        await expect(execute({
            v: 1,
            kind: "finalize",
            claim,
            expectedRevision: 0,
            expectedAcceptedThroughServerSeq: items.length,
        })).resolves.toMatchObject({
            kind: "finalized",
            acceptedThroughServerSeq: items.length,
        });

        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true, content: true },
        });
        expect(rows).toHaveLength(items.length);
        expect(rows.map((row) => row.seq)).toEqual(
            Array.from({ length: items.length }, (_, index) => index + 1),
        );
        expect(rows[0]?.localId).toBe("history:batched:1");
        expect(rows[500]).toMatchObject({
            localId: "history:batched:501",
            content: { t: "plain", v: { text: "historical row 501" } },
        });
        expect(rows[1_000]).toMatchObject({
            localId: "history:batched:1001",
            content: { t: "plain", v: { text: "historical row 1001" } },
        });
    }, 120_000);

    it("publishes an empty historical import without manufacturing a transcript row", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-empty-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-empty-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-empty",
            operationClaimId: "materialize-claim-empty",
        } as const;

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "begin",
                claim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-1",
            command: {
                v: 1,
                kind: "finalize",
                claim,
                expectedRevision: 0,
                expectedAcceptedThroughServerSeq: 0,
            },
        })).resolves.toMatchObject({
            kind: "finalized",
            acceptedThroughServerSeq: 0,
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                publishedThroughServerSeq: true,
                seq: true,
            },
        })).resolves.toEqual({
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 0,
            seq: 0,
        });
    }, 120_000);

    it("keeps physically stored legacy-unknown transcript rows unpublished across SQLite readers", async () => {
        const owner = await db.account.create({
            data: {
                publicKey: `c1-legacy-unknown-owner-${randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const viewer = await db.account.create({
            data: {
                publicKey: `c1-legacy-unknown-viewer-${randomUUID()}`,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-legacy-unknown-${randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: STORED_SHARED_METADATA,
                metadataLayoutVersion: 1,
                ownerMetadata: STORED_PLAIN_OWNER_METADATA_ENVELOPE,
                currentStorageState: "legacy_external_unknown",
                seq: 1,
            },
            select: { id: true },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId: "legacy-unknown:private-row",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", text: "must remain unpublished" } },
            },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: viewer.id,
                accessLevel: "view",
            },
        });
        const publicToken = `c1-legacy-unknown-public-${randomUUID()}`;
        await db.publicSessionShare.create({
            data: {
                sessionId: session.id,
                createdByUserId: owner.id,
                tokenHash: createHash("sha256").update(publicToken, "utf8").digest(),
                encryptedDataKey: null,
                isConsentRequired: false,
            },
        });

        await withAuthenticatedTestApp(
            (app) => {
                sessionRoutes(app as never);
                publicShareRoutes(app as never);
            },
            async (app) => {
                const ownerMessages = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${session.id}/messages?scope=all&limit=500`,
                    headers: { "x-test-user-id": owner.id },
                });
                expect(ownerMessages.statusCode).toBe(200);
                expect(ownerMessages.json().messages).toEqual([]);

                const ownerByLocalId = await app.inject({
                    method: "GET",
                    url: `/v2/sessions/${session.id}/messages/by-local-id/${
                        encodeURIComponent("legacy-unknown:private-row")
                    }`,
                    headers: { "x-test-user-id": owner.id },
                });
                expect(ownerByLocalId.statusCode).toBe(404);

                await expect(loadUsageMessageStatsForQuery(
                    owner.id,
                    UsageAnalyticsQueryRequestSchema.parse({}),
                    [session.id],
                )).resolves.toEqual({ messageCount: 0 });

                const viewerSessions = await app.inject({
                    method: "GET",
                    url: "/v1/sessions",
                    headers: {
                        "x-test-user-id": viewer.id,
                        ...CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                    },
                });
                expect(viewerSessions.statusCode).toBe(200);
                expect(
                    (viewerSessions.json().sessions as Array<{ id: string }>).some(
                        (candidate) => candidate.id === session.id,
                    ),
                ).toBe(false);

                const publicRead = await app.inject({
                    method: "GET",
                    url: `/v1/public-share/${encodeURIComponent(publicToken)}`,
                    headers: CURRENT_ACCOUNT_STORED_CONTENT_HEADERS,
                });
                expect(publicRead.statusCode).toBe(404);
                expect(publicRead.json()).toMatchObject({ code: "session_transcript_unavailable" });
            },
        );

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { seq: true, localId: true },
        })).resolves.toEqual([{
            seq: 1,
            localId: "legacy-unknown:private-row",
        }]);
    }, 120_000);

    it("discards only exact job rows and keeps every surviving stored tail unpublished", async () => {
        const account = await db.account.create({
            data: { publicKey: `c1-materialize-discard-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c1-materialize-discard-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                encryptionMode: "plain",
                currentStorageState: "machine_only",
            },
            select: { id: true },
        });
        const claim = {
            sessionId: session.id,
            operationId: "materialize-operation-discard",
            operationClaimId: "materialize-claim-discard",
        } as const;

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-discard",
            command: {
                v: 1,
                kind: "begin",
                claim,
                expectedRevision: 0,
                expectedPriorStableStorage: { state: "machine_only" },
            },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-discard",
            command: {
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([
                    "history:discard-owned",
                ]),
                items: [{
                    localId: "history:discard-owned",
                    sidechainId: null,
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", text: "discard me" } },
                }],
            },
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            acceptedThroughServerSeq: 1,
        });

        await inTx(async (tx) => {
            const next = await tx.session.update({
                where: { id: session.id },
                data: { seq: { increment: 1 } },
                select: { seq: true },
            });
            await tx.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: next.seq,
                    localId: "other-operation:keep",
                    sidechainId: null,
                    messageRole: "event",
                    content: { t: "plain", v: { role: "agent", text: "keep me" } },
                },
            });
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-discard",
            command: {
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1([
                    "history:discard-owned-after-gap",
                ]),
                items: [{
                    localId: "history:discard-owned-after-gap",
                    sidechainId: null,
                    messageRole: "agent",
                    content: { t: "plain", v: { role: "agent", text: "discard me too" } },
                }],
            },
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            acceptedThroughServerSeq: 3,
        });

        await expect(writeHistoricalSessionMessageBatch({
            sessionId: session.id,
            storagePolicy: "optional",
            items: [{
                localId: "other-operation:unacknowledged-tail",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { role: "agent", text: "keep hidden" } },
            }],
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            firstSeq: 4,
            lastSeq: 4,
        });

        await withAuthenticatedTestApp(
            (app) => sessionRoutes(app as never),
            async (app) => {
                const readMessages = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/v1/sessions/${session.id}/messages?scope=all&limit=500`,
                        headers: { "x-test-user-id": account.id },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().messages as Array<{ seq: number; localId: string }>;
                };
                const readTailByLocalId = async () => await app.inject({
                    method: "GET",
                    url: `/v2/sessions/${session.id}/messages/by-local-id/${
                        encodeURIComponent("other-operation:unacknowledged-tail")
                    }`,
                    headers: { "x-test-user-id": account.id },
                });

                await expect(readMessages()).resolves.toEqual([
                    expect.objectContaining({ seq: 3, localId: "history:discard-owned-after-gap" }),
                    expect.objectContaining({ seq: 2, localId: "other-operation:keep" }),
                    expect.objectContaining({ seq: 1, localId: "history:discard-owned" }),
                ]);
                expect((await readTailByLocalId()).statusCode).toBe(404);
                await expect(loadUsageMessageStatsForQuery(
                    account.id,
                    UsageAnalyticsQueryRequestSchema.parse({}),
                    [session.id],
                )).resolves.toEqual({ messageCount: 3 });

                await expect(executeExternalSessionHistoricalImportCommand({
                    actorUserId: account.id,
                    transportMachineId: "machine-discard",
                    // The daemon record advances once when it becomes awaiting-user-resume.
                    command: { v: 1, kind: "discard", claim, expectedRevision: 1 },
                })).resolves.toMatchObject({
                    kind: "discarded",
                    claim,
                    revision: 1,
                });

                await expect(readMessages()).resolves.toEqual([]);
                expect((await readTailByLocalId()).statusCode).toBe(404);
                await expect(loadUsageMessageStatsForQuery(
                    account.id,
                    UsageAnalyticsQueryRequestSchema.parse({}),
                    [session.id],
                )).resolves.toEqual({ messageCount: 0 });
            },
        );

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true },
        })).resolves.toEqual([
            { seq: 2, localId: "other-operation:keep" },
            { seq: 4, localId: "other-operation:unacknowledged-tail" },
        ]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                publishedThroughServerSeq: true,
            },
        })).resolves.toEqual({
            seq: 4,
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            publishedThroughServerSeq: null,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-discard",
            command: { v: 1, kind: "discard", claim, expectedRevision: 1 },
        })).resolves.toMatchObject({
            kind: "discarded",
            claim,
            revision: 1,
        });
        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-discard",
            command: { v: 1, kind: "resume", claim, expectedRevision: 3 },
        })).resolves.toMatchObject({
            kind: "discarded",
            claim,
            revision: 3,
        });
        await expect(db.sessionSystemRecord.findUnique({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
        })).resolves.toMatchObject({
            content: expect.objectContaining({
                state: "discarded",
                revision: 3,
                insertedSequenceSpans: [],
            }),
        });
    }, 120_000);

    it("reconciles an external-linked takeover without retaining stale admission attempts", async () => {
        const sharedMetadata = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: {} }),
        );
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const machineId = `machine-external-linked-takeover-${randomUUID()}`;
        const fence = new Date(1_234);
        await db.machine.create({
            data: { id: machineId, accountId: account.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                tag: `external-linked-takeover-${randomUUID()}`,
                accountId: account.id,
                metadata: sharedMetadata,
                metadataVersion: 7,
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE),
                agentState: null,
                agentStateVersion: 0,
                encryptionMode: "plain",
                currentStorageState: "machine_only",
                pendingVersion: 4,
                pendingCount: 2,
                pendingBlockedCount: 1,
                active: true,
                thinking: false,
                lastActiveAt: fence,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const claim = {
            sessionId: session.id,
            operationId: "external-linked-takeover-operation",
            operationClaimId: "external-linked-takeover-claim",
        } as const;
        const command = {
            v: 1,
            kind: "admit_persisted_takeover",
            mode: "external_linked",
            claim,
            expectedRevision: 9,
            attemptId: "attempt-1",
            publisherPrecondition: {
                machineId,
                committedFenceMs: fence.getTime(),
            },
            expectedSessionMetadataVersion: 7,
            expectedSessionSeq: 0,
            expectedPending: {
                version: 4,
                count: 2,
                blockedCount: 1,
            },
            expectedPriorStableStorage: { state: "machine_only" },
        } as const;
        const execute = async (candidate: unknown) =>
            await executeExternalSessionHistoricalImportCommand({
                actorUserId: account.id,
                transportMachineId: machineId,
                command: candidate,
            });

        await expect(execute(command)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "external_linked",
            claim,
            revision: 9,
            attemptId: "attempt-1",
        });
        await expect(execute(command)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "external_linked",
            claim,
            revision: 9,
            attemptId: "attempt-1",
        });
        await expect(execute({
            ...command,
            publisherPrecondition: {
                ...command.publisherPrecondition,
                committedFenceMs: fence.getTime() + 1,
            },
        })).resolves.toMatchObject({ kind: "error", errorCode: "invalid_state" });

        const reclaimedFence = new Date(fence.getTime() + 10);
        await db.session.update({
            where: { id: session.id },
            data: { lastActiveAt: reclaimedFence },
        });
        const reclaimed = {
            ...command,
            claim: {
                ...claim,
                operationClaimId: "external-linked-takeover-reclaimed-claim",
            },
            expectedRevision: 10,
            publisherPrecondition: {
                machineId,
                committedFenceMs: reclaimedFence.getTime(),
            },
        } as const;
        await expect(execute(reclaimed)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "external_linked",
            claim: reclaimed.claim,
            revision: 10,
            attemptId: "attempt-1",
        });

        const retryFence = new Date(reclaimedFence.getTime() + 10);
        await db.session.update({
            where: { id: session.id },
            data: { lastActiveAt: retryFence },
        });
        const freshRetry = {
            ...reclaimed,
            claim: {
                ...reclaimed.claim,
                operationClaimId: "external-linked-takeover-retry-claim",
            },
            expectedRevision: 11,
            attemptId: "attempt-2",
            publisherPrecondition: {
                machineId,
                committedFenceMs: retryFence.getTime(),
            },
        } as const;
        await expect(execute(freshRetry)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "external_linked",
            claim: freshRetry.claim,
            revision: 11,
            attemptId: "attempt-2",
        });

        const lateOldFence = new Date(retryFence.getTime() + 10);
        await db.session.update({
            where: { id: session.id },
            data: { lastActiveAt: lateOldFence },
        });
        await expect(execute({
            ...reclaimed,
            claim: {
                ...reclaimed.claim,
                operationClaimId: "external-linked-takeover-late-old-claim",
            },
            expectedRevision: reclaimed.expectedRevision,
            publisherPrecondition: {
                machineId,
                committedFenceMs: lateOldFence.getTime(),
            },
        })).resolves.toMatchObject({ kind: "error", errorCode: "invalid_state" });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataVersion: true,
                metadata: true,
                ownerMetadata: true,
                agentStateVersion: true,
                agentState: true,
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                pendingVersion: true,
                pendingCount: true,
                pendingBlockedCount: true,
                active: true,
                thinking: true,
                lastActiveAt: true,
            },
        })).resolves.toEqual({
            metadataVersion: 7,
            metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE),
            agentStateVersion: 0,
            agentState: null,
            seq: 0,
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            pendingVersion: 4,
            pendingCount: 2,
            pendingBlockedCount: 1,
            active: true,
            thinking: false,
            lastActiveAt: lateOldFence,
        });
        await expect(db.sessionSystemRecord.findUnique({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${claim.operationId}`,
            }),
        })).resolves.toBeNull();
        await expect(db.sessionSystemRecord.findUnique({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `takeover-admission:${claim.operationId}`,
            }),
        })).resolves.toMatchObject({
            kind: "takeover_admission",
            content: expect.objectContaining({
                attemptId: "attempt-2",
                operationRevision: 11,
            }),
        });
    }, 120_000);

    it("admits persisted takeover exactly once from the finalized publication without changing Pending or runtime state", async () => {
        const sharedMetadata = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: {} }),
        );
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c2-takeover-admission-${randomUUID()}`,
                accountId: account.id,
                metadata: sharedMetadata,
                metadataVersion: 7,
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE),
                agentState: null,
                agentStateVersion: 0,
                encryptionMode: "plain",
                currentStorageState: "machine_only",
                pendingVersion: 4,
                pendingCount: 2,
                pendingBlockedCount: 1,
                active: false,
                thinking: false,
            },
            select: { id: true },
        });
        const machineId = `machine-persisted-takeover-${randomUUID()}`;
        const publisherFence = new Date(4_321);
        await db.machine.create({
            data: { id: machineId, accountId: account.id, metadata: "{}" },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const claim = {
            sessionId: session.id,
            operationId: "persisted-takeover-operation",
            operationClaimId: "persisted-takeover-claim",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: machineId,
            command,
        });

        await expect(execute({
            v: 1,
            kind: "begin",
            claim,
            expectedRevision: 9,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(execute({
            v: 1,
            kind: "batch",
            claim,
            expectedRevision: 9,
            batchId: makeExternalSessionHistoricalImportBatchIdV1(["history:takeover"]),
            items: [{
                localId: "history:takeover",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { text: "historical row" } },
            }],
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            acceptedThroughServerSeq: 1,
        });
        await expect(execute({
            v: 1,
            kind: "finalize",
            claim,
            expectedRevision: 9,
            expectedAcceptedThroughServerSeq: 1,
        })).resolves.toMatchObject({ kind: "finalized" });

        await db.session.update({
            where: { id: session.id },
            data: { active: true, lastActiveAt: publisherFence },
        });

        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataVersion: true,
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                pendingVersion: true,
                pendingCount: true,
                pendingBlockedCount: true,
                active: true,
                thinking: true,
            },
        });
        expect(before).toMatchObject({
            metadataVersion: 7,
            seq: 1,
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 1,
            pendingVersion: 4,
            pendingCount: 2,
            pendingBlockedCount: 1,
            active: true,
            thinking: false,
        });
        expect(before.materializationPublicationId).toEqual(expect.any(String));
        expect(before.materializedThroughSourceAt).not.toBeNull();

        const command = {
            v: 1,
            kind: "admit_persisted_takeover",
            mode: "persisted",
            claim,
            expectedRevision: 9,
            attemptId: "attempt-1",
            publisherPrecondition: {
                machineId,
                committedFenceMs: publisherFence.getTime(),
            },
            expectedSessionMetadataVersion: 7,
            metadataPatch: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
                sharedMetadata: {
                    ciphertext: sharedMetadata,
                    expectedVersion: 7,
                },
                ownerMetadata: RETIRED_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
                agentState: {
                    ciphertext: null,
                    expectedVersion: 0,
                },
            },
            expectedSessionSeq: 1,
            expectedPending: {
                version: 4,
                count: 2,
                blockedCount: 1,
            },
            expectedPublication: {
                materializationPublicationId: before.materializationPublicationId,
                materializedThroughSourceAt: Number(before.materializedThroughSourceAt),
                publishedThroughServerSeq: 1,
            },
        } as const;

        for (const staleCommand of [
            { ...command, expectedRevision: 8 },
            { ...command, expectedSessionMetadataVersion: 8 },
            {
                ...command,
                metadataPatch: {
                    ...command.metadataPatch,
                    expectedOwnerMetadata: RETIRED_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
                },
            },
            { ...command, expectedSessionSeq: 2 },
            { ...command, expectedPending: { ...command.expectedPending, version: 5 } },
            {
                ...command,
                expectedPublication: {
                    ...command.expectedPublication,
                    materializationPublicationId: "wrong-publication",
                },
            },
        ]) {
            await expect(execute(staleCommand)).resolves.toMatchObject({ kind: "error" });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: {
                    metadataVersion: true,
                    seq: true,
                    currentStorageState: true,
                    acceptedThroughServerSeq: true,
                    materializationPublicationId: true,
                    materializedThroughSourceAt: true,
                    publishedThroughServerSeq: true,
                    pendingVersion: true,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    active: true,
                    thinking: true,
                },
            })).resolves.toEqual(before);
        }

        await expect(execute(command)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "persisted",
            claim,
            revision: 9,
            attemptId: "attempt-1",
        });
        await expect(execute(command)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "persisted",
            claim,
            revision: 9,
            attemptId: "attempt-1",
        });
        await expect(execute({
            ...command,
            expectedRevision: 11,
        })).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "persisted",
            claim,
            revision: 11,
            attemptId: "attempt-1",
        });
        await expect(execute(command)).resolves.toMatchObject({
            kind: "error",
            errorCode: "stale_revision",
        });
        await expect(execute({
            ...command,
            expectedRevision: 11,
            attemptId: "attempt-2",
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "invalid_state",
        });
        await expect(execute({
            ...command,
            expectedRevision: 11,
            metadataPatch: {
                ...command.metadataPatch,
                ownerMetadata: LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
            },
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "invalid_state",
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                metadataVersion: true,
                metadataLayoutVersion: true,
                metadata: true,
                ownerMetadata: true,
                agentStateVersion: true,
                agentState: true,
                seq: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
                pendingVersion: true,
                pendingCount: true,
                pendingBlockedCount: true,
                active: true,
                thinking: true,
            },
        })).resolves.toEqual({
            metadataVersion: 8,
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(RETIRED_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE),
            agentStateVersion: 1,
            agentState: null,
            seq: 1,
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            pendingVersion: 4,
            pendingCount: 2,
            pendingBlockedCount: 1,
            active: true,
            thinking: false,
        });
    }, 120_000);

    it("admits a resumed persisted takeover under its successor operation claim and fences the released one", async () => {
        const sharedMetadata = JSON.stringify(
            projectSessionSharedMetadataV1({ metadata: {} }),
        );
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `takeover-claim-succession-${randomUUID()}`,
                accountId: account.id,
                metadata: sharedMetadata,
                metadataVersion: 7,
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE),
                agentState: null,
                agentStateVersion: 0,
                encryptionMode: "plain",
                currentStorageState: "machine_only",
                pendingVersion: 4,
                pendingCount: 2,
                pendingBlockedCount: 1,
                active: false,
                thinking: false,
            },
            select: { id: true },
        });
        const machineId = `machine-claim-succession-${randomUUID()}`;
        const publisherFence = new Date(7_654);
        await db.machine.create({
            data: { id: machineId, accountId: account.id, metadata: "{}" },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const operationId = "takeover-claim-succession-operation";
        // Materialization holds one local exclusion claim for begin/batch/finalize
        // and releases it when the operation parks at `awaiting_user_resume`.
        const materializationClaim = {
            sessionId: session.id,
            operationId,
            operationClaimId: "materialization-claim-a",
        } as const;
        // Resume acquires a fresh exclusion claim and binds it into the daemon
        // operation record at `revision + 1`, so admission sends this one.
        const resumeClaim = {
            sessionId: session.id,
            operationId,
            operationClaimId: "resume-claim-b",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: machineId,
            command,
        });

        await expect(execute({
            v: 1,
            kind: "begin",
            claim: materializationClaim,
            expectedRevision: 9,
            expectedPriorStableStorage: { state: "machine_only" },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(execute({
            v: 1,
            kind: "batch",
            claim: materializationClaim,
            expectedRevision: 9,
            batchId: makeExternalSessionHistoricalImportBatchIdV1([
                "history:claim-succession",
            ]),
            items: [{
                localId: "history:claim-succession",
                sidechainId: null,
                messageRole: "user",
                content: { t: "plain", v: { text: "historical row" } },
            }],
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            acceptedThroughServerSeq: 1,
        });
        await expect(execute({
            v: 1,
            kind: "finalize",
            claim: materializationClaim,
            expectedRevision: 9,
            expectedAcceptedThroughServerSeq: 1,
        })).resolves.toMatchObject({ kind: "finalized" });

        await db.session.update({
            where: { id: session.id },
            data: { active: true, lastActiveAt: publisherFence },
        });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
            },
        });

        const admission = {
            v: 1,
            kind: "admit_persisted_takeover",
            mode: "persisted",
            claim: resumeClaim,
            // Resume commits the successor claim at revision 11 and the admission
            // owner commits refreshed authority evidence at revision 12.
            expectedRevision: 12,
            attemptId: "attempt-1",
            publisherPrecondition: {
                machineId,
                committedFenceMs: publisherFence.getTime(),
            },
            expectedSessionMetadataVersion: 7,
            metadataPatch: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: LIVE_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
                sharedMetadata: {
                    ciphertext: sharedMetadata,
                    expectedVersion: 7,
                },
                ownerMetadata: RETIRED_EXTERNAL_LINK_OWNER_METADATA_ENVELOPE,
                agentState: {
                    ciphertext: null,
                    expectedVersion: 0,
                },
            },
            expectedSessionSeq: 1,
            expectedPending: {
                version: 4,
                count: 2,
                blockedCount: 1,
            },
            expectedPublication: {
                materializationPublicationId: before.materializationPublicationId,
                materializedThroughSourceAt: Number(before.materializedThroughSourceAt),
                publishedThroughServerSeq: 1,
            },
        } as const;

        await expect(execute(admission)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
            mode: "persisted",
            claim: resumeClaim,
            revision: 12,
            attemptId: "attempt-1",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { currentStorageState: true, metadataVersion: true },
        })).resolves.toEqual({ currentStorageState: "hosted", metadataVersion: 8 });

        // The released claim is stale the moment the successor becomes
        // authoritative: it is refused at the revision the successor bound, so
        // the refusal cannot come from the revision fence alone.
        await expect(execute({
            ...admission,
            claim: materializationClaim,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "wrong_operation_claim",
        });
        await expect(execute({
            v: 1,
            kind: "resume",
            claim: materializationClaim,
            expectedRevision: 12,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "wrong_operation_claim",
        });
        await expect(db.sessionSystemRecord.findUnique({
            where: hostSystemRecordUniqueWhere({
                accountId: account.id,
                sessionId: session.id,
                namespace: "external_sessions",
                localId: `historical-import:${operationId}`,
            }),
        })).resolves.toMatchObject({
            content: expect.objectContaining({
                claim: resumeClaim,
                revision: 12,
                state: "finalized",
            }),
        });
    }, 120_000);
});
