import { randomUUID } from "node:crypto";
import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { automationPortableQueryChunks } from "./automationPortableQueryChunks";

function failRunCreate(automationId: string) {
    const mutable = db as any;
    const original = mutable.$transaction;
    mutable.$transaction = async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") return await Reflect.apply(original, mutable, args);
        return await Reflect.apply(original, mutable, [async (tx: any) => {
            const runs = new Proxy(tx.automationRun, {
                get(target, property, receiver) {
                    if (property !== "create") return Reflect.get(target, property, receiver);
                    return (...createArgs: unknown[]) => {
                        const query = createArgs[0] as { data?: { automationId?: unknown } } | undefined;
                        if (query?.data?.automationId === automationId) throw new Error("injected Run persistence crash");
                        return Reflect.apply(target.create, target, createArgs);
                    };
                },
            });
            return await operation(new Proxy(tx, {
                get(target, property, receiver) {
                    return property === "automationRun" ? runs : Reflect.get(target, property, receiver);
                },
            }));
        }, ...args.slice(1)]);
    };
    return () => { mutable.$transaction = original; };
}

describe("Session lifecycle Automation admission on SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-lifecycle-admission-",
            sqliteConnectionLimit: 2,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function source(params: Readonly<{
        agentId?: string;
        agentTurnId?: string;
    }> = {}) {
        const suffix = randomUUID();
        const account = await db.account.create({ data: { publicKey: `key-${suffix}`, encryptionMode: "plain" }, select: { id: true } });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `source-${suffix}`, encryptionMode: "plain", metadata: "{}" },
            select: { id: true },
        });
        const turnId = `turn-${suffix}`;
        await applySessionTurnMutation({
            actorUserId: account.id,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${suffix}`,
                action: "begin",
                turnId,
                observedAt: Date.now() - 1_000,
                agentId: params.agentId,
                agentTurnId: params.agentTurnId,
            },
        });
        return { accountId: account.id, sessionId: session.id, turnId, suffix };
    }

    async function trigger(params: Awaited<ReturnType<typeof source>> & {
        enabled?: boolean;
        triggerEnabled?: boolean;
        deleted?: boolean;
    }) {
        const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1({
            v: 1,
            templateVersion: 1,
            template: { t: "plain", v: { v: 1, prompt: "Exact turn" } },
            triggerEvidence: null,
            target: {
                kind: "newSession",
                spawn: {
                    executionTarget: { serverId: `server-${params.suffix}`, machineId: `machine-${params.suffix}` },
                    directory: "/tmp/exact-turn",
                    agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
                },
            },
        });
        if (recipe.kind !== "available") throw new Error("Recipe unavailable");
        const automation = await db.automation.create({
            data: {
                accountId: params.accountId,
                name: "Exact turn",
                enabled: params.enabled ?? true,
                targetType: "new_session",
                templateCiphertext: recipe.serialized,
                templateVersion: 1,
            },
            select: { id: true },
        });
        return await db.automationTrigger.create({
            data: {
                automationId: automation.id,
                kind: "sessionLifecycle",
                revision: 1,
                ...(params.deleted
                    ? {
                        enabled: false,
                        deletedAt: new Date(),
                        sessionLifecycleEvent: null,
                        sourceSessionId: null,
                        sourceTurnId: null,
                    }
                    : {
                        enabled: params.triggerEnabled ?? true,
                        deletedAt: null,
                        sessionLifecycleEvent: "parentTurnCompleted" as const,
                        sourceSessionId: params.sessionId,
                        sourceTurnId: params.turnId,
                    }),
            },
            select: { id: true, automationId: true },
        });
    }

    it("creates one Run per trigger and replay creates none additional", async () => {
        const current = await source();
        const first = await trigger(current);
        const second = await trigger({ ...current, suffix: `${current.suffix}-2` });
        const completedAt = Date.now();
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: { v: 1, sessionId: current.sessionId, mutationId: `complete-${current.suffix}`, action: "complete", turnId: current.turnId, observedAt: completedAt },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.automationRun.count({ where: { triggerId: { in: [first.id, second.id] } } })).resolves.toBe(2);
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: { v: 1, sessionId: current.sessionId, mutationId: `replay-${current.suffix}`, action: "complete", turnId: current.turnId, observedAt: completedAt + 1 },
        })).resolves.toMatchObject({ ok: true, didApply: false });
        await expect(db.automationRun.count({ where: { triggerId: { in: [first.id, second.id] } } })).resolves.toBe(2);
    });

    it("admits every eligible exact-turn sibling outside Event and Conversation capacity", async () => {
        const current = await source();
        const triggers = [
            await trigger(current),
            await trigger({ ...current, suffix: `${current.suffix}-2` }),
        ].sort((left, right) => left.id.localeCompare(right.id));
        const now = new Date();
        const occupiedRuns = Array.from(
            { length: MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT - 1 },
            (_, index) => ({
                id: `exact-turn-capacity-${index}`,
                automationId: triggers[0]!.automationId,
                accountId: current.accountId,
                state: "queued" as const,
                causeKind: "conversation" as const,
                causeOccurredAt: now,
                occurrenceKey: `exact-turn-capacity-occurrence-${index}`,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                executionInputEnvelope: "{}",
                replyContextEnvelope: "{}",
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation-result-deliver-v1",
                replyHandoffTargetMachineId: "capacity-machine",
                replyHandoffTargetMachineInstallationId: "capacity-installation",
                replyHandoffTargetMaterializationId: "capacity-materialization",
                replyHandoffId: `exact-turn-capacity-handoff-${index}`,
                replyHandoffState: "awaitingResult" as const,
                scheduledAt: now,
                dueAt: now,
            }),
        );
        for (const chunk of automationPortableQueryChunks({
            values: occupiedRuns,
            bindingsPerValue: 20,
        })) {
            await db.automationRun.createMany({ data: [...chunk] });
        }

        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `complete-capacity-${current.suffix}`,
                action: "complete",
                turnId: current.turnId,
                observedAt: now.getTime(),
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        await expect(db.automationRun.findMany({
            where: { triggerId: { in: triggers.map((item) => item.id) } },
            orderBy: { triggerId: "asc" },
            select: { triggerId: true, state: true, errorCode: true, executionDispatchState: true },
        })).resolves.toEqual([
            {
                triggerId: triggers[0]!.id,
                state: "queued",
                errorCode: null,
                executionDispatchState: null,
            },
            {
                triggerId: triggers[1]!.id,
                state: "queued",
                errorCode: null,
                executionDispatchState: null,
            },
        ]);
    });

    it("rolls back settlement on Run persistence crash and admits once on retry", async () => {
        const current = await source();
        const created = await trigger(current);
        const mutation = { v: 1 as const, sessionId: current.sessionId, mutationId: `complete-${current.suffix}`, action: "complete" as const, turnId: current.turnId, observedAt: Date.now() };
        const restore = failRunCreate(created.automationId);
        try {
            await expect(applySessionTurnMutation({ actorUserId: current.accountId, mutation })).resolves.toEqual({ ok: false, error: "internal" });
        } finally { restore(); }
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: current.sessionId, turnId: current.turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: "in_progress" });
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
        await expect(applySessionTurnMutation({ actorUserId: current.accountId, mutation })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(1);
    });

    it.each(["fail", "cancel", "end_session"] as const)("%s creates no Run", async (action) => {
        const current = await source();
        const created = await trigger(current);
        const observedAt = Date.now();
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `${action}-${current.suffix}`,
                action,
                turnId: current.turnId,
                observedAt,
                ...(action === "fail" ? { issue: {
                    v: 1 as const,
                    scope: "primary_session" as const,
                    status: "failed" as const,
                    code: "opencode_prompt_submission_failed" as const,
                    source: "agent_session_error" as const,
                    occurredAt: observedAt,
                    provider: "opencode",
                    sanitizedPreview: "test",
                } } : {}),
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
    });

    it("keeps a failed exact turn terminal and never admits it", async () => {
        const current = await source();
        const created = await trigger(current);
        const failedAt = Date.now();
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `fail-${current.suffix}`,
                action: "fail",
                turnId: current.turnId,
                observedAt: failedAt,
                issue: {
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "opencode_prompt_submission_failed",
                    source: "agent_session_error",
                    occurredAt: failedAt,
                    provider: "opencode",
                    sanitizedPreview: "test",
                },
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `recover-begin-${current.suffix}`,
                action: "begin",
                turnId: current.turnId,
                observedAt: failedAt + 1,
            },
        })).resolves.toMatchObject({ ok: true, didApply: false });
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `recover-complete-${current.suffix}`,
                action: "complete",
                turnId: current.turnId,
                observedAt: failedAt + 2,
            },
        })).resolves.toMatchObject({ ok: true, didApply: false });
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
    });

    it.each([
        { enabled: false, triggerEnabled: true, deleted: false },
        { enabled: true, triggerEnabled: false, deleted: false },
        { enabled: true, triggerEnabled: true, deleted: true },
    ])("never backfills membership missed at terminal commit", async (state) => {
        const current = await source();
        const created = await trigger({ ...current, ...state });
        const observedAt = Date.now();
        await applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: { v: 1, sessionId: current.sessionId, mutationId: `complete-${current.suffix}`, action: "complete", turnId: current.turnId, observedAt },
        });
        await db.automation.update({ where: { id: created.automationId }, data: { enabled: true } });
        if (!state.deleted) {
            await db.automationTrigger.update({ where: { id: created.id }, data: { enabled: true } });
        }
        await applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: { v: 1, sessionId: current.sessionId, mutationId: `replay-${current.suffix}`, action: "complete", turnId: current.turnId, observedAt: observedAt + 1 },
        });
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
    });
});
