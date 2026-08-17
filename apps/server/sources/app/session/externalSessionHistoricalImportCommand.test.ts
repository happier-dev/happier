import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeExternalSessionHistoricalImportBatchIdV1 } from "@happier-dev/protocol";
import type { Tx } from "@/storage/inTx";

const inTx = vi.hoisted(() => vi.fn());

vi.mock("@/storage/inTx", () => ({ inTx }));

import { executeExternalSessionHistoricalImportCommand } from "./externalSessionHistoricalImportCommand";
import { deriveSessionSystemRecordAddressKeys } from "./systemRecords/sessionSystemRecordAddressKeys";

const claim = {
    sessionId: "session-race",
    operationId: "operation-race",
    operationClaimId: "claim-race",
} as const;
const command = {
    v: 1 as const,
    kind: "begin" as const,
    claim,
    expectedRevision: 0,
    expectedPriorStableStorage: { state: "machine_only" as const },
};
const limits = { maxItems: 200, maxSerializedBytes: 512 * 1024 } as const;
const session = {
    id: claim.sessionId,
    metadataVersion: 0,
    currentStorageState: "machine_only",
    seq: 0,
    acceptedThroughServerSeq: null,
    materializationPublicationId: null,
    materializedThroughSourceAt: null,
    publishedThroughServerSeq: null,
    pendingVersion: 0,
    pendingCount: 0,
    pendingBlockedCount: 0,
    active: false,
    thinking: false,
} as const;
const addressKeys = deriveSessionSystemRecordAddressKeys({
    ownerKind: "host",
    pluginId: null,
    namespace: "external_sessions",
    localId: `historical-import:${claim.operationId}`,
});

function storedWinner() {
    const now = new Date("2026-08-05T00:00:00.000Z");
    return {
        id: "record-winner",
        accountId: "account-race",
        sessionId: claim.sessionId,
        namespace: "external_sessions",
        kind: "historical_import",
        localId: `historical-import:${claim.operationId}`,
        content: {
            v: 1,
            machineId: "machine-race",
            claim,
            revision: 0,
            priorStorageState: "machine_only",
            acceptedThroughServerSeq: null,
            insertedSequenceSpans: [],
            state: "importing",
            admission: null,
        },
        ownerKind: "host",
        pluginId: null,
        namespaceAddressKey: addressKeys.namespaceAddressKey,
        recordAddressKey: addressKeys.recordAddressKey,
        version: 1,
        createdAt: now,
        updatedAt: now,
    };
}

function createTx(params: Readonly<{ findResults: readonly unknown[] }>) {
    const sessionSystemRecordFindFirst = vi.fn();
    for (const result of params.findResults) {
        sessionSystemRecordFindFirst.mockResolvedValueOnce(result);
    }
    const sessionSystemRecordCreate = vi.fn().mockRejectedValue(
        Object.assign(new Error("duplicate historical job"), { code: "P2002" }),
    );
    const tx = {
        session: { findFirst: vi.fn().mockResolvedValue(session) },
        sessionSystemRecord: {
            findFirst: sessionSystemRecordFindFirst,
            create: sessionSystemRecordCreate,
            update: vi.fn(),
        },
    } as unknown as Tx;
    return { tx, sessionSystemRecordCreate };
}

describe("external Session historical import create-race settlement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("rejects source timestamps beyond the JavaScript Date ceiling before a transaction", async () => {
        const localId = "history:invalid-source-timestamp";
        const invalidTimestampMs = 8_640_000_000_000_001;
        inTx.mockReset();

        for (const item of [
            {
                localId,
                sidechainId: null,
                messageRole: "agent" as const,
                content: { t: "plain" as const, v: { text: "historical" } },
                sourceCreatedAtMs: invalidTimestampMs,
            },
            {
                localId,
                sidechainId: null,
                messageRole: "agent" as const,
                content: { t: "plain" as const, v: { text: "historical" } },
                sourceUpdatedAtMs: invalidTimestampMs,
            },
        ]) {
            await expect(executeExternalSessionHistoricalImportCommand({
                actorUserId: "account-race",
                transportMachineId: "machine-race",
                command: {
                    v: 1,
                    kind: "batch",
                    claim,
                    expectedRevision: 0,
                    batchId: makeExternalSessionHistoricalImportBatchIdV1([localId]),
                    items: [item],
                },
                limits,
            })).resolves.toMatchObject({
                kind: "error",
                errorCode: "invalid_state",
            });
            expect(inTx).not.toHaveBeenCalled();
        }
    });

    it("retries the whole transaction once and adopts the exact winning job", async () => {
        const first = createTx({ findResults: [null, null] });
        const second = createTx({ findResults: [storedWinner()] });
        inTx
            .mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => await operation(first.tx))
            .mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => await operation(second.tx));

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: "account-race",
            transportMachineId: "machine-race",
            command,
            limits,
        })).resolves.toMatchObject({
            kind: "ready",
            claim,
            revision: 0,
        });
        expect(inTx).toHaveBeenCalledTimes(2);
        expect(first.sessionSystemRecordCreate).toHaveBeenCalledTimes(1);
        expect(second.sessionSystemRecordCreate).not.toHaveBeenCalled();
    });

    it("bounds a second create race to two complete transaction attempts", async () => {
        const first = createTx({ findResults: [null, null] });
        const second = createTx({ findResults: [null, null] });
        inTx
            .mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => await operation(first.tx))
            .mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => await operation(second.tx));

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: "account-race",
            transportMachineId: "machine-race",
            command,
            limits,
        })).rejects.toThrow("Historical import job creation raced another command.");
        expect(inTx).toHaveBeenCalledTimes(2);
        expect(first.sessionSystemRecordCreate).toHaveBeenCalledTimes(1);
        expect(second.sessionSystemRecordCreate).toHaveBeenCalledTimes(1);
    });

    it("returns a typed conflict when the batch storage transition loses its expected-state fence", async () => {
        const storedMessage = {
            id: "message-race",
            localId: "history:race",
            sidechainId: null,
            messageRole: "agent",
            content: {
                t: "plain",
                v: { role: "agent", content: { type: "text", text: "historical" } },
            },
            seq: 1,
            createdAt: new Date("2026-08-05T00:00:00.000Z"),
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            transcriptObservationProvenance: {
                kind: "non_dependent",
                source: "history",
            },
            deliveryResolution: null,
            inputAdmissionReceipt: null,
            requestEqualityEvidenceV1: null,
        };
        const winner = storedWinner();
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        const tx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                findUnique: vi.fn().mockResolvedValue({ encryptionMode: "plain" }),
                update: vi.fn().mockResolvedValue({ seq: 1 }),
                updateMany,
            },
            sessionMessage: {
                findMany: vi.fn().mockResolvedValue([]),
                create: vi.fn().mockResolvedValue(storedMessage),
            },
            sessionSystemRecord: {
                findFirst: vi.fn().mockResolvedValue(winner),
                update: vi.fn(),
            },
        } as unknown as Tx;
        inTx.mockImplementationOnce(async (operation: (transaction: Tx) => Promise<unknown>) => (
            await operation(tx)
        ));

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: "account-race",
            transportMachineId: "machine-race",
            command: {
                v: 1,
                kind: "batch",
                claim,
                expectedRevision: 0,
                batchId: makeExternalSessionHistoricalImportBatchIdV1(["history:race"]),
                items: [{
                    localId: "history:race",
                    sidechainId: null,
                    messageRole: "agent",
                    content: {
                        t: "plain",
                        v: { role: "agent", content: { type: "text", text: "historical" } },
                    },
                }],
            },
            limits,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "storage_mode_conflict",
            message: "Historical import storage authority changed during transition.",
        });
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                currentStorageState: "machine_only",
                acceptedThroughServerSeq: null,
            }),
        }));
    });

    it("returns a typed conflict when the discard storage transition loses its expected-state fence", async () => {
        const winner = storedWinner();
        const storedJob = {
            ...winner,
            content: {
                ...winner.content,
                acceptedThroughServerSeq: 1,
                insertedMessageIds: ["message-race"],
                insertedSequenceSpans: null,
            },
        };
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        const tx = {
            session: {
                findFirst: vi.fn().mockResolvedValue({
                    ...session,
                    currentStorageState: "server_partial",
                    acceptedThroughServerSeq: 1,
                }),
                updateMany,
            },
            sessionMessage: {
                deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
            },
            sessionSystemRecord: {
                findFirst: vi.fn().mockResolvedValue(storedJob),
                update: vi.fn(),
            },
        } as unknown as Tx;
        inTx.mockImplementationOnce(async (operation: (transaction: Tx) => Promise<unknown>) => (
            await operation(tx)
        ));

        await expect(executeExternalSessionHistoricalImportCommand({
            actorUserId: "account-race",
            transportMachineId: "machine-race",
            command: {
                v: 1,
                kind: "discard",
                claim,
                expectedRevision: 0,
            },
            limits,
        })).resolves.toMatchObject({
            kind: "error",
            errorCode: "storage_mode_conflict",
        });
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 1,
            }),
        }));
    });
});
