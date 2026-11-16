import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inTx, type Tx } from "@/storage/inTx";
import { applyPendingSessionStateChange } from "./applyPendingSessionStateChange";
import { createAccountCursorRawQueryTransactionModel, createEmptySessionFollowEdgeTransactionModel } from "@/app/api/testkit/txHarness";

const transaction = vi.hoisted(() => vi.fn());
// Only the persistent transaction transport is substituted; publication stays real.
vi.mock("@/storage/db", () => ({ db: { $transaction: transaction } }));

async function applyPendingInTransaction(params: Parameters<typeof applyPendingSessionStateChange>[0]) {
    transaction.mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => operation(params.tx));
    return inTx(tx => applyPendingSessionStateChange({ ...params, tx }));
}

type SessionState = {
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    accountSeq: number;
};

type SessionMutationData = {
    pendingCount?: number;
    pendingBlockedCount?: number;
    pendingVersion?: { increment?: number };
    meaningfulActivityAt?: Date;
};

function applySessionMutation(state: SessionState, data: SessionMutationData): void {
    if (typeof data.pendingCount === "number") {
        state.pendingCount = data.pendingCount;
    }

    if (typeof data.pendingBlockedCount === "number") {
        state.pendingBlockedCount = data.pendingBlockedCount;
    }

    if (data.pendingVersion?.increment) {
        state.pendingVersion += data.pendingVersion.increment;
    }
}

function createSessionTx(initialPendingCount: number) {
    const state: SessionState = {
        pendingCount: initialPendingCount,
        pendingBlockedCount: 0,
        pendingVersion: 5,
        accountSeq: 0,
    };
    const accountChangeUpsert = vi.fn(async () => ({}));
    const tx = {
        session: {
            findMany: vi.fn(async () => [{
                id: "s1",
                accountId: "owner",
                seq: 0,
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                account: { status: "active" },
            }]),
            findUniqueOrThrow: vi.fn(async () => ({
                seq: 0,
                pendingCount: state.pendingCount,
                pendingBlockedCount: state.pendingBlockedCount,
                pendingVersion: state.pendingVersion,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            })),
            update: vi.fn(async (args: { data: SessionMutationData }) => {
                applySessionMutation(state, args.data);
                return {
                    pendingCount: state.pendingCount,
                    pendingBlockedCount: state.pendingBlockedCount,
                    pendingVersion: state.pendingVersion,
                };
            }),
            findUnique: vi.fn(async () => ({
                accountId: "owner",
                grants: [],
            })),
        },
        sessionGrant: { findMany: vi.fn(async () => []) },
        
        
        sessionFollowEdge: { findMany: vi.fn(async () => []) },
        account: {
            update: vi.fn(async () => {
                state.accountSeq += 1;
                return { seq: state.accountSeq };
            }),
        },
        accountChange: {
            findUnique: vi.fn(async () => null),
            upsert: accountChangeUpsert,
        },
    };

    return {
        // Test boundary fake implements the Tx methods this helper reaches.
        tx: {
            ...tx,
            sessionFollowEdge: createEmptySessionFollowEdgeTransactionModel(),
            $queryRawUnsafe: createAccountCursorRawQueryTransactionModel(tx),
            // The Account publication fence's per-Account row touch (one affected row each).
            $executeRawUnsafe: vi.fn(async () => 1),
        } as unknown as Tx,
        accountChangeUpsert,
        readState: () => ({
            pendingCount: state.pendingCount,
            pendingVersion: state.pendingVersion,
        }),
    };
}

describe("applyPendingSessionStateChange", () => {
    beforeEach(() => vi.stubEnv("HAPPIER_DB_PROVIDER", "sqlite"));
    afterEach(() => vi.unstubAllEnvs());
    it("includes exact meaningful activity in pending change hints", async () => {
        const { tx, accountChangeUpsert } = createSessionTx(1);
        const meaningfulActivityAt = new Date(1_234);

        const result = await applyPendingInTransaction({
            tx,
            sessionId: "s1",
            pendingCountDelta: 1,
            meaningfulActivityAt,
        });

        expect(result.pendingCount).toBe(2);
        expect(accountChangeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    hint: expect.objectContaining({ meaningfulActivityAt: 1_234 }),
                }),
                update: expect.objectContaining({
                    hint: expect.objectContaining({ meaningfulActivityAt: 1_234 }),
                }),
            }),
        );
    });

    it("writes the counters from its locked read in one update and never drives pendingCount below 0", async () => {
        const { tx, readState } = createSessionTx(0);

        const result = await applyPendingInTransaction({ tx, sessionId: "s1", pendingCountDelta: -1 });

        expect(result).toMatchObject({ pendingCount: 0, pendingVersion: 6 });
        expect(readState()).toEqual({ pendingCount: 0, pendingVersion: 6 });
    });
});
