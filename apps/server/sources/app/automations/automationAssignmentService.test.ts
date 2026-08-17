import { describe, expect, it } from "vitest";

import { resolveAutomationAssignmentNextClaimAt } from "./automationAssignmentService";

describe("resolveAutomationAssignmentNextClaimAt", () => {
    it("uses the earliest reachable schedule, queued/retry, or lease-recovery deadline", () => {
        const nextClaimAt = resolveAutomationAssignmentNextClaimAt({
            nextRunAt: new Date("2026-08-10T12:10:00.000Z"),
            runs: [
                {
                    originKind: "scheduled",
                    state: "queued",
                    dueAt: new Date("2026-08-10T12:07:00.000Z"),
                    leaseExpiresAt: null,
                    executionDispatchState: null,
                },
                {
                    originKind: "manual",
                    state: "running",
                    dueAt: new Date("2026-08-10T12:20:00.000Z"),
                    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
                    executionDispatchState: "started",
                },
            ],
        });

        // Claims use a strict `leaseExpiresAt < now` predicate, so the durable
        // wake has to be the first claimable millisecond rather than the lease
        // boundary itself.
        expect(nextClaimAt?.toISOString()).toBe("2026-08-10T12:05:00.001Z");
    });

    it("does not infer a wake from terminal history", () => {
        expect(resolveAutomationAssignmentNextClaimAt({
            nextRunAt: null,
            runs: [{
                originKind: "manual",
                state: "succeeded",
                dueAt: new Date("2026-08-10T12:01:00.000Z"),
                leaseExpiresAt: new Date("2026-08-10T12:02:00.000Z"),
                executionDispatchState: "settled",
            }],
        })).toBeNull();
    });

    it("keeps an effect-free claimed Run dormant until its existing lease is strictly reclaimable", () => {
        const leaseExpiresAt = new Date("2026-08-10T12:05:00.000Z");
        expect(resolveAutomationAssignmentNextClaimAt({
            nextRunAt: null,
            runs: [{
                originKind: "scheduled",
                state: "claimed",
                dueAt: new Date("2026-08-10T12:00:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "notStarted",
            }],
        })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
    });

    it("uses lease recovery for a claimed retryWaiting Run instead of its stale retry dueAt", () => {
        const leaseExpiresAt = new Date("2026-08-10T12:05:00.000Z");
        expect(resolveAutomationAssignmentNextClaimAt({
            nextRunAt: null,
            runs: [{
                originKind: "scheduled",
                state: "claimed",
                dueAt: new Date("2026-08-10T12:01:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "retryWaiting",
            }],
        })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
    });

    it("does not advertise a stale schedule wake while its due Run remains claimed", () => {
        const leaseExpiresAt = new Date("2026-08-10T12:05:00.000Z");
        expect(resolveAutomationAssignmentNextClaimAt({
            // The Automation's nextRunAt remains the due time until the
            // incumbent lifecycle owner settles or reclaims this Run.
            nextRunAt: new Date("2026-08-10T12:00:00.000Z"),
            runs: [{
                originKind: "scheduled",
                state: "claimed",
                dueAt: new Date("2026-08-10T12:00:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "notStarted",
            }],
        })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
    });

    it.each(["claimed", "running"] as const)(
        "suppresses an edited schedule cursor while its previously due %s Run remains leased",
        (state) => {
            const leaseExpiresAt = new Date("2026-08-10T12:05:00.000Z");
            const heldScheduledRun = {
                originKind: "scheduled" as const,
                state,
                // Schedule edits advance the next cursor but do not rewrite a
                // Run that another worker has already claimed or started.
                dueAt: new Date("2026-08-10T12:10:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "notStarted" as const,
            };

            expect(resolveAutomationAssignmentNextClaimAt({
                nextRunAt: new Date("2026-08-10T12:01:00.000Z"),
                runs: [heldScheduledRun],
            })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
        },
    );

    it.each(["manual", "pluginEvent"] as const)(
        "does not suppress a schedule cursor for a leased %s Run",
        (originKind) => {
            const nextRunAt = new Date("2026-08-10T12:00:00.000Z");
            expect(resolveAutomationAssignmentNextClaimAt({
                nextRunAt,
                runs: [{
                    originKind,
                    state: "claimed",
                    dueAt: nextRunAt,
                    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
                    executionDispatchState: "notStarted",
                }],
            })?.getTime()).toBe(nextRunAt.getTime());
        },
    );

    it("does not revive a terminal Run with stale retry metadata", () => {
        expect(resolveAutomationAssignmentNextClaimAt({
            nextRunAt: null,
            runs: [{
                originKind: "manual",
                state: "outcome_uncertain",
                dueAt: new Date("2026-08-10T12:01:00.000Z"),
                leaseExpiresAt: null,
                executionDispatchState: "retryWaiting",
            }],
        })).toBeNull();
    });
});
