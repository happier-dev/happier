import { describe, expect, it } from "vitest";

import {
    applySessionTranscriptPublicationCeiling,
    applySessionTranscriptPublicationCeilingToProjection,
    buildSessionMessagePublicationWhere,
    buildSessionMessagesPublicationWhere,
    isExternalShareableSessionTurnVisible,
    isSessionTranscriptPublicationBlocked,
    isSessionTranscriptShareable,
    projectSessionTranscriptPublicationChangeHint,
    projectSessionTranscriptPublicationPendingProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
    resolveSessionTranscriptPublicationCeiling,
    resolveExternalShareableTranscriptBlockedFromSeq,
} from "./sessionTranscriptPublicationPolicy";

describe("session transcript publication policy", () => {
    it.each([
        [{ currentStorageState: "hosted" }, null],
        [{ currentStorageState: "machine_only" }, 0],
        [{ currentStorageState: "legacy_external_unknown" }, 0],
        [{ currentStorageState: "server_partial", acceptedThroughServerSeq: 12 }, 12],
        [{
            currentStorageState: "snapshot_complete",
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 18,
            seq: 18,
        }, 18],
    ] as const)(
        "resolves $0.currentStorageState through its one authoritative server sequence",
        (publication, expected) => {
            expect(resolveSessionTranscriptPublicationCeiling(publication)).toBe(expected);
        },
    );

    it("fails closed for missing or malformed state/ceiling combinations", () => {
        expect(resolveSessionTranscriptPublicationCeiling({})).toBe(0);
        expect(resolveSessionTranscriptPublicationCeiling({
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 99,
        })).toBe(0);
        expect(resolveSessionTranscriptPublicationCeiling({
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 99,
            publishedThroughServerSeq: -1,
        })).toBe(0);
        expect(resolveSessionTranscriptPublicationCeiling({
            currentStorageState: "future_state",
            acceptedThroughServerSeq: 99,
            publishedThroughServerSeq: 99,
        })).toBe(0);
    });

    it("fails closed when a complete publication ceiling exceeds the authoritative Session sequence", () => {
        const completePublication = {
            currentStorageState: "snapshot_complete",
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 18,
            seq: 18,
        } as const;

        expect(resolveSessionTranscriptPublicationCeiling({
            ...completePublication,
            seq: 18,
        })).toBe(18);
        expect(isSessionTranscriptShareable({
            ...completePublication,
            seq: 18,
        })).toBe(true);

        expect(resolveSessionTranscriptPublicationCeiling({
            ...completePublication,
            seq: 17,
        })).toBe(0);
        expect(isSessionTranscriptShareable({
            ...completePublication,
            seq: 17,
        })).toBe(false);
    });

    it("admits sharing only for hosted or completely published snapshots", () => {
        expect(isSessionTranscriptShareable({})).toBe(false);
        expect(isSessionTranscriptShareable({ currentStorageState: "hosted" })).toBe(true);
        expect(isSessionTranscriptShareable({
            currentStorageState: "snapshot_complete",
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 18,
            seq: 18,
        })).toBe(true);

        expect(isSessionTranscriptShareable({ currentStorageState: "machine_only" })).toBe(false);
        expect(isSessionTranscriptShareable({
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 12,
        })).toBe(false);
        expect(isSessionTranscriptShareable({
            currentStorageState: "snapshot_complete",
            publishedThroughServerSeq: 18,
        })).toBe(false);
        expect(isSessionTranscriptShareable({
            currentStorageState: "legacy_external_unknown",
        })).toBe(false);
    });

    it("blocks external cursor progress for unpublished or malformed accepted ceilings", () => {
        const published = {
            currentStorageState: "snapshot_complete",
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 18,
            seq: 18,
        };
        expect(isSessionTranscriptPublicationBlocked({
            ...published,
            acceptedThroughServerSeq: 19,
        })).toBe(true);
        expect(isSessionTranscriptPublicationBlocked({
            ...published,
            acceptedThroughServerSeq: "malformed",
        })).toBe(true);
        expect(isSessionTranscriptPublicationBlocked({
            ...published,
            acceptedThroughServerSeq: null,
        })).toBe(false);
        expect(isSessionTranscriptPublicationBlocked({ currentStorageState: "server_partial" })).toBe(true);
        expect(isSessionTranscriptPublicationBlocked({ currentStorageState: "hosted" })).toBe(false);
    });

    it("uses one turn-visibility owner and ignores malformed legacy turns when deriving a cursor barrier", () => {
        const publication = {
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 9,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1n,
            publishedThroughServerSeq: 7,
            seq: 9,
        };
        const storedTurn = (turnId: string, transcriptAnchorsJson: string | null) => ({
            turnId,
            status: "completed",
            startedAt: 1n,
            updatedAt: 2n,
            transcriptAnchorsJson,
        });
        const visible = storedTurn("visible", JSON.stringify({
            startUserMessageSeq: 1,
            userMessageSeqs: [1],
            startSeqInclusive: 1,
            endSeqInclusive: 7,
            finalAssistantMessageSeq: 7,
        }));
        const hidden = storedTurn("hidden", JSON.stringify({
            startUserMessageSeq: 7,
            userMessageSeqs: [7],
            startSeqInclusive: 7,
            endSeqInclusive: 9,
            finalAssistantMessageSeq: 9,
        }));
        const malformed = storedTurn("malformed", "{not-json");

        expect(isExternalShareableSessionTurnVisible({ row: visible, publication })).toBe(true);
        expect(isExternalShareableSessionTurnVisible({ row: hidden, publication })).toBe(false);
        expect(resolveExternalShareableTranscriptBlockedFromSeq({
            rows: [visible, malformed, hidden],
            publication,
        })).toBe(7);
        expect(resolveExternalShareableTranscriptBlockedFromSeq({
            rows: [malformed],
            publication,
        })).toBeNull();
    });

    it("intersects ordinary forward and backward pagination with the publication ceiling", () => {
        expect(buildSessionMessagePublicationWhere({
            where: { sessionId: "s1", seq: { gt: 4 } },
            publication: {
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 10,
                publishedThroughServerSeq: null,
            },
        })).toEqual({
            sessionId: "s1",
            seq: { gt: 4, lte: 10 },
        });

        expect(buildSessionMessagePublicationWhere({
            where: { sessionId: "s1", seq: { lt: 8 } },
            publication: {
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: null,
                materializationPublicationId: "publication-1",
                materializedThroughSourceAt: 1_700_000_000_000n,
                publishedThroughServerSeq: 6,
                seq: 6,
            },
        })).toEqual({
            sessionId: "s1",
            seq: { lt: 8, lte: 6 },
        });
    });

    it("hides a by-local-id row above the ceiling and leaves hosted reads unbounded", () => {
        expect(buildSessionMessagePublicationWhere({
            where: { sessionId: "s1", localId: "private-row" },
            publication: {
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 3,
                publishedThroughServerSeq: null,
            },
        })).toEqual({
            sessionId: "s1",
            localId: "private-row",
            seq: { lte: 3 },
        });

        expect(buildSessionMessagePublicationWhere({
            where: { sessionId: "s1", localId: "hosted-row" },
            publication: {
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                publishedThroughServerSeq: null,
            },
        })).toEqual({ sessionId: "s1", localId: "hosted-row" });
    });

    it("builds one grouped predicate for counts spanning hosted and fenced sessions", () => {
        expect(buildSessionMessagesPublicationWhere([
            {
                id: "hosted",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                publishedThroughServerSeq: null,
            },
            {
                id: "partial-a",
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 7,
                publishedThroughServerSeq: null,
            },
            {
                id: "partial-b",
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 7,
                publishedThroughServerSeq: null,
            },
            {
                id: "unknown",
                currentStorageState: "legacy_external_unknown",
                acceptedThroughServerSeq: null,
                publishedThroughServerSeq: null,
            },
        ])).toEqual({
            OR: [
                { sessionId: { in: ["hosted"] } },
                { sessionId: { in: ["partial-a", "partial-b"] }, seq: { lte: 7 } },
            ],
        });
    });

    it("clamps exposed session sequence projections and suppresses unpublished ready events", () => {
        const publication = {
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 8,
            seq: 8,
        };

        expect(applySessionTranscriptPublicationCeiling(12, publication)).toBe(8);
        expect(applySessionTranscriptPublicationCeilingToProjection({
            seq: 12,
            lastViewedSessionSeq: 10,
            latestReadyEventSeq: 9,
            latestReadyEventAt: new Date(1_000),
        }, publication)).toEqual({
            seq: 8,
            lastViewedSessionSeq: 8,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
    });

    it("suppresses unpublished finite recipient fanout instead of publishing a sanitized tuple", () => {
        const finiteSession = {
            accountId: "owner",
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: "publication-realtime-v1",
            materializedThroughSourceAt: 42_000n,
            publishedThroughServerSeq: 4,
            seq: 9,
            lastViewedSessionSeq: 9,
            latestReadyEventSeq: 3,
            latestReadyEventAt: new Date(30_000),
            createdAt: new Date(10_000),
            updatedAt: new Date(90_000),
            meaningfulActivityAt: new Date(90_000),
            lastActiveAt: new Date(90_000),
        } as const;
        const rawProjection = {
            active: true,
            activeAt: 90_000,
            lastViewedSessionSeq: 9,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 2,
            pendingRequestObservedAt: 90_000,
            latestReadyEventSeq: 9,
            latestReadyEventAt: 90_000,
            latestTurnId: "private-turn",
            latestTurnStatus: "failed" as const,
            latestTurnStatusObservedAt: 90_000,
            lastRuntimeIssue: null,
            runtimeActivityState: "active" as const,
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 90_000,
            runtimeActivityRevision: 9,
            meaningfulActivityAt: 90_000,
        };

        expect(projectSessionTranscriptPublicationRealtimeProjection(
            rawProjection,
            finiteSession,
            "collaborator",
        )).toEqual({ kind: "suppress" });
        expect(projectSessionTranscriptPublicationRealtimeProjection(
            rawProjection,
            finiteSession,
            "owner",
        )).toEqual({ kind: "publish", value: rawProjection });

        const privateHint = { latestTurnId: "private-turn" };
        expect(projectSessionTranscriptPublicationChangeHint(
            privateHint,
            finiteSession,
            "collaborator",
        )).toEqual({ kind: "suppress" });
        expect(projectSessionTranscriptPublicationChangeHint(
            privateHint,
            finiteSession,
            "owner",
        )).toEqual({ kind: "publish", value: privateHint });

        const pendingProjection = {
            pendingVersion: 9,
            pendingCount: 2,
            pendingBlockedCount: 1,
            changedByAccountId: "private-owner",
            meaningfulActivityAt: 90_000,
            pendingActivationRequestId: "private-request",
        };
        expect(projectSessionTranscriptPublicationPendingProjection(
            pendingProjection,
            finiteSession,
            "collaborator",
        )).toEqual({ kind: "suppress" });
        expect(projectSessionTranscriptPublicationPendingProjection(
            pendingProjection,
            finiteSession,
            "owner",
        )).toEqual({ kind: "publish", value: pendingProjection });

        const publishedReadyProjection = {
            latestReadyEventSeq: 3,
            latestReadyEventAt: 30_000,
        };
        expect(projectSessionTranscriptPublicationRealtimeProjection(
            publishedReadyProjection,
            finiteSession,
            "collaborator",
        )).toEqual({ kind: "publish", value: publishedReadyProjection });
    });
});
