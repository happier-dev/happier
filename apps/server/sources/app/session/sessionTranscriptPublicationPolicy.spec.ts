import { describe, expect, it } from "vitest";

import {
    applySessionTranscriptPublicationCeiling,
    applySessionTranscriptPublicationCeilingToProjection,
    buildSessionMessagePublicationWhere,
    buildSessionMessagesPublicationWhere,
    isSessionTranscriptShareable,
    resolveSessionTranscriptPublicationCeiling,
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
        }, 18],
    ] as const)(
        "resolves $0.currentStorageState through its one authoritative server sequence",
        (publication, expected) => {
            expect(resolveSessionTranscriptPublicationCeiling(publication)).toBe(expected);
        },
    );

    it("fails closed for malformed state/ceiling combinations while treating a pre-migration row as hosted", () => {
        expect(resolveSessionTranscriptPublicationCeiling({})).toBeNull();
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

    it("admits sharing only for hosted or completely published snapshots", () => {
        expect(isSessionTranscriptShareable({})).toBe(true);
        expect(isSessionTranscriptShareable({ currentStorageState: "hosted" })).toBe(true);
        expect(isSessionTranscriptShareable({
            currentStorageState: "snapshot_complete",
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: 1_700_000_000_000n,
            publishedThroughServerSeq: 18,
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
});
