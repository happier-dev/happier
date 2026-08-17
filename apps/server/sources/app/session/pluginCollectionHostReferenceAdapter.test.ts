import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import {
    messagePluginCollectionHostReferenceAdapter,
    sessionPluginCollectionHostReferenceAdapter,
} from "./pluginCollectionHostReferenceAdapter";

describe("Message plugin Collection host reference", () => {
    it("admits only an Account-owned durable Message and keeps other Accounts indistinguishable from absence", async () => {
        const findFirst = vi.fn(async (): Promise<{ id: string } | null> => ({ id: "message-1" }));

        await expect(messagePluginCollectionHostReferenceAdapter.resolveInTx({
            tx: { sessionMessage: { findFirst } } as never,
            accountId: "account-1",
            targetId: "message-1",
        })).resolves.toEqual({ status: "available" });
        expect(findFirst).toHaveBeenCalledWith({
            where: {
                id: "message-1",
                session: { is: { accountId: "account-1" } },
            },
            select: { id: true },
        });

        findFirst.mockResolvedValueOnce(null);
        await expect(messagePluginCollectionHostReferenceAdapter.resolveInTx({
            tx: { sessionMessage: { findFirst } } as never,
            accountId: "account-2",
            targetId: "message-1",
        })).resolves.toEqual({ status: "unavailable" });
    });
});

function txFixture(input: Readonly<{
    session: Readonly<Record<string, unknown>> | null;
    share?: Readonly<{ accessLevel: "view" | "edit" | "admin" }> | null;
    change?: Readonly<{ sessionId: string | null }> | null;
}>) {
    const sessionFindUnique = vi.fn(async () => input.session);
    const sessionShareFindUnique = vi.fn(async () => input.share ?? null);
    const accountChangeFindUnique = vi.fn(async () => input.change ?? null);
    return {
        tx: {
            session: { findUnique: sessionFindUnique },
            sessionShare: { findUnique: sessionShareFindUnique },
            accountChange: { findUnique: accountChangeFindUnique },
        } as unknown as Tx,
        sessionShareFindUnique,
        accountChangeFindUnique,
    };
}

function hostedSession(accountId: string) {
    return {
        accountId,
        active: false,
        lastActiveAt: new Date(1),
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
    };
}

describe("Session host-reference adapter", () => {
    it("admits an exact Session through the canonical Account access owner", async () => {
        const owner = txFixture({ session: hostedSession("account-1") });

        await expect(sessionPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: owner.tx,
            accountId: "account-1",
            targetId: "session-1",
        })).resolves.toEqual({ status: "available" });
        expect(owner.sessionShareFindUnique).not.toHaveBeenCalled();
        expect(owner.accountChangeFindUnique).not.toHaveBeenCalled();

        const collaborator = txFixture({
            session: hostedSession("owner-account"),
            share: { accessLevel: "view" },
        });
        await expect(sessionPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: collaborator.tx,
            accountId: "account-1",
            targetId: "session-1",
        })).resolves.toEqual({ status: "available" });
    });

    it("returns only a tombstone after the canonical Account change loses its Session target", async () => {
        const deleted = txFixture({
            session: null,
            change: { sessionId: null },
        });

        await expect(sessionPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: deleted.tx,
            accountId: "account-1",
            targetId: "session-1",
        })).resolves.toEqual({ status: "tombstone" });
        expect(deleted.accountChangeFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_kind_entityId: {
                    accountId: "account-1",
                    kind: "session",
                    entityId: "session-1",
                },
            },
            select: { sessionId: true },
        });
    });

    it("fails closed for inaccessible, unknown, expired, or inconsistent Session references", async () => {
        const inaccessible = txFixture({
            session: hostedSession("owner-account"),
            change: { sessionId: "session-1" },
        });
        await expect(sessionPluginCollectionHostReferenceAdapter.resolveInTx({
            tx: inaccessible.tx,
            accountId: "account-1",
            targetId: "session-1",
        })).resolves.toEqual({ status: "unavailable" });

        for (const change of [null, { sessionId: "session-1" }] as const) {
            const missing = txFixture({ session: null, change });
            await expect(sessionPluginCollectionHostReferenceAdapter.resolveInTx({
                tx: missing.tx,
                accountId: "account-1",
                targetId: "session-1",
            })).resolves.toEqual({ status: "unavailable" });
        }
    });
});
