import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
    definitionAssignments: vi.fn(),
    runAssignments: vi.fn(),
    automations: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: {
        automationAssignment: { findMany: dbMocks.definitionAssignments },
        automationRunAssignment: { findMany: dbMocks.runAssignments },
        automation: { findMany: dbMocks.automations },
    },
}));

import {
    assertAutomationAssignmentLiveness,
    listDaemonAssignments,
    resolveAutomationAssignmentNextClaimAt,
} from "./automationAssignmentService";
import { AutomationValidationError } from "./automationValidation";

describe("resolveAutomationAssignmentNextClaimAt", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.definitionAssignments.mockResolvedValue([]);
        dbMocks.runAssignments.mockResolvedValue([]);
        dbMocks.automations.mockResolvedValue([]);
    });

    it("uses the earliest reachable schedule, queued/retry, or lease-recovery deadline", () => {
        const nextClaimAt = resolveAutomationAssignmentNextClaimAt({
            schedules: [{
                triggerId: "schedule-1",
                nextRunAt: new Date("2026-08-10T12:10:00.000Z"),
            }],
            runs: [
                {
                    triggerId: "schedule-1",
                    causeKind: "trigger",
                    causeTriggerKind: "schedule",
                    state: "queued",
                    dueAt: new Date("2026-08-10T12:07:00.000Z"),
                    leaseExpiresAt: null,
                    executionDispatchState: null,
                },
                {
                    triggerId: null,
                    causeKind: "manual",
                    causeTriggerKind: null,
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
            schedules: [],
            runs: [{
                triggerId: null,
                causeKind: "manual",
                causeTriggerKind: null,
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
            schedules: [],
            runs: [{
                triggerId: "schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
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
            schedules: [],
            runs: [{
                triggerId: "schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
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
            // The trigger's nextRunAt remains the due time until the
            // incumbent lifecycle owner settles or reclaims this Run.
            schedules: [{
                triggerId: "schedule-1",
                nextRunAt: new Date("2026-08-10T12:00:00.000Z"),
            }],
            runs: [{
                triggerId: "schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                state: "claimed",
                dueAt: new Date("2026-08-10T12:00:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "notStarted",
            }],
        })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
    });

    it("keeps distinct schedule-trigger wakes independent", () => {
        const secondScheduleDueAt = new Date("2026-08-10T12:01:00.000Z");
        expect(resolveAutomationAssignmentNextClaimAt({
            schedules: [
                { triggerId: "schedule-1", nextRunAt: new Date("2026-08-10T12:00:00.000Z") },
                { triggerId: "schedule-2", nextRunAt: secondScheduleDueAt },
            ],
            runs: [{
                triggerId: "schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                state: "claimed",
                dueAt: new Date("2026-08-10T12:00:00.000Z"),
                leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
                executionDispatchState: "notStarted",
            }],
        })?.getTime()).toBe(secondScheduleDueAt.getTime());
    });

    it("indexes open schedule occurrences once instead of rescanning every Run per trigger", () => {
        let triggerIdentityReads = 0;
        const heldRun = {
            get triggerId() {
                triggerIdentityReads += 1;
                return "schedule-held";
            },
            causeKind: "trigger" as const,
            causeTriggerKind: "schedule" as const,
            state: "claimed" as const,
            dueAt: new Date("2026-08-10T12:00:00.000Z"),
            leaseExpiresAt: new Date("2030-08-10T12:05:00.000Z"),
            executionDispatchState: "notStarted" as const,
        };
        const schedules = Array.from({ length: 100 }, (_, index) => ({
            triggerId: `schedule-${index}`,
            nextRunAt: new Date(1_800_000_000_000 + index),
        }));

        expect(resolveAutomationAssignmentNextClaimAt({ schedules, runs: [heldRun] }))
            .toEqual(schedules[0]!.nextRunAt);
        expect(triggerIdentityReads).toBe(1);
    });

    it("does not advertise an admitted occurrence to a machine added after admission", () => {
        expect(resolveAutomationAssignmentNextClaimAt({
            schedules: [{
                triggerId: "schedule-1",
                nextRunAt: new Date("2026-08-10T12:00:00.000Z"),
            }],
            runs: [{
                triggerId: "schedule-1",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                state: "queued",
                dueAt: new Date("2026-08-10T12:00:00.000Z"),
                leaseExpiresAt: null,
                executionDispatchState: null,
                assignedToMachine: false,
            }],
        })).toBeNull();
    });

    it.each(["claimed", "running"] as const)(
        "suppresses an edited schedule cursor while its previously due %s Run remains leased",
        (state) => {
            const leaseExpiresAt = new Date("2026-08-10T12:05:00.000Z");
            const heldScheduledRun = {
                triggerId: "schedule-1",
                causeKind: "trigger" as const,
                causeTriggerKind: "schedule" as const,
                state,
                // Schedule edits advance the next cursor but do not rewrite a
                // Run that another worker has already claimed or started.
                dueAt: new Date("2026-08-10T12:10:00.000Z"),
                leaseExpiresAt,
                executionDispatchState: "notStarted" as const,
            };

            expect(resolveAutomationAssignmentNextClaimAt({
                schedules: [{
                    triggerId: "schedule-1",
                    nextRunAt: new Date("2026-08-10T12:01:00.000Z"),
                }],
                runs: [heldScheduledRun],
            })?.getTime()).toBe(leaseExpiresAt.getTime() + 1);
        },
    );

    it.each([
        { name: "manual", triggerId: null, causeKind: "manual", causeTriggerKind: null },
        { name: "pluginEvent", triggerId: "event-1", causeKind: "trigger", causeTriggerKind: "pluginEvent" },
    ] as const)(
        "does not suppress a schedule cursor for a leased $name Run",
        ({ triggerId, causeKind, causeTriggerKind }) => {
            const nextRunAt = new Date("2026-08-10T12:00:00.000Z");
            expect(resolveAutomationAssignmentNextClaimAt({
                schedules: [{ triggerId: "schedule-1", nextRunAt }],
                runs: [{
                    triggerId,
                    causeKind,
                    causeTriggerKind,
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
            schedules: [],
            runs: [{
                triggerId: null,
                causeKind: "manual",
                causeTriggerKind: null,
                state: "outcome_uncertain",
                dueAt: new Date("2026-08-10T12:01:00.000Z"),
                leaseExpiresAt: null,
                executionDispatchState: "retryWaiting",
            }],
        })).toBeNull();
    });

    it("loads each frozen Run's Automation projection once without nesting its complete open-Run set", async () => {
        const dueAt = new Date("2026-08-10T12:01:00.000Z");
        dbMocks.runAssignments.mockResolvedValue([
            {
                machineId: "machine-1",
                priority: 2,
                run: {
                    id: "run-1",
                    automationId: "automation-1",
                    updatedAt: dueAt,
                    triggerId: null,
                    causeKind: "manual",
                    causeTriggerKind: null,
                    state: "queued",
                    dueAt,
                    leaseExpiresAt: null,
                    executionDispatchState: null,
                },
            },
            {
                machineId: "machine-1",
                priority: 1,
                run: {
                    id: "run-2",
                    automationId: "automation-1",
                    updatedAt: new Date(dueAt.getTime() + 1),
                    triggerId: null,
                    causeKind: "manual",
                    causeTriggerKind: null,
                    state: "queued",
                    dueAt: new Date(dueAt.getTime() + 1),
                    leaseExpiresAt: null,
                    executionDispatchState: null,
                },
            },
        ]);
        dbMocks.automations.mockResolvedValue([{
            id: "automation-1",
            accountId: "account-1",
            name: "Frozen assignment",
            description: null,
            enabled: false,
            targetType: "new_session",
            templateCiphertext: "{}",
            templateVersion: 1,
            lastRunAt: null,
            createdAt: dueAt,
            updatedAt: dueAt,
            assignments: [],
            triggers: [],
        }]);

        await expect(listDaemonAssignments({
            accountId: "account-1",
            machineId: "machine-1",
        })).resolves.toEqual([
            expect.objectContaining({
                automation: expect.objectContaining({ id: "automation-1" }),
                nextClaimAt: dueAt,
            }),
        ]);

        const runQuery = dbMocks.runAssignments.mock.calls[0]?.[0];
        expect(runQuery.select.run.select).toEqual(expect.objectContaining({
            automationId: true,
        }));
        expect(runQuery.select.run.select).not.toHaveProperty("automation");
        expect(dbMocks.automations).toHaveBeenCalledTimes(1);
        expect(dbMocks.automations).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: { in: ["automation-1"] }, accountId: "account-1" },
        }));
    });
});

describe("assertAutomationAssignmentLiveness", () => {
    it("requires an enabled Automation to own at least one enabled assignment", () => {
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [],
        })).toThrow(AutomationValidationError);
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [{ machineId: "m1", enabled: false }],
        })).toThrow(AutomationValidationError);
    });

    it("accepts enabled Automation with an enabled assignment and disabled drafts with none", () => {
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [
                { machineId: "m1", enabled: false },
                { machineId: "m2", enabled: true },
            ],
        })).not.toThrow();
        expect(() => assertAutomationAssignmentLiveness({
            enabled: false,
            assignments: [],
        })).not.toThrow();
        // Assignment enablement defaults to enabled, matching persistence.
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [{ machineId: "m1" }],
        })).not.toThrow();
    });

    it("dedupes repeated machineIds before counting enabled assignments", () => {
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [
                { machineId: "m1", enabled: true },
                // Persistence keeps the last entry per machineId, so the
                // disabled repeat must win the dedupe decision.
                { machineId: "m1", enabled: false },
            ],
        })).toThrow(AutomationValidationError);
        expect(() => assertAutomationAssignmentLiveness({
            enabled: true,
            assignments: [
                { machineId: "m1", enabled: false },
                { machineId: "m1", enabled: true },
            ],
        })).not.toThrow();
    });
});
