import { describe, expect, it } from "vitest";

import { deriveDirectoryFailureSchedule, projectTeamDirectorySourceSummary } from "./directorySourceProjection";

const base = {
    id: "source_1",
    teamId: "team_1",
    kind: "workos_directory" as const,
    state: "active" as const,
    displayName: "Primary directory",
    activeReconcileRunId: null,
    activeReconcileStartedAt: null,
    lastAttemptAt: new Date("2026-09-06T10:00:00.000Z"),
    lastSuccessAt: new Date("2026-09-06T10:00:00.000Z"),
    lastFullReconcileAt: new Date("2026-09-06T10:00:00.000Z"),
    lastErrorCode: null,
};

describe("directory source projection", () => {
    it("projects only the exact WorkOS connection needed by source-bound setup recovery", () => {
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, teamIdentityConnectionId: "connection_1" },
        }).workosAdminPortalConnectionId).toBe("connection_1");
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, kind: "github_organization", teamIdentityConnectionId: null },
        }).workosAdminPortalConnectionId).toBeNull();
    });

    it("derives attempt precedence without treating a queued manual request as syncing", () => {
        const now = new Date("2026-09-06T10:04:00.000Z");
        expect(projectTeamDirectorySourceSummary({ source: base, now })).toMatchObject({
            state: "active",
            sync: { mode: "events_and_full", attempt: "succeeded", freshness: "fresh" },
            error: null,
        });
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, state: "paused" },
            now,
        }).sync.attempt).toBe("paused");
        expect(projectTeamDirectorySourceSummary({
            source: {
                ...base,
                state: "initializing",
                activeReconcileRunId: "run_1",
                activeReconcileStartedAt: new Date("2026-09-06T10:03:00.000Z"),
            },
            now,
        }).sync.attempt).toBe("syncing");
        expect(projectTeamDirectorySourceSummary({
            source: {
                ...base,
                state: "initializing",
                activeReconcileRunId: "run_delayed",
                activeReconcileStartedAt: new Date("2026-09-06T09:58:59.999Z"),
            },
            now,
        }).sync.attempt).toBe("syncing");
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, state: "needs_attention", lastErrorCode: "directory_snapshot_incomplete" },
            now,
        })).toMatchObject({
            sync: { attempt: "failed" },
            error: { code: "directory_snapshot_incomplete", retryable: true },
        });
    });

    it("derives per-source freshness and next scheduled work from complete success", () => {
        expect(projectTeamDirectorySourceSummary({
            source: base,
            now: new Date("2026-09-06T10:09:59.999Z"),
        })).toMatchObject({
            sync: {
                freshness: "fresh",
                nextScheduledAt: "2026-09-06T10:05:00.000Z",
            },
        });
        expect(projectTeamDirectorySourceSummary({
            source: base,
            now: new Date("2026-09-06T10:10:00.000Z"),
        }).sync.freshness).toBe("stale");
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, kind: "github_organization" },
            now: new Date("2026-09-06T10:59:59.999Z"),
        })).toMatchObject({
            sync: { mode: "full_only", freshness: "fresh", nextScheduledAt: "2026-09-06T10:30:00.000Z" },
        });
    });

    it("does not call a never-completed or paused observation fresh", () => {
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, lastAttemptAt: null, lastSuccessAt: null, lastFullReconcileAt: null },
            now: new Date("2026-09-06T10:00:00.000Z"),
        })).toMatchObject({ sync: { attempt: "never", freshness: "never_synced", nextScheduledAt: null } });
        expect(projectTeamDirectorySourceSummary({
            source: { ...base, state: "paused" },
            now: new Date("2026-09-06T10:00:00.000Z"),
        })).toMatchObject({ sync: { freshness: "unknown", nextScheduledAt: null } });
    });

    it("projects the persisted retry schedule instead of deriving a duplicate fixed delay", () => {
        expect(projectTeamDirectorySourceSummary({
            source: {
                ...base,
                state: "active",
                lastErrorCode: "directory_snapshot_incomplete",
                consecutiveFailureCount: 2,
                retryNotBefore: new Date("2026-09-06T10:02:00.000Z"),
            },
            now: new Date("2026-09-06T10:00:30.000Z"),
        }).sync.nextScheduledAt).toBe("2026-09-06T10:02:00.000Z");
    });

    it.each(["directory_source_permission_lost", "unrecognized_persisted_error"])(
        "does not advertise scheduled work for a failure the worker cannot retry: %s",
        (lastErrorCode) => {
            expect(projectTeamDirectorySourceSummary({
                source: {
                    ...base,
                    lastErrorCode,
                    retryNotBefore: new Date("2026-09-06T10:02:00.000Z"),
                },
                now: new Date("2026-09-06T10:06:00.000Z"),
            }).sync.nextScheduledAt).toBeNull();
        },
    );

    it("honors provider retry hints and caps only fallback backoff at the regular source schedule", () => {
        expect(deriveDirectoryFailureSchedule({
            kind: "github_organization",
            consecutiveFailureCount: 0,
            failedAt: new Date("2026-09-06T10:00:00.000Z"),
            retryAfterMs: 60_000,
        })).toEqual({
            consecutiveFailureCount: 1,
            retryNotBefore: new Date("2026-09-06T10:01:00.000Z"),
        });
        expect(deriveDirectoryFailureSchedule({
            kind: "workos_directory",
            consecutiveFailureCount: 0,
            failedAt: new Date("2026-09-06T10:00:00.000Z"),
            retryAfterMs: 20 * 60_000,
        })).toEqual({
            consecutiveFailureCount: 1,
            retryNotBefore: new Date("2026-09-06T10:20:00.000Z"),
        });
        expect(deriveDirectoryFailureSchedule({
            kind: "workos_directory",
            consecutiveFailureCount: 2,
            failedAt: new Date("2026-09-06T10:00:00.000Z"),
        })).toEqual({
            consecutiveFailureCount: 3,
            retryNotBefore: new Date("2026-09-06T10:05:00.000Z"),
        });
    });
});
