import { createHash, randomUUID } from "node:crypto";

import {
    makeExternalSessionHistoricalImportBatchIdV1,
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
import { loadUsageMessageStatsForQuery } from "@/app/usage/query/loadUsageMessageStatsForQuery";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionRoutes } from "@/app/api/routes/session/sessionRoutes";
import { publicShareRoutes } from "@/app/api/routes/share/publicShareRoutes";

const defaultHistoricalImportSocketLimits = {
    maxItems: 200,
    maxSerializedBytes: 512 * 1024,
} as const;
const LIVE_EXTERNAL_LINK_OWNER_METADATA =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";
const RETIRED_EXTERNAL_LINK_OWNER_METADATA =
    "oQohIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzh5AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGA==";

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
                metadata: JSON.stringify({ index }),
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
                        headers: { "x-test-user-id": viewer.id },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().sessions as Array<{ id: string; updatedAt: number }>;
                };
                const readV2Detail = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/v2/sessions/${sessionIds[targetIndex]}`,
                        headers: { "x-test-user-id": viewer.id },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().session as { updatedAt: number };
                };
                const readV2List = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: "/v2/sessions?limit=200",
                        headers: { "x-test-user-id": viewer.id },
                    });
                    expect(response.statusCode).toBe(200);
                    return response.json().sessions as Array<{ id: string; updatedAt: number }>;
                };
                const readPublic = async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/v1/public-share/${encodeURIComponent(publicToken)}`,
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
                expect(publishedV2List.map((session) => session.id)).toEqual(sessionIds);
                expect(publishedV2List[targetIndex]).toMatchObject({
                    id: sessionIds[targetIndex],
                    updatedAt: publishedAt,
                });
                await expect(readPublic()).resolves.toMatchObject({ updatedAt: publishedAt });
            },
        );
    }, 120_000);

    it("keeps historical, Pending, and ordinary writes gapless, transactional, and idempotent", async () => {
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
            sidechainId: null,
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
        expect(retry).toMatchObject({ ok: true, didWrite: false, firstSeq: 1, lastSeq: 1 });

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
            select: { seq: true, localId: true },
        });
        expect(stored).toEqual([
            { seq: 1, localId: "history:item-1" },
            { seq: 2, localId: "pending:item-1" },
            { seq: 3, localId: "ordinary:item-1" },
        ]);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } }))
            .toEqual({ seq: 3 });
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
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "external_sessions",
                    localId: `historical-import:${claim.operationId}`,
                },
            },
            select: { content: true },
        });
        expect(jobAfterInspect.content).toMatchObject({ revision: 0 });
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
        const jobKey = {
            accountId: account.id,
            sessionId: session.id,
            namespace: "external_sessions",
            localId: `historical-import:${claim.operationId}`,
        } as const;
        const legacyRecord = await db.sessionSystemRecord.findUniqueOrThrow({
            where: { accountId_sessionId_namespace_localId: jobKey },
            select: { content: true },
        });
        await db.sessionSystemRecord.update({
            where: { accountId_sessionId_namespace_localId: jobKey },
            data: {
                content: {
                    ...(legacyRecord.content as Readonly<Record<string, unknown>>),
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
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "external_sessions",
                    localId: `historical-import:${claim.operationId}`,
                },
            },
            select: { content: true },
        });
        expect(record.content).toMatchObject({
            insertedSequenceSpans: [{ firstSeq: 1, lastSeq: 100 }],
        });
        expect(record.content).not.toHaveProperty("insertedMessageIds");
        expect(record.content).not.toHaveProperty("lastBatchId");
        expect(record.content).not.toHaveProperty("lastBatchContentSha256");
        expect(new TextEncoder().encode(JSON.stringify(record.content)).byteLength).toBeLessThan(1_024);
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
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "external_sessions",
                    localId: `historical-import:${claim.operationId}`,
                },
            },
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
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "external_sessions",
                    localId: `historical-import:${claim.operationId}`,
                },
            },
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

    it("imports more than 200 historical rows through bounded contiguous batches", async () => {
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

        const firstBatchItems = Array.from({ length: 200 }, (_, index) => ({
            localId: `history:batched:${index + 1}`,
            sidechainId: null,
            messageRole: "user" as const,
            content: { t: "plain" as const, v: { text: `historical row ${index + 1}` } },
        }));
        await expect(execute({
            v: 1,
            kind: "batch",
            claim,
            expectedRevision: 0,
            batchId: makeExternalSessionHistoricalImportBatchIdV1(
                firstBatchItems.map((item) => item.localId),
            ),
            items: firstBatchItems,
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: makeExternalSessionHistoricalImportBatchIdV1(
                firstBatchItems.map((item) => item.localId),
            ),
            acceptedThroughServerSeq: 200,
        });
        await expect(execute({
            v: 1,
            kind: "batch",
            claim,
            expectedRevision: 0,
            batchId: makeExternalSessionHistoricalImportBatchIdV1([
                "history:batched:201",
            ]),
            items: [{
                localId: "history:batched:201",
                sidechainId: null,
                messageRole: "agent",
                content: { t: "plain", v: { text: "historical row 201" } },
            }],
        })).resolves.toMatchObject({
            kind: "batch_accepted",
            batchId: makeExternalSessionHistoricalImportBatchIdV1([
                "history:batched:201",
            ]),
            acceptedThroughServerSeq: 201,
        });
        await expect(execute({
            v: 1,
            kind: "finalize",
            claim,
            expectedRevision: 0,
            expectedAcceptedThroughServerSeq: 201,
        })).resolves.toMatchObject({
            kind: "finalized",
            acceptedThroughServerSeq: 201,
        });

        const rows = await db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { seq: true, localId: true },
        });
        expect(rows).toHaveLength(201);
        expect(rows.map((row) => row.seq)).toEqual(
            Array.from({ length: 201 }, (_, index) => index + 1),
        );
        expect(rows[0]?.localId).toBe("history:batched:1");
        expect(rows[200]?.localId).toBe("history:batched:201");
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
            where: {
                accountId_sessionId_namespace_localId: {
                    accountId: account.id,
                    sessionId: session.id,
                    namespace: "external_sessions",
                    localId: `historical-import:${claim.operationId}`,
                },
            },
        })).resolves.toMatchObject({
            content: expect.objectContaining({
                state: "discarded",
                revision: 3,
                insertedSequenceSpans: [],
            }),
        });
    }, 120_000);

    it("admits persisted takeover exactly once from the finalized publication without changing Pending or runtime state", async () => {
        const account = await db.account.create({
            data: { publicKey: `c2-takeover-admission-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `c2-takeover-admission-${randomUUID()}`,
                accountId: account.id,
                metadata: "metadata",
                metadataVersion: 7,
                metadataLayoutVersion: 1,
                ownerMetadata: LIVE_EXTERNAL_LINK_OWNER_METADATA,
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
        const claim = {
            sessionId: session.id,
            operationId: "persisted-takeover-operation",
            operationClaimId: "persisted-takeover-claim",
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: account.id,
            transportMachineId: "machine-persisted-takeover",
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
            active: false,
            thinking: false,
        });
        expect(before.materializationPublicationId).toEqual(expect.any(String));
        expect(before.materializedThroughSourceAt).not.toBeNull();

        const command = {
            v: 1,
            kind: "admit_persisted_takeover",
            claim,
            expectedRevision: 9,
            attemptId: "attempt-1",
            expectedSessionMetadataVersion: 7,
            metadataPatch: {
                mode: "owner",
                metadataLayoutVersion: 1,
                expectedOwnerMetadataCiphertext:
                    LIVE_EXTERNAL_LINK_OWNER_METADATA,
                sharedMetadata: {
                    ciphertext: "metadata",
                    expectedVersion: 7,
                },
                ownerMetadata: {
                    ciphertext: RETIRED_EXTERNAL_LINK_OWNER_METADATA,
                },
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
                    expectedOwnerMetadataCiphertext:
                        RETIRED_EXTERNAL_LINK_OWNER_METADATA,
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
            claim,
            revision: 9,
            attemptId: "attempt-1",
        });
        await expect(execute(command)).resolves.toEqual({
            v: 1,
            kind: "takeover_admitted",
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
                ownerMetadata: {
                    ciphertext: LIVE_EXTERNAL_LINK_OWNER_METADATA,
                },
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
            metadata: "metadata",
            ownerMetadata: RETIRED_EXTERNAL_LINK_OWNER_METADATA,
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
            active: false,
            thinking: false,
        });
    }, 120_000);
});
