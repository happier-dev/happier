import { beforeEach, describe, expect, it, vi } from "vitest";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: any) => await fn(currentTx),
}));

const getSessionParticipantUserIds = vi.fn();
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds: (...args: any[]) => getSessionParticipantUserIds(...args),
}));

const markAccountChanged = vi.fn();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: (...args: any[]) => markAccountChanged(...args),
}));

const dbFindFirst = vi.fn();
const dbSessionFindUnique = vi.fn();
const dbSessionShareFindUnique = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: (...args: any[]) => dbSessionFindUnique(...args),
        },
        sessionShare: {
            findUnique: (...args: any[]) => dbSessionShareFindUnique(...args),
        },
        sessionMessage: {
            findFirst: (...args: any[]) => dbFindFirst(...args),
        },
    },
}));

import { createSessionMessage, patchSession, updateSessionAgentState, updateSessionMetadata } from "./sessionWriteService";

describe("sessionWriteService", () => {
    beforeEach(() => {
        getSessionParticipantUserIds.mockReset();
        markAccountChanged.mockReset();
        dbFindFirst.mockReset();
        dbSessionFindUnique.mockReset();
        dbSessionShareFindUnique.mockReset();

        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            sessionShare: {
                findUnique: vi.fn(),
            },
            sessionMessage: {
                findFirst: vi.fn(),
                create: vi.fn(),
            },
        };
    });

    describe("createSessionMessage", () => {
        it("returns existing message for (sessionId, localId) without writing or marking changes", async () => {
            currentTx.sessionMessage.findFirst.mockResolvedValue({ id: "m1", seq: 4, localId: "l1", createdAt: new Date(1) });
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "c1",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                message: { id: "m1", seq: 4, localId: "l1", createdAt: new Date(1) },
                participantCursors: [],
            });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects message creation if actor has no edit access", async () => {
            currentTx.sessionMessage.findFirst.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "owner" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u2",
                sessionId: "s1",
                ciphertext: "c1",
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("creates a message, marks changes for all participants, and returns per-recipient cursors", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findFirst.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 10,
                localId: "l1",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");

            expect(res.message.id).toBe("m1");
            expect(res.message.seq).toBe(10);
            expect(res.participantCursors).toEqual([
                { accountId: "u1", cursor: 101 },
                { accountId: "u2", cursor: 102 },
            ]);

            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u1",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u2",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
        });

        it("handles localId races by returning the winner row on P2002", async () => {
            currentTx.sessionMessage.findFirst.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbSessionFindUnique.mockResolvedValue({ accountId: "u1" });
            dbSessionShareFindUnique.mockResolvedValue(null);
            dbFindFirst.mockResolvedValue({ id: "mExisting", seq: 9, localId: "l1", createdAt: new Date(1) });

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                message: { id: "mExisting", seq: 9, localId: "l1", createdAt: new Date(1) },
                participantCursors: [],
            });
        });
    });

    describe("updateSessionMetadata", () => {
        it("returns version-mismatch with current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mCurrent" });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mCurrent" } });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mFresh" });
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("updateSessionAgentState", () => {
        it("updates with CAS and marks participants", async () => {
            currentTx.session.findUnique.mockResolvedValueOnce({ accountId: "u1" }).mockResolvedValueOnce({ agentStateVersion: 1, agentState: "a1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: null,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
            });
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce({ agentStateVersion: 5, agentState: "aFresh" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, agentState: "aFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce(null);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("patchSession", () => {
        it("returns version-mismatch with current values for requested fields", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataVersion: 5,
                    metadata: "mCurrent",
                    agentStateVersion: 9,
                    agentState: "aCurrent",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 4 },
                agentState: { ciphertext: null, expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadata: { version: 5, value: "mCurrent" },
                    agentState: { version: 9, value: "aCurrent" },
                },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("updates both fields in one CAS and marks participants once", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataVersion: 1,
                    metadata: "m1",
                    agentStateVersion: 2,
                    agentState: "a2",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
                agentState: { ciphertext: null, expectedVersion: 2 },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [
                    { accountId: "u1", cursor: 10 },
                    { accountId: "u2", cursor: 11 },
                ],
                metadata: { version: 2, value: "mNew" },
                agentState: { version: 3, value: null },
            });
        });
    });
});
