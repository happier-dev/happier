import { describe, expect, it } from "vitest";
import { NOT_STARTED_VIEWER_READ_STATE_V1, type ViewerReadStateV1 } from "@happier-dev/protocol";

import {
    computeSessionContributesToActivityBadge,
    didSessionActivityBadgeSignalChange,
    didViewerActivityBadgeContributionChange,
    type SessionViewerBadgeInputs,
} from "./accountActivityBadge";

const HOSTED_PUBLICATION = {
    currentStorageState: "hosted",
    acceptedThroughServerSeq: null,
    materializationPublicationId: null,
    materializedThroughSourceAt: null,
    publishedThroughServerSeq: null,
} as const;

function tracked(lastViewedSessionSeq: number): ViewerReadStateV1 {
    return { state: "tracking", lastViewedSessionSeq, unreadSince: null };
}

function badgeInputs(overrides: Partial<SessionViewerBadgeInputs> = {}): SessionViewerBadgeInputs {
    return {
        ...HOSTED_PUBLICATION,
        active: true,
        archivedAt: null,
        seq: 5,
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        latestReadyEventSeq: null,
        latestTurnStatus: null,
        lastRuntimeIssue: null,
        tracked: true,
        viewerReadState: tracked(5),
        ...overrides,
    };
}

describe("computeSessionContributesToActivityBadge", () => {
    it("retains durable unread attention when the runtime is inactive", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            active: false,
            viewerReadState: tracked(4),
        }))).toBe(true);
    });

    it("stays quiet for a viewer with no read row instead of treating history as unread", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            seq: 42,
            viewerReadState: NOT_STARTED_VIEWER_READ_STATE_V1,
        }))).toBe(false);
    });

    it("stays quiet for an untracked viewer even with unread facts", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            tracked: false,
            viewerReadState: tracked(1),
            pendingPermissionRequestCount: 2,
        }))).toBe(false);
    });

    it("does not interpret malformed runtime issue text as primary-session failure", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            latestTurnStatus: "failed",
            lastRuntimeIssue: "not a canonical runtime issue",
        }))).toBe(false);
    });

    it("counts failed primary-session runtime issues as badge attention", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            seq: 1,
            latestFailureSeq: 1,
            viewerReadState: tracked(0),
            latestTurnStatus: "failed",
            lastRuntimeIssue: JSON.stringify({
                v: 1,
                scope: "primary_session",
                status: "failed",
                source: "agent_status_error",
                code: "agent_status_error",
                occurredAt: 1,
            }),
        }))).toBe(true);
    });

    it("does not count queued pending input as badge attention", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({ pendingCount: 2 }))).toBe(false);
    });

    it("counts blocked pending delivery as badge attention", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            pendingCount: 2,
            pendingBlockedCount: 1,
        }))).toBe(true);
    });

    it("counts a ready event the viewer has not caught up with, matching the Session list", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            seq: 4,
            viewerReadState: tracked(4),
            latestReadyEventSeq: 5,
        }))).toBe(true);
    });

    it("counts an explicit positive standing through the canonical attention projection", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            attentionStanding: "positive",
        }))).toBe(true);
    });

    it("does not count provider runtime activity as user attention", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            latestTurnStatus: "completed",
        }))).toBe(false);
    });

    it("does not count unpublished imported transcript rows as badge attention", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            seq: 9,
            viewerReadState: tracked(4),
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 4,
        }))).toBe(false);
    });

    it("stays quiet for an archived Session", () => {
        expect(computeSessionContributesToActivityBadge(badgeInputs({
            archivedAt: new Date(),
            viewerReadState: tracked(1),
        }))).toBe(false);
    });
});

describe("didSessionActivityBadgeSignalChange", () => {
    // Owner decision 2026-11-04 D6 / audit 1112: ordinary messages never fan out badge pushes.
    it("schedules zero badge refreshes for ordinary messages and one for each operational attention flip", () => {
        let before = badgeInputs();
        let refreshes = 0;
        for (let seq = 6; seq <= 1005; seq += 1) {
            const after = { ...before, seq };
            refreshes += Number(didSessionActivityBadgeSignalChange(before, after));
            before = after;
        }
        expect(refreshes).toBe(0);
        const blocked = { ...before, pendingBlockedCount: 1 };
        expect(didSessionActivityBadgeSignalChange(before, blocked)).toBe(true);
        expect(didSessionActivityBadgeSignalChange(blocked, { ...blocked, pendingBlockedCount: 2 })).toBe(false);
        expect(didSessionActivityBadgeSignalChange(blocked, before)).toBe(true);
        expect(didSessionActivityBadgeSignalChange(before, { ...before, latestReadyEventSeq: 1006 })).toBe(true);
        expect(didSessionActivityBadgeSignalChange(before, { ...before, pendingPermissionRequestCount: 1 })).toBe(true);
        expect(didSessionActivityBadgeSignalChange(before, { ...before, pendingUserActionRequestCount: 1 })).toBe(true);
        expect(didSessionActivityBadgeSignalChange(before, { ...before, archivedAt: new Date(0) })).toBe(true);
    });
    it("does not invent unread before a missing private cursor is seeded", () => {
        expect(didViewerActivityBadgeContributionChange(badgeInputs(), null, 5)).toBe(false);
    });
    it("reports a change when blocked pending delivery appears", () => {
        const before = badgeInputs();
        expect(didSessionActivityBadgeSignalChange(before, { ...before, pendingBlockedCount: 1 })).toBe(true);
    });

    it("ignores the shared read cursor, which no longer decides another Account's badge", () => {
        const before = badgeInputs();
        expect(didSessionActivityBadgeSignalChange(before, { ...before, lastViewedSessionSeq: 0 })).toBe(false);
    });
});
