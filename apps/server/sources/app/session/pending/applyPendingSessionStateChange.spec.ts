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

function createConcurrentDecrementTx() {
    const state: SessionState = {
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 5,
        accountSeq: 0,
    };
    const initialMutationWaiters: Array<() => void> = [];
    let initialMutationArrivals = 0;

    const waitForInitialMutationRace = async () => {
        initialMutationArrivals += 1;
        if (initialMutationArrivals < 2) {
            await new Promise<void>((resolve) => {
                initialMutationWaiters.push(resolve);
            });
            return;
        }

        if (initialMutationArrivals === 2) {
            for (const resolve of initialMutationWaiters.splice(0)) {
                resolve();
            }
        }
    };

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
                await waitForInitialMutationRace();
                applySessionMutation(state, args.data);
                return {
                    pendingCount: state.pendingCount,
                    pendingBlockedCount: state.pendingBlockedCount,
                    pendingVersion: state.pendingVersion,
                };
            }),
            updateMany: vi.fn(async (args: {
                where: { pendingCount?: number; pendingBlockedCount?: number; pendingVersion?: number };
                data: SessionMutationData;
            }) => {
                await waitForInitialMutationRace();
                if (
                    (typeof args.where.pendingCount === "number" && state.pendingCount !== args.where.pendingCount)
                    || (typeof args.where.pendingBlockedCount === "number" && state.pendingBlockedCount !== args.where.pendingBlockedCount)
                    || (typeof args.where.pendingVersion === "number" && state.pendingVersion !== args.where.pendingVersion)
                ) {
                    return { count: 0 };
                }

                applySessionMutation(state, args.data);
                return { count: 1 };
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
            upsert: vi.fn(async () => ({})),
        },
    };

    return {
        // Test boundary fake implements the Tx methods this helper reaches.
        tx: {
            ...tx,
            sessionFollowEdge: createEmptySessionFollowEdgeTransactionModel(),
            $queryRawUnsafe: createAccountCursorRawQueryTransactionModel(tx),
        } as unknown as Tx,
        readState: () => ({
            pendingCount: state.pendingCount,
            pendingVersion: state.pendingVersion,
        }),
    };
}

function createConcurrentEnqueueAfterFailedDecrementTx() {
    const state: SessionState = {
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingVersion: 5,
        accountSeq: 0,
    };
    let didConcurrentEnqueue = false;

    const applyConcurrentEnqueue = () => {
        if (didConcurrentEnqueue) return;
        didConcurrentEnqueue = true;
        state.pendingCount += 1;
        state.pendingVersion += 1;
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
                applyConcurrentEnqueue();
                applySessionMutation(state, args.data);
                return {
                    pendingCount: state.pendingCount,
                    pendingBlockedCount: state.pendingBlockedCount,
                    pendingVersion: state.pendingVersion,
                };
            }),
            updateMany: vi.fn(async (args: {
                where: { pendingCount?: number; pendingBlockedCount?: number; pendingVersion?: number };
                data: SessionMutationData;
            }) => {
                if (!didConcurrentEnqueue && args.where.pendingCount === 0) {
                    applyConcurrentEnqueue();
                }

                if (
                    (typeof args.where.pendingCount === "number" && state.pendingCount !== args.where.pendingCount)
                    || (typeof args.where.pendingBlockedCount === "number" && state.pendingBlockedCount !== args.where.pendingBlockedCount)
                    || (typeof args.where.pendingVersion === "number" && state.pendingVersion !== args.where.pendingVersion)
                ) {
                    return { count: 0 };
                }

                applySessionMutation(state, args.data);
                return { count: 1 };
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
        const { tx, accountChangeUpsert } = createConcurrentEnqueueAfterFailedDecrementTx();
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

    it("uses an atomic decrement so concurrent stale reads cannot drive pendingCount below 0", async () => {
        const { tx, readState } = createConcurrentDecrementTx();

        transaction.mockImplementationOnce(async (operation: (tx: Tx) => Promise<unknown>) => operation(tx));
        const [first, second] = await inTx(transactionTx => Promise.all([
            applyPendingSessionStateChange({ tx: transactionTx, sessionId: "s1", pendingCountDelta: -1 }),
            applyPendingSessionStateChange({ tx: transactionTx, sessionId: "s1", pendingCountDelta: -1 }),
        ]));

        expect(first.pendingCount).toBeGreaterThanOrEqual(0);
        expect(second.pendingCount).toBeGreaterThanOrEqual(0);
        expect(readState()).toEqual({ pendingCount: 0, pendingVersion: 7 });
    });

    it("does not clobber a concurrent enqueue after a failed decrement", async () => {
        const { tx, readState } = createConcurrentEnqueueAfterFailedDecrementTx();

        const result = await applyPendingInTransaction({ tx, sessionId: "s1", pendingCountDelta: -1 });

        expect(result.pendingCount).toBe(1);
        expect(result.pendingVersion).toBe(7);
        expect(readState()).toEqual({ pendingCount: 1, pendingVersion: 7 });
    });
});
