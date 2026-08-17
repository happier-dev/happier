import { describe, expect, it, vi } from "vitest";
import {
    AutomationRunExecutionInputV1Schema,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import {
    enqueueImmediateRunTx,
    enqueueNextScheduledRunIfMissingTx,
    resolveScheduledRunDueAt,
} from "./automationRunQueueService";

describe("resolveScheduledRunDueAt", () => {
    it("keeps schedule-based dueAt when nextRunAt is overdue", () => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        const dueAt = resolveScheduledRunDueAt({
            now,
            scheduleKind: "interval",
            everyMs: 60_000,
            scheduleExpr: null,
            timezone: null,
            nextRunAt: new Date("2026-02-12T09:59:00.000Z"),
        });
        expect(dueAt?.toISOString()).toBe("2026-02-12T10:01:00.000Z");
    });

    it("does not create a schedule run for a non-schedule trigger even when retained legacy schedule fields remain populated", async () => {
        const findFirst = vi.fn();
        const create = vi.fn();
        const update = vi.fn();

        await enqueueNextScheduledRunIfMissingTx({
            tx: {
                automation: {
                    findUnique: vi.fn(async () => ({
                        id: "automation-event",
                        accountId: "account",
                        enabled: true,
                        deletedAt: null,
                        triggerKind: "pluginEvent",
                        scheduleKind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                        nextRunAt: null,
                    })),
                    update,
                },
                automationRun: {
                    findFirst,
                    create,
                },
            } as any,
            automationId: "automation-event",
            now: new Date("2026-08-10T12:00:00.000Z"),
        });

        expect(findFirst).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("does not create a scheduled follow-up when no enabled claimant assignment remains", async () => {
        const now = new Date("2026-08-10T12:00:00.000Z");
        const findFirst = vi.fn();
        const create = vi.fn(async () => ({ scheduledAt: now }));
        const update = vi.fn();

        await enqueueNextScheduledRunIfMissingTx({
            tx: {
                automation: {
                    findUnique: vi.fn(async () => ({
                        id: "automation-unassigned",
                        accountId: "account",
                        enabled: true,
                        deletedAt: null,
                        triggerKind: "schedule",
                        scheduleKind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                        nextRunAt: null,
                        targetType: "new_session",
                        templateVersion: 1,
                        templateCiphertext: JSON.stringify({
                            kind: "happier_automation_template_encrypted_v1",
                            payloadCiphertext: "ciphertext-base64",
                        }),
                    })),
                    update,
                },
                automationAssignment: { findFirst: vi.fn(async () => null) },
                automationRun: { findFirst, create },
            } as any,
            automationId: "automation-unassigned",
            now,
        });

        expect(findFirst).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("persists run-now as a manual origin while retaining the legacy invocation timestamp", async () => {
        const now = new Date("2026-08-10T12:00:00.000Z");
        const recipe = {
            v: 1,
            templateVersion: 3,
            template: {
                t: "plain" as const,
                v: { v: 1, prompt: "run the frozen manual task" },
            },
            triggerEvidence: null,
            target: {
                kind: "executionRun" as const,
                request: {
                    intent: "task" as const,
                    backendTarget: { kind: "builtInAgent" as const, agentId: "codex" },
                    permissionMode: "read_only" as const,
                    retentionPolicy: "ephemeral" as const,
                    runClass: "bounded" as const,
                    ioMode: "request_response" as const,
                },
            },
        };
        const serialized = serializeAutomationRunExecutionRecipeV1(recipe);
        expect(serialized.kind).toBe("available");
        if (serialized.kind !== "available") return;
        const templateCiphertext = serialized.serialized;
        const create = vi.fn(async (_params: {
            data: { executionInputEnvelope: string };
        }) => ({
            id: "manual-run",
            automationId: "automation",
            accountId: "account",
            state: "queued",
            scheduledAt: now,
            dueAt: now,
            claimedAt: null,
            startedAt: null,
            finishedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            summaryCiphertext: null,
            errorCode: null,
            errorMessage: null,
            producedSessionId: null,
            createdAt: now,
            updatedAt: now,
        }));

        const run = await enqueueImmediateRunTx({
            tx: {
                automation: {
                    findFirst: vi.fn(async () => ({
                        targetType: "execution_run",
                        templateVersion: 3,
                        templateCiphertext,
                    })),
                },
                automationRun: { create },
            } as any,
            automationId: "automation",
            accountId: "account",
            now,
            occurrenceKey: "manual-occurrence-key",
        });

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                originKind: "manual",
                originOccurredAt: null,
                occurrenceKey: "manual-occurrence-key",
                scheduledAt: now,
                dueAt: now,
                executionInputEnvelope: serialized.serialized,
                executionDispatchState: "notStarted",
            }),
        }));
        expect(run.scheduledAt).toBe(now);
    });

    it("creates and suppresses only scheduled-origin queue rows", async () => {
        const now = new Date("2026-08-10T12:00:00.000Z");
        const dueAt = new Date("2026-08-10T12:01:00.000Z");
        const recipe = {
            v: 1,
            templateVersion: 4,
            template: {
                t: "plain" as const,
                v: { v: 1, prompt: "run the frozen scheduled task" },
            },
            triggerEvidence: null,
            target: {
                kind: "newSession" as const,
                spawn: {
                    executionTarget: { serverId: "server", machineId: "machine" },
                    directory: "/tmp/frozen-scheduled",
                    agentTarget: {
                        kind: "agent" as const,
                        identity: { pluginId: "happier.agent.codex", localId: "codex" },
                    },
                },
            },
        };
        const serialized = serializeAutomationRunExecutionRecipeV1(recipe);
        expect(serialized.kind).toBe("available");
        if (serialized.kind !== "available") return;
        const templateCiphertext = serialized.serialized;
        const findFirst = vi.fn(async () => null);
        const create = vi.fn(async () => ({
            id: "scheduled-run",
            automationId: "automation",
            accountId: "account",
            state: "queued",
            scheduledAt: now,
            dueAt,
            claimedAt: null,
            startedAt: null,
            finishedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            summaryCiphertext: null,
            errorCode: null,
            errorMessage: null,
            producedSessionId: null,
            createdAt: now,
            updatedAt: now,
        }));
        const update = vi.fn();

        await enqueueNextScheduledRunIfMissingTx({
            tx: {
                automation: {
                    findUnique: vi.fn(async () => ({
                        id: "automation",
                        accountId: "account",
                        enabled: true,
                        deletedAt: null,
                        triggerKind: "schedule",
                        scheduleKind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                        nextRunAt: null,
                        targetType: "new_session",
                        templateVersion: 4,
                        templateCiphertext,
                        assignments: [{ id: "assignment-current" }],
                    })),
                    update,
                },
                automationAssignment: { findFirst: vi.fn(async () => ({ id: "assignment-current" })) },
                automationRun: { findFirst, create },
            } as any,
            automationId: "automation",
            now,
        });

        expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                originKind: "scheduled",
            }),
        }));
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                originKind: "scheduled",
                originOccurredAt: null,
                scheduledAt: now,
                dueAt,
                executionInputEnvelope: serialized.serialized,
                executionDispatchState: null,
            }),
        }));
    });

    it("freezes the exact remote-dev V2 manual definition into the released Run input envelope", async () => {
        const now = new Date("2026-08-10T12:00:00.000Z");
        // This is the deployed remote-dev V2 Definition shape, not a current
        // strict execution recipe.
        const templateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext-base64",
        });
        const create = vi.fn(async (_params: {
            data: { executionInputEnvelope: string };
        }) => ({
            id: "manual-v2-run",
            automationId: "automation-v2",
            accountId: "account",
            state: "queued",
            scheduledAt: now,
            dueAt: now,
            claimedAt: null,
            startedAt: null,
            finishedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            summaryCiphertext: null,
            errorCode: null,
            errorMessage: null,
            producedSessionId: null,
            createdAt: now,
            updatedAt: now,
        }));

        await enqueueImmediateRunTx({
            tx: {
                automation: {
                    findFirst: vi.fn(async () => ({
                        targetType: "new_session",
                        templateVersion: 7,
                        templateCiphertext,
                    })),
                },
                automationRun: { create },
            } as any,
            automationId: "automation-v2",
            accountId: "account",
            now,
        });

        const executionInputEnvelope = create.mock.calls[0]?.[0]
            .data.executionInputEnvelope;
        expect(executionInputEnvelope).toBeDefined();
        const input = AutomationRunExecutionInputV1Schema.parse(JSON.parse(
            executionInputEnvelope!,
        ));
        expect(input).toEqual({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 7,
            templateCiphertext,
            origin: { kind: "manual", invokedAt: now.getTime() },
        });
    });

    it("freezes the exact remote-dev V2 scheduled definition before later Definition edits", async () => {
        const now = new Date("2026-08-10T12:00:00.000Z");
        const dueAt = new Date("2026-08-10T12:01:00.000Z");
        const templateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "ciphertext-base64",
        });
        const create = vi.fn(async (_params: {
            data: { executionInputEnvelope: string };
        }) => ({
            id: "scheduled-v2-run",
            automationId: "automation-v2",
            accountId: "account",
            state: "queued",
            scheduledAt: now,
            dueAt,
            claimedAt: null,
            startedAt: null,
            finishedAt: null,
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
            summaryCiphertext: null,
            errorCode: null,
            errorMessage: null,
            producedSessionId: null,
            createdAt: now,
            updatedAt: now,
        }));

        await enqueueNextScheduledRunIfMissingTx({
            tx: {
                automation: {
                    findUnique: vi.fn(async () => ({
                        id: "automation-v2",
                        accountId: "account",
                        enabled: true,
                        deletedAt: null,
                        triggerKind: "schedule",
                        scheduleKind: "interval",
                        scheduleExpr: null,
                        everyMs: 60_000,
                        timezone: null,
                        nextRunAt: null,
                        targetType: "new_session",
                        templateVersion: 8,
                        templateCiphertext,
                        assignments: [{ id: "assignment-current" }],
                    })),
                    update: vi.fn(),
                },
                automationAssignment: { findFirst: vi.fn(async () => ({ id: "assignment-current" })) },
                automationRun: {
                    findFirst: vi.fn(async () => null),
                    create,
                },
            } as any,
            automationId: "automation-v2",
            now,
        });

        const executionInputEnvelope = create.mock.calls[0]?.[0]
            .data.executionInputEnvelope;
        expect(executionInputEnvelope).toBeDefined();
        const input = AutomationRunExecutionInputV1Schema.parse(JSON.parse(
            executionInputEnvelope!,
        ));
        expect(input).toEqual(expect.objectContaining({
            targetType: "new_session",
            templateVersion: 8,
            templateCiphertext,
            origin: { kind: "scheduled", scheduledFor: dueAt.getTime() },
        }));
    });

    it.each([
        ["malformed legacy bytes", "not-json"],
        ["strict-like but invalid bytes", JSON.stringify({
            v: 1,
            templateVersion: 2,
            template: { t: "plain", v: { prompt: "not a valid recipe" } },
            target: { kind: "newSession" },
        })],
    ])("rejects %s before writing a Run", async (_label, templateCiphertext) => {
        const create = vi.fn();

        await expect(enqueueImmediateRunTx({
            tx: {
                automation: {
                    findFirst: vi.fn(async () => ({
                        targetType: "new_session",
                        templateVersion: 1,
                        templateCiphertext,
                    })),
                },
                automationRun: { create },
            } as any,
            automationId: "automation-invalid",
            accountId: "account",
            now: new Date("2026-08-10T12:00:00.000Z"),
        })).rejects.toThrow(/strict execution recipe|legacy definition/i);

        expect(create).not.toHaveBeenCalled();
    });
});
