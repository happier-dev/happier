import { describe, expect, it } from "vitest";

import { computeSessionContributesToActivityBadge } from "./accountActivityBadge";

describe("computeSessionContributesToActivityBadge", () => {
    it("does not count queued pending input as badge attention", () => {
        expect(computeSessionContributesToActivityBadge({
            active: true,
            archivedAt: null,
            seq: 5,
            lastViewedSessionSeq: 5,
            pendingCount: 2,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        })).toBe(false);
    });

    it("counts blocked pending delivery as badge attention", () => {
        expect(computeSessionContributesToActivityBadge({
            active: true,
            archivedAt: null,
            seq: 5,
            lastViewedSessionSeq: 5,
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        })).toBe(true);
    });

    it("does not count provider runtime activity as user attention", () => {
        const sessionWithRuntimeActivity = {
            active: true,
            archivedAt: null,
            seq: 5,
            lastViewedSessionSeq: 5,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "completed",
            lastRuntimeIssue: null,
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 2,
        };

        expect(computeSessionContributesToActivityBadge(sessionWithRuntimeActivity)).toBe(false);
    });

    it("counts failed primary-session runtime issues as badge attention", () => {
        expect(computeSessionContributesToActivityBadge({
            active: true,
            archivedAt: null,
            seq: 0,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "failed",
            lastRuntimeIssue: JSON.stringify({
                v: 1,
                scope: "primary_session",
                status: "failed",
                source: "agent_status_error",
                code: "agent_status_error",
                occurredAt: 1,
            }),
        })).toBe(true);
    });

    it("does not count unpublished imported transcript rows as badge attention", () => {
        const partialSession = {
            active: true,
            archivedAt: null,
            seq: 9,
            lastViewedSessionSeq: 4,
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        };

        expect(computeSessionContributesToActivityBadge(partialSession)).toBe(false);
    });
});
