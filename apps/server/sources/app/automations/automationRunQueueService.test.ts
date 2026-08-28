import { describe, expect, it, vi } from "vitest";
import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    parseAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";

vi.mock("@/storage/inTx", () => ({ afterTx: vi.fn() }));
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: vi.fn(async () => 1),
}));

import {
    admitDueAutomationScheduleTriggerTx,
    ensureAutomationScheduleCursorsTx,
    resolveScheduledRunDueAt,
} from "./automationRunQueueService";

function strictRecipe(params: Readonly<{
    templateVersion: number;
    prompt: string;
}>): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-run-queue",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") throw new Error("Test recipe did not serialize");
    return serialized.serialized;
}

function txFixture(params: Readonly<{
    recipe?: string;
    templateVersion?: number;
    assignments?: readonly (string | Readonly<{ machineId: string; priority: number }>)[];
    eventConversationRunCount?: number;
    triggers?: readonly Readonly<{
        id: string;
        revision: number;
        scheduleKind: "interval" | "cron";
        scheduleExpr: string | null;
        everyMs: number | null;
        timezone: string | null;
        nextRunAt: Date | null;
    }>[];
}> = {}) {
    let recipe = params.recipe ?? strictRecipe({ templateVersion: 1, prompt: "current recipe" });
    let templateVersion = params.templateVersion ?? 1;
    let assignments = (params.assignments ?? ["machine"]).map((assignment) => typeof assignment === "string"
        ? { machineId: assignment, priority: 0 }
        : assignment);
    const triggers = [...(params.triggers ?? [])];
    const created: Array<Record<string, unknown>> = [];
    const runAssignments: Array<Record<string, unknown>> = [];
    const triggerUpdates: Array<Record<string, unknown>> = [];
    const tx = {
        automation: {
            findUnique: vi.fn(async () => ({
                id: "automation",
                accountId: "account",
                enabled: true,
                deletedAt: null,
                triggers,
            })),
            findMany: vi.fn(async () => [{
                id: "automation",
                enabled: true,
                targetType: "new_session",
                templateVersion,
                templateCiphertext: recipe,
                assignments,
            }]),
            findFirst: vi.fn(async () => ({
                enabled: true,
                targetType: "new_session",
                templateVersion,
                templateCiphertext: recipe,
                assignments,
            })),
            update: vi.fn(async () => ({})),
        },
        automationTrigger: {
            findMany: vi.fn(async () => triggers.map((trigger) => ({
                ...trigger,
                automationId: "automation",
                enabled: true,
                deletedAt: null,
                kind: "schedule",
                eventPluginId: null,
                eventLocalId: null,
                sourceSelectorId: null,
                sessionLifecycleEvent: null,
                sourceSessionId: null,
                sourceTurnId: null,
            }))),
            findFirst: vi.fn(async ({ where }: { where: {
                id: string;
                revision?: number;
                nextRunAt?: Date;
            } }) => {
                const trigger = triggers.find((candidate) => candidate.id === where.id);
                if (
                    !trigger
                    || (where.revision !== undefined && trigger.revision !== where.revision)
                    || (where.nextRunAt instanceof Date
                        && trigger.nextRunAt?.getTime() !== where.nextRunAt.getTime())
                ) return null;
                return trigger
                    ? {
                        ...trigger,
                        automationId: "automation",
                        enabled: true,
                        deletedAt: null,
                        kind: "schedule",
                        automation: { accountId: "account" },
                    }
                    : null;
            }),
            updateMany: vi.fn(async (query: Record<string, unknown>) => {
                triggerUpdates.push(query);
                return { count: 1 };
            }),
        },
        automationRun: {
            count: vi.fn(async () => params.eventConversationRunCount ?? 0),
            findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => created.filter((run) => (
                (where.accountId === undefined || run.accountId === where.accountId)
                && (!Array.isArray(where.OR) || where.OR.some((discriminator: Record<string, unknown>) => (
                    Object.entries(discriminator).every(([key, value]) => run[key] === value)
                )))
            ))),
            findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => created.find((run) => {
                const state = run.state as string;
                return (
                    (where.triggerId === undefined || run.triggerId === where.triggerId)
                    && (where.causeTriggerKind === undefined || run.causeTriggerKind === where.causeTriggerKind)
                    && (where.occurrenceKey === undefined || run.occurrenceKey === where.occurrenceKey)
                    && (where.automationId === undefined || run.automationId === where.automationId)
                    && (where.legacyManualIdempotencyKey === undefined
                        || run.legacyManualIdempotencyKey === where.legacyManualIdempotencyKey)
                    && (!Array.isArray(where.state?.notIn) || !where.state.notIn.includes(state))
                );
            }) ?? null),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                const run = {
                    id: `run-${created.length + 1}`,
                    ...data,
                    createdAt: new Date("2026-08-27T12:00:00.000Z"),
                    updatedAt: new Date("2026-08-27T12:00:00.000Z"),
                };
                created.push(run);
                const nestedAssignments = (data.assignments as {
                    create?: Array<{ machineId: string; priority: number }>;
                } | undefined)?.create ?? [];
                runAssignments.push(...nestedAssignments.map((assignment) => ({
                    runId: run.id,
                    ...assignment,
                })));
                return run;
            }),
        },
    };
    return {
        tx: tx as any,
        created,
        runAssignments,
        triggerUpdates,
        editDefinition(next: Readonly<{
            recipe: string;
            templateVersion: number;
            assignments: readonly Readonly<{ machineId: string; priority: number }>[];
        }>) {
            recipe = next.recipe;
            templateVersion = next.templateVersion;
            assignments = [...next.assignments];
        },
        editTrigger(triggerId: string, next: Readonly<{ revision: number; nextRunAt: Date }>) {
            const index = triggers.findIndex((trigger) => trigger.id === triggerId);
            if (index < 0) throw new Error(`Unknown trigger ${triggerId}`);
            triggers[index] = { ...triggers[index]!, ...next };
        },
    };
}

describe("Automation Run queue admission", () => {
    it("computes the next interval occurrence without treating an overdue hint as authority", () => {
        const now = new Date("2026-08-27T12:00:00.000Z");
        expect(resolveScheduledRunDueAt({
            now,
            scheduleKind: "interval",
            everyMs: 60_000,
            scheduleExpr: null,
            timezone: null,
            nextRunAt: new Date("2026-08-27T11:59:00.000Z"),
        })?.toISOString()).toBe("2026-08-27T12:01:00.000Z");
    });

    it("initializes every schedule cursor without admitting a future Run", async () => {
        const fixture = txFixture({
            triggers: [
                {
                    id: "schedule-one",
                    revision: 3,
                    scheduleKind: "interval",
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                    nextRunAt: null,
                },
                {
                    id: "schedule-two",
                    revision: 8,
                    scheduleKind: "interval",
                    scheduleExpr: null,
                    everyMs: 120_000,
                    timezone: null,
                    nextRunAt: null,
                },
            ],
        });
        const now = new Date("2026-08-27T12:00:00.000Z");

        await ensureAutomationScheduleCursorsTx({
            tx: fixture.tx,
            automationId: "automation",
            now,
        });

        expect(fixture.created).toHaveLength(0);
        expect(fixture.triggerUpdates).toHaveLength(2);
        expect(fixture.triggerUpdates.map((update) => update.data)).toEqual([
            { nextRunAt: new Date("2026-08-27T12:01:00.000Z") },
            { nextRunAt: new Date("2026-08-27T12:02:00.000Z") },
        ]);
    });

    it("does not apply Event and Conversation capacity to a due schedule", async () => {
        const fixture = txFixture({
            eventConversationRunCount: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
            triggers: [{
                id: "schedule-at-capacity",
                revision: 4,
                scheduleKind: "interval",
                scheduleExpr: null,
                everyMs: 60_000,
                timezone: null,
                nextRunAt: new Date("2026-08-27T12:00:00.000Z"),
            }],
        });
        const now = new Date("2026-08-27T12:00:00.000Z");

        const result = await admitDueAutomationScheduleTriggerTx({
            tx: fixture.tx,
            triggerId: "schedule-at-capacity",
            expectedRevision: 4,
            expectedNextRunAt: now,
            now,
        });

        expect(result?.kind).toBe("admitted");
        expect(fixture.created[0]).toMatchObject({
            state: "queued",
            triggerId: "schedule-at-capacity",
            causeKind: "trigger",
            causeTriggerKind: "schedule",
            causeTriggerRevision: 4,
            executionDispatchState: null,
        });
        expect(fixture.triggerUpdates).toEqual([]);
    });

    it("freezes the due-time recipe and assignments and rejoins those bytes after later edits", async () => {
        const dueAt = new Date("2026-08-27T12:00:00.000Z");
        const fixture = txFixture({
            recipe: strictRecipe({ templateVersion: 1, prompt: "before due" }),
            templateVersion: 1,
            assignments: [{ machineId: "machine-before", priority: 1 }],
            triggers: [{
                id: "schedule-current",
                revision: 6,
                scheduleKind: "interval",
                scheduleExpr: null,
                everyMs: 60_000,
                timezone: null,
                nextRunAt: dueAt,
            }],
        });
        fixture.editDefinition({
            recipe: strictRecipe({ templateVersion: 2, prompt: "edited before admission" }),
            templateVersion: 2,
            assignments: [{ machineId: "machine-at-due", priority: 9 }],
        });

        const admitted = await admitDueAutomationScheduleTriggerTx({
            tx: fixture.tx,
            triggerId: "schedule-current",
            expectedRevision: 6,
            expectedNextRunAt: dueAt,
            now: dueAt,
        });
        const frozenEnvelope = fixture.created[0]?.executionInputEnvelope as string;
        expect(admitted?.kind).toBe("admitted");
        expect(parseAutomationRunExecutionRecipeV1(frozenEnvelope)).toMatchObject({
            kind: "available",
            recipe: { templateVersion: 2, assignmentMachineIds: ["machine-at-due"] },
        });

        fixture.editDefinition({
            recipe: strictRecipe({ templateVersion: 3, prompt: "edited after admission" }),
            templateVersion: 3,
            assignments: [{ machineId: "machine-after", priority: 2 }],
        });
        const rejoined = await admitDueAutomationScheduleTriggerTx({
            tx: fixture.tx,
            triggerId: "schedule-current",
            expectedRevision: 6,
            expectedNextRunAt: dueAt,
            now: new Date("2026-08-27T12:00:30.000Z"),
        });

        expect(rejoined?.kind).toBe("rejoined");
        expect(fixture.created).toHaveLength(1);
        expect(fixture.created[0]?.executionInputEnvelope).toBe(frozenEnvelope);
        expect(fixture.runAssignments).toEqual([{
            runId: "run-1",
            machineId: "machine-at-due",
            priority: 9,
        }]);
    });

    it("admits independent due occurrences for every schedule trigger", async () => {
        const dueAt = new Date("2026-08-27T12:00:00.000Z");
        const fixture = txFixture({
            triggers: [
                {
                    id: "schedule-one",
                    revision: 2,
                    scheduleKind: "interval",
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                    nextRunAt: dueAt,
                },
                {
                    id: "schedule-two",
                    revision: 5,
                    scheduleKind: "interval",
                    scheduleExpr: null,
                    everyMs: 120_000,
                    timezone: null,
                    nextRunAt: dueAt,
                },
            ],
        });

        for (const trigger of [{ id: "schedule-one", revision: 2 }, { id: "schedule-two", revision: 5 }]) {
            await admitDueAutomationScheduleTriggerTx({
                tx: fixture.tx,
                triggerId: trigger.id,
                expectedRevision: trigger.revision,
                expectedNextRunAt: dueAt,
                now: dueAt,
            });
        }

        expect(fixture.created.map((run) => run.triggerId)).toEqual(["schedule-one", "schedule-two"]);
    });

    it("suppresses an edited schedule cursor until the prior trigger Run is terminal", async () => {
        const firstDueAt = new Date("2026-08-27T12:00:00.000Z");
        const fixture = txFixture({
            triggers: [{
                id: "schedule-edited",
                revision: 1,
                scheduleKind: "interval",
                scheduleExpr: null,
                everyMs: 60_000,
                timezone: null,
                nextRunAt: firstDueAt,
            }],
        });
        await admitDueAutomationScheduleTriggerTx({
            tx: fixture.tx,
            triggerId: "schedule-edited",
            expectedRevision: 1,
            expectedNextRunAt: firstDueAt,
            now: firstDueAt,
        });

        const editedDueAt = new Date("2026-08-27T12:05:00.000Z");
        fixture.editTrigger("schedule-edited", { revision: 2, nextRunAt: editedDueAt });
        const suppressed = await admitDueAutomationScheduleTriggerTx({
            tx: fixture.tx,
            triggerId: "schedule-edited",
            expectedRevision: 2,
            expectedNextRunAt: editedDueAt,
            now: editedDueAt,
        });

        expect(suppressed).toBeNull();
        expect(fixture.created).toHaveLength(1);
    });

});
