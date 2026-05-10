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
                source: "provider_status_error",
                code: "provider_status_error",
                occurredAt: 1,
            }),
        })).toBe(true);
    });
});
