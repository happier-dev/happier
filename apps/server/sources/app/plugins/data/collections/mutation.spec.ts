import { describe, expect, it, vi } from "vitest";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

const authentication = createPresentUserSessionAccessAuthentication();

const state = vi.hoisted(() => ({
    tx: null as ReturnType<typeof createTx> | null,
}));

const compileCounting = vi.hoisted(() => ({
    calls: 0,
}));

vi.mock("@happier-dev/protocol/plugins/actions/json-schema-validation", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@happier-dev/protocol/plugins/actions/json-schema-validation")>();
    return {
        ...actual,
        compilePluginJsonSchema: ((schema: object) => {
            compileCounting.calls += 1;
            return actual.compilePluginJsonSchema(schema);
        }) as typeof actual.compilePluginJsonSchema,
    };
});

vi.mock("@/storage/db", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/db")>();
    const { createPrismaTransactionBoundary } = await import("@/app/api/testkit/txHarness");
    return { ...actual, db: {
        // Fake only Prisma's driver callback; retain real inTx context and admission.
        $transaction: createPrismaTransactionBoundary(() => {
            if (!state.tx) throw new Error("Expected transaction fixture");
            return state.tx;
        }),
    } };
});

import type { NormalizedPluginAccountCollectionContractV1 } from "@happier-dev/protocol";
import { PLUGIN_COLLECTION_REVISION_MAX } from "@happier-dev/protocol";
import {
    advancePluginCollectionRevision,
    assertPluginCollectionStoredContentForAccountTransition,
    createPluginCollectionContractValidators,
    measurePluginCollectionCandidateRowEncodedBytes,
    measurePluginCollectionStoredRowEncodedBytes,
    mutatePluginCollection,
} from "./mutation";

function createTx() {
    return {
        $executeRawUnsafe: vi.fn(async (_sql: string, ..._values: unknown[]) => 1),
        $queryRawUnsafe: vi.fn(async (_sql: string, ..._values: unknown[]) => [{ id: "account-1" }]),
        $queryRaw: vi.fn(async () => [{ statement_timeout: "0" }]),
        account: {
            findUnique: vi.fn(async () => ({
                publicKey: null,
                seq: 1,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
                settings: null,
                settingsVersion: 0,
            })),
        },
        pluginCollectionRow: { findMany: vi.fn(async () => []) },
        accountPluginIntent: {
            findUnique: vi.fn(async () => null),
            findMany: vi.fn(async () => []),
        },
    };
}

describe("plugin Collection mutation", () => {
    it("allocates the last currentness value the persisted column holds and refuses the next", () => {
        // One allocator serves revisions and the absence epoch, so the boundary
        // is the persisted signed 32-bit column rather than a per-path number.
        expect(advancePluginCollectionRevision(0)).toBe(1);
        expect(advancePluginCollectionRevision(PLUGIN_COLLECTION_REVISION_MAX - 1))
            .toBe(PLUGIN_COLLECTION_REVISION_MAX);
        expect(() => advancePluginCollectionRevision(PLUGIN_COLLECTION_REVISION_MAX))
            .toThrowError(expect.objectContaining({ code: "collection_revision_exhausted" }));
    });

    it("measures the complete stored row with UTF-8 bytes and canonical projection ordering", () => {
        expect(measurePluginCollectionStoredRowEncodedBytes({
            rowId: "row-🙂",
            contentEnvelope: {
                t: "plain",
                v: { zebra: "quoted \"text\"", emoji: "🙂" },
            },
            projections: [
                { fieldId: "zeta", typedEncodedValue: "\"é\"" },
                { fieldId: "alpha", typedEncodedValue: "null" },
            ],
        })).toBe(210);
    });

    it("measures a mutation candidate through the same stored-row metric", () => {
        expect(measurePluginCollectionCandidateRowEncodedBytes({
            rowId: "row-🙂",
            contentEnvelope: {
                t: "plain",
                v: { zebra: "quoted \"text\"", emoji: "🙂" },
            },
            projection: {
                zeta: "é",
                alpha: null,
            },
        })).toBe(210);
    });

    it("acquires Account transition admission before the canonical mode read", async () => {
        const tx = createTx();
        state.tx = tx;

        await expect(mutatePluginCollection({
            accountId: "account-1",
            authentication,
            request: {
                pluginId: "example.tasks",
                collectionId: "tasks",
                writerContext: {
                    schemaVersion: 1,
                    contractDigest: "a".repeat(43),
                },
                operations: [{
                    kind: "put",
                    rowId: "task-a",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: {} },
                    projection: {},
                }],
            },
        })).rejects.toMatchObject({ code: "collection_unavailable" });

        const fenceCallOrder = [tx.$executeRawUnsafe, tx.$queryRawUnsafe].flatMap(method => (
            method.mock.calls.flatMap((args, index) => (
                String(args[0]).includes('"Account"') || String(args[0]).includes('`Account`')
                    ? [method.mock.invocationCallOrder[index]] : []
            ))
        ));
        expect(fenceCallOrder).toHaveLength(1);
        expect(fenceCallOrder[0]).toBeLessThan(
            tx.account.findUnique.mock.invocationCallOrder[0],
        );
    });

    it("prepares each distinct contract schema validator once per operation", () => {
        const contract = {
            pluginId: "example.tasks",
            collectionId: "tasks",
            schemaVersion: 1,
            migrations: [],
            contractDigest: "a".repeat(43),
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    alpha: { type: "string" },
                    beta: { type: "integer" },
                },
                required: ["id", "alpha"],
                additionalProperties: false,
            } as NormalizedPluginAccountCollectionContractV1["schema"],
            serverReadable: ["id", "alpha"],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [1],
            identityFields: [],
        } satisfies NormalizedPluginAccountCollectionContractV1;

        // The operation-scoped holder compiles each distinct schema exactly once
        // no matter how many rows or re-reads consume it.
        const validators = createPluginCollectionContractValidators(contract);
        const beforeHolder = compileCounting.calls;
        validators.fieldValidator("id");
        validators.fieldValidator("id");
        validators.fieldValidator("alpha");
        validators.logicalRowValidator();
        validators.logicalRowValidator();
        expect(compileCounting.calls - beforeHolder).toBe(3);

        // One whole-operation validation pass over the pure public owner —
        // stored projection plus envelope and logical row, with the projection
        // intentionally validated through the same holder twice — compiles the
        // two readable field schemas and the logical-row schema exactly once.
        const beforeTransition = compileCounting.calls;
        expect(assertPluginCollectionStoredContentForAccountTransition({
            contract,
            encryptionMode: "plain",
            rowId: "row-1",
            contentEnvelope: { t: "plain", v: { beta: 1 } },
            projections: [
                { fieldId: "id", typedEncodedValue: "\"row-1\"" },
                { fieldId: "alpha", typedEncodedValue: "\"a\"" },
            ],
        })).toEqual({
            content: { t: "plain", v: { beta: 1 } },
            projection: { id: "row-1", alpha: "a" },
        });
        expect(compileCounting.calls - beforeTransition).toBe(3);
    });
});
