import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import {
    MAX_NON_TERMINAL_EVENT_CONVERSATION_RUNS_PER_ACCOUNT,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2,
    sealWorkflowCheckpointStoredEnvelopeV1,
    AutomationRunCauseSchema,
    deriveAutomationManualOccurrenceKeyV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
} from "@happier-dev/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    applySessionTurnMutation as applySessionTurnMutationWithAuthentication,
    updateSessionAgentState,
} from "@/app/session/sessionWriteService";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedPluginInstallationPublisherHeader } from "@/testkit/pluginInstallationPublisherTestkit";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionArchiveRoutes } from "@/app/api/routes/session/registerSessionArchiveRoutes";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";

import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
import { admitSessionLifecycleAutomationRunsTx } from "./automationSessionLifecycleAdmission";
import { encodeAutomationSessionLifecycleConfiguration } from "./automationSessionLifecycleConfigurationCodec";
import { claimAutomationRun } from "./automationClaimService";
import { admitDueAutomationScheduleTriggerTx } from "./automationRunQueueService";
import { failAutomationRun } from "./automationRunService";
import { validateSessionLifecycleTriggerRegistrationTx } from "./automationSessionLifecycleRegistration";
import { encodeAutomationRunCause } from "./automationRunCauseCodec";

const authentication = createPresentUserSessionAccessAuthentication();

function applySessionTurnMutation(
    params: Omit<Parameters<typeof applySessionTurnMutationWithAuthentication>[0], "authentication">,
) {
    return applySessionTurnMutationWithAuthentication({ ...params, authentication });
}

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

/**
 * Injects one canonical occurrence-uniqueness collision on the first Run
 * insert for an Automation. The database unique constraint is the admission
 * concurrency owner, so a concurrent winner must restart the settlement
 * transaction and rejoin rather than failing terminal Session settlement.
 */
function failFirstRunCreateWithOccurrenceConflict(automationId: string) {
    const mutable = db as any;
    const original = mutable.$transaction;
    let injected = false;
    mutable.$transaction = async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") return await Reflect.apply(original, mutable, args);
        return await Reflect.apply(original, mutable, [async (tx: any) => {
            const runs = new Proxy(tx.automationRun, {
                get(target, property, receiver) {
                    if (property !== "create") return Reflect.get(target, property, receiver);
                    return (...createArgs: unknown[]) => {
                        const query = createArgs[0] as { data?: { automationId?: unknown } } | undefined;
                        if (!injected && query?.data?.automationId === automationId) {
                            injected = true;
                            throw Object.assign(new Error("Unique constraint failed"), {
                                code: "P2002",
                                meta: { target: ["automationId", "occurrenceKey"] },
                            });
                        }
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
    return {
        restore: () => { mutable.$transaction = original; },
        didInject: () => injected,
    } as const;
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
        initiator?: "user" | "agent_session" | "host" | "workflow";
        /** An E2EE Account whose content-key binding is absent is not current. */
        inconsistentE2ee?: boolean;
    }> = {}) {
        const suffix = randomUUID();
        const account = await db.account.create({
            data: params.inconsistentE2ee === true
                ? {
                    publicKey: createSignedAccountContentBinding().publicKey,
                    encryptionMode: "e2ee",
                }
                : { publicKey: `key-${suffix}`, encryptionMode: "plain" },
            select: { id: true },
        });
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
                initiator: params.initiator ?? "user",
                workDepth: 2,
                ...(params.initiator === "workflow" ? {
                    workflowInvocation: { runId: `run-${suffix}`, invocationRecordId: `invocation-${suffix}` },
                } : {}),
            },
        });
        return { accountId: account.id, sessionId: session.id, turnId, suffix };
    }

    async function trigger(params: Awaited<ReturnType<typeof source>> & {
        enabled?: boolean;
        triggerEnabled?: boolean;
        deleted?: boolean;
        scoped?: boolean;
        workflow?: boolean;
        events?: Array<"parentTurnCompleted" | "parentTurnFailed" | "parentTurnCancelled" | "userActionRequired">;
        policy?:
            | { kind: "currentTurn"; sourceTurnId: string }
            | { kind: "firstMatch" }
            | { kind: "nextMatches"; count: number }
            | { kind: "everyMatch" };
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
                    directory: { kind: "path", path: "/tmp/exact-turn" },
                    agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
                },
            },
        });
        if (recipe.kind !== "available") throw new Error("Recipe unavailable");
        const workflowRecipe = params.workflow ? serializeAutomationStoredWorkflowDefinitionRecipeV2({
            v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/tmp/exact-turn" }, executionTarget: { kind: "session" } } },
        }) : null;
        if (workflowRecipe?.kind === "contentInvalid") throw new Error("Workflow recipe unavailable");
        const automation = await db.automation.create({
            data: {
                accountId: params.accountId,
                name: "Exact turn",
                enabled: params.enabled ?? true,
                targetType: params.workflow ? null : "new_session",
                templateCiphertext: workflowRecipe?.serialized ?? recipe.serialized,
                templateVersion: 1,
                ...(params.workflow ? { workflowDefinitionId: "builtin:keep-going" } : {}),
                ...(params.scoped ? { scopeSessionId: params.sessionId } : {}),
            },
            select: { id: true },
        });
        // Assignment-liveness: canonical admission refuses an enabled
        // Automation whose execution-assignment set is empty.
        const executionMachineId = `execution-${randomUUID()}`;
        await db.machine.create({
            data: { id: executionMachineId, accountId: params.accountId, metadata: "{}" },
        });
        await db.automationAssignment.create({
            data: {
                automationId: automation.id,
                machineId: executionMachineId,
                enabled: true,
            },
        });
        const lifecycle = encodeAutomationSessionLifecycleConfiguration({
            kind: "sessionLifecycle",
            sourceSessionId: params.sessionId,
            events: params.events ?? ["parentTurnCompleted"],
            policy: params.policy ?? { kind: "currentTurn", sourceTurnId: params.turnId },
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
                        sessionLifecycleEventsJson: null,
                        sessionLifecyclePolicyKind: null,
                        sessionLifecycleMatchCount: null,
                        remainingOccurrences: null,
                        sourceSessionId: null,
                        sourceTurnId: null,
                    }
                    : {
                        enabled: params.triggerEnabled ?? true,
                        deletedAt: null,
                        ...lifecycle,
                    }),
            },
            select: { id: true, automationId: true },
        });
    }

    it.each(["user", "agent_session", "host", "workflow"] as const)(
        "admits needs-you for %s turns but reserves turn-end occurrences only for user and agent-session turns",
        async (initiator) => {
            const current = await source({ initiator });
            const terminal = await trigger({ ...current, policy: { kind: "firstMatch" } });
            const needsYou = await trigger({ ...current, events: ["userActionRequired"], policy: { kind: "everyMatch" } });
            await expect(updateSessionAgentState({
                actorUserId: current.accountId, sessionId: current.sessionId,
                expectedVersion: 0, agentStateCiphertext: "{}",
                userActionRequiredOccurrences: [{ sourceTurnId: current.turnId,
                    requestId: `request-${current.suffix}`, requestKind: "permission", occurredAt: Date.now() }],
            })).resolves.toMatchObject({ ok: true });
            await expect(db.automationRun.count({ where: { triggerId: needsYou.id } })).resolves.toBe(1);
            await expect(applySessionTurnMutation({
                actorUserId: current.accountId,
                mutation: { v: 1, sessionId: current.sessionId, turnId: current.turnId,
                    action: "complete", mutationId: `complete-${current.suffix}`, observedAt: Date.now() },
            })).resolves.toMatchObject({ ok: true, didApply: true });
            const fires = initiator === "user" || initiator === "agent_session";
            await expect(db.automationRun.count({ where: { triggerId: terminal.id } })).resolves.toBe(fires ? 1 : 0);
            await expect(db.automationTrigger.findUniqueOrThrow({ where: { id: terminal.id } }))
                .resolves.toMatchObject({ remainingOccurrences: fires ? 0 : 1 });
        },
    );

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

    it("suppresses an ancestor trigger's own needs-you event before consuming its budget, while unrelated and later user events still fire", async () => {
        const current = await source();
        const origin = await trigger({ ...current, events: ["userActionRequired"], policy: { kind: "firstMatch" } });
        const unrelated = await trigger({ ...current, events: ["userActionRequired"], policy: { kind: "everyMatch" } });
        // The accepted Run predates the trigger's edit to firstMatch; identity, not revision, prevents the loop.
        await db.automationTrigger.update({ where: { id: origin.id }, data: { revision: 2 } });
        const parent = await db.automationRun.create({ data: {
            accountId: current.accountId, automationId: origin.automationId,
            scheduledAt: new Date(), dueAt: new Date(), state: "running",
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({
                kind: "trigger", triggerKind: "sessionLifecycle", triggerId: origin.id, triggerRevision: 1,
                occurrenceKey: deriveAutomationManualOccurrenceKeyV1({ automationId: origin.automationId, idempotencyKey: `origin-${current.suffix}` }), occurredAt: Date.now(), evidence: {
                    event: "userActionRequired", sourceSessionId: current.sessionId, sourceTurnId: current.turnId,
                    requestId: "initial-request", requestKind: "permission", policy: { kind: "everyMatch" },
                },
            })),
        } });
        const bridge = await db.automationTrigger.create({ data: {
            automationId: origin.automationId, kind: "runLifecycle", sourceRunId: parent.id,
            remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: "runLifecycle",
                source: { kind: "workflow_run", runId: parent.id }, condition: "terminal" }),
        } });
        const descendant = await db.automationRun.create({ data: {
            accountId: current.accountId, automationId: origin.automationId,
            scheduledAt: new Date(), dueAt: new Date(), state: "running",
            workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({
                kind: "trigger", triggerKind: "runLifecycle", triggerId: bridge.id, triggerRevision: 1,
                occurrenceKey: deriveAutomationManualOccurrenceKeyV1({ automationId: origin.automationId, idempotencyKey: `descendant-${current.suffix}` }), occurredAt: Date.now(),
                evidence: { source: { kind: "workflow_run", runId: parent.id }, condition: "terminal", sourceRevision: 0 },
            })),
        } });
        await applySessionTurnMutation({ actorUserId: current.accountId, mutation: {
            v: 1, sessionId: current.sessionId, turnId: current.turnId, action: "complete",
            mutationId: `complete-${current.suffix}`, observedAt: Date.now(),
        } });
        const workflowTurnId = `workflow-${current.suffix}`;
        await applySessionTurnMutation({ actorUserId: current.accountId, mutation: {
            v: 1, sessionId: current.sessionId, turnId: workflowTurnId, action: "begin",
            mutationId: `begin-workflow-${current.suffix}`, observedAt: Date.now(), initiator: "workflow", workDepth: 2,
            workflowInvocation: { runId: descendant.id, invocationRecordId: "step" },
        } });
        const fire = (requestId: string, turnId: string) => inTx(tx => admitSessionLifecycleAutomationRunsTx({ tx, accountId: current.accountId,
            occurrence: { v: 1, kind: "sessionLifecycle", event: "userActionRequired", sourceSessionId: current.sessionId,
                sourceTurnId: turnId, requestId, requestKind: "permission", occurredAt: Date.now() } }));
        await fire("workflow-request", workflowTurnId);
        expect(await db.automationRun.count({ where: { triggerId: origin.id } })).toBe(1);
        expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: origin.id } })).remainingOccurrences).toBe(1);
        expect(await db.automationRun.count({ where: { triggerId: unrelated.id } })).toBe(1);
        await applySessionTurnMutation({ actorUserId: current.accountId, mutation: {
            v: 1, sessionId: current.sessionId, turnId: workflowTurnId, action: "complete",
            mutationId: `complete-workflow-${current.suffix}`, observedAt: Date.now(),
        } });
        const userTurnId = `user-${current.suffix}`;
        await applySessionTurnMutation({ actorUserId: current.accountId, mutation: {
            v: 1, sessionId: current.sessionId, turnId: userTurnId, action: "begin",
            mutationId: `begin-user-${current.suffix}`, observedAt: Date.now(), initiator: "user", workDepth: 0,
        } });
        await fire("user-request", userTurnId);
        expect(await db.automationRun.count({ where: { triggerId: origin.id } })).toBe(2);
    });

    it("coalesces scoped pending firings without reserving another bounded occurrence, then claims the newest after active completion", async () => {
        const current = await source();
        const attached = await trigger({ ...current, scoped: true, policy: { kind: "nextMatches", count: 2 } });
        const assignment = await db.automationAssignment.findFirstOrThrow({ where: { automationId: attached.automationId } });
        const complete = async (turnId: string, observedAt: number) => {
            await expect(applySessionTurnMutation({ actorUserId: current.accountId,
                mutation: { v: 1, sessionId: current.sessionId, turnId, action: "complete",
                    mutationId: `complete-${turnId}`, observedAt },
            })).resolves.toMatchObject({ ok: true, didApply: true });
        };
        const at = Date.now();
        await complete(current.turnId, at);
        const active = await claimAutomationRun({ accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000 });
        expect(active.run?.triggerId).toBe(attached.id);
        for (const [index, name] of ["B", "C"].entries()) {
            const turnId = `${name}-${current.suffix}`;
            await expect(applySessionTurnMutation({ actorUserId: current.accountId,
                mutation: { v: 1, sessionId: current.sessionId, turnId, action: "begin", initiator: "user", workDepth: 0,
                    mutationId: `begin-${turnId}`, observedAt: at + index * 2 + 1 },
            })).resolves.toMatchObject({ ok: true, didApply: true });
            await complete(turnId, at + index * 2 + 2);
        }
        const rows = await db.automationRun.findMany({ where: { triggerId: attached.id } });
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.causeSourceTurnId === `B-${current.suffix}`))
            .toMatchObject({ state: "skipped", errorCode: "superseded_by_newer_occurrence" });
        const newest = rows.find((row) => row.causeSourceTurnId === `C-${current.suffix}`)!;
        expect(newest.state).toBe("queued");
        expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: attached.id } })).remainingOccurrences).toBe(0);
        // Make queued work due; occurrence timestamps above are deliberately monotonic test data.
        await db.automationRun.update({ where: { id: newest.id }, data: { dueAt: new Date(0) } });
        expect((await claimAutomationRun({ accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000 })).run).toBeNull();
        // The external execution boundary settles the incumbent; no later turn is needed to release C.
        const checkpointEnvelope = JSON.stringify(sealWorkflowCheckpointStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId: current.accountId, runId: active.run!.id },
            checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: 'review-root', nextSequence: '1',
                frontier: { nextBlockOrdinal: 0, paused: false } },
        }));
        await db.automationRun.update({ where: { id: active.run!.id }, data: {
            state: "succeeded", finishedAt: new Date(), workflowCheckpointEnvelope: checkpointEnvelope,
        } });
        const machineInstallationId = randomUUID();
        await db.machine.update({ where: { id: assignment.machineId }, data: { installationId: machineInstallationId } });
        const claimParams = { accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000,
            claimRequest: { machineInstallationId, nonce: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } };
        const next = await claimAutomationRun(claimParams);
        expect(next.run?.id).toBe(newest.id);
        expect(next.run).toMatchObject({ lastSucceededRun: { runId: active.run!.id, checkpointEnvelope } });
        const receipt = await db.automationWorkerClaimReceipt.findFirstOrThrow({ where: { accountId: current.accountId } });
        expect(JSON.parse(receipt.claimResultJson).run.lastSucceededRun)
            .toEqual({ runId: active.run!.id, checkpointEnvelope: null });
        expect((await claimAutomationRun(claimParams)).receiptReplay?.run)
            .toMatchObject({ id: newest.id, lastSucceededRun: { runId: active.run!.id, checkpointEnvelope } });
    });

    it("suppresses signed host archive origin, retains ancestry for unrelated triggers, and refuses an unsigned origin claim", async () => {
        const current = await source();
        const own = await trigger({ ...current, workflow: true, policy: { kind: "firstMatch" } });
        const unrelated = await trigger({ ...current, workflow: true, policy: { kind: "firstMatch" } });
        await db.automationTrigger.updateMany({ where: { id: { in: [own.id, unrelated.id] } },
            data: { sessionLifecycleEventsJson: '["sessionArchived"]' } });
        const root = await db.automationRun.create({ data: { accountId: current.accountId, automationId: own.automationId,
            state: "running", scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
            workflowAcceptedSnapshotEnvelope: "{}", ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({
                kind: "trigger", triggerKind: "schedule", triggerId: own.id, triggerRevision: 1, occurredAt: 100,
                evidence: { scheduledFor: 100 }, occurrenceKey: deriveAutomationManualOccurrenceKeyV1({
                    automationId: own.automationId, idempotencyKey: randomUUID(),
                }),
            })) } });
        const assignment = await db.automationAssignment.findFirstOrThrow({ where: { automationId: own.automationId } });
        const keyPair = tweetnacl.sign.keyPair();
        const installationId = randomUUID();
        await db.machine.update({ where: { id: assignment.machineId },
            data: { installationId, installationPublicKey: keyPair.publicKey } });
        await db.automationRunAssignment.create({ data: { runId: root.id, machineId: assignment.machineId } });
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async (app) => {
            const url = `/v2/sessions/${current.sessionId}/archive`;
            const body = { originRunId: root.id };
            const headers = { "x-test-user-id": current.accountId };
            expect((await app.inject({ method: "POST", url, payload: body, headers })).statusCode).toBe(403);
            expect((await db.session.findUniqueOrThrow({ where: { id: current.sessionId } })).archivedAt).toBeNull();
            const signed = createSignedPluginInstallationPublisherHeader({ keyPair, machineId: assignment.machineId,
                installationId, path: url, body });
            expect((await app.inject({ method: "POST", url, payload: body,
                headers: { ...headers, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: signed } })).statusCode).toBe(200);
            expect(await db.automationRun.count({ where: { triggerId: own.id } })).toBe(1);
            expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: own.id } })).remainingOccurrences).toBe(1);
            const descendant = await db.automationRun.findFirstOrThrow({ where: { triggerId: unrelated.id } });
            expect(JSON.parse(descendant.triggerEvidenceEnvelope!)).toMatchObject({ originRunId: root.id, evidence: null });
        });
    });

    it("admits archive triggers only on archive transitions through the HTTP owner and rolls back archive when admission fails", async () => {
        const current = await source();
        const attached = await trigger({ ...current, scoped: true, policy: { kind: "everyMatch" } });
        await db.automationTrigger.update({ where: { id: attached.id }, data: { sessionLifecycleEventsJson: '["sessionArchived"]' } });
        await withAuthenticatedTestApp(registerSessionArchiveRoutes, async (app) => {
            const post = (action: string) => app.inject({ method: "POST", url: `/v2/sessions/${current.sessionId}/${action}`,
                headers: { "x-test-user-id": current.accountId } });
            const restore = failRunCreate(attached.automationId);
            try {
                expect((await post("archive")).statusCode).toBe(500);
                expect((await db.session.findUniqueOrThrow({ where: { id: current.sessionId } })).archivedAt).toBeNull();
            } finally { restore(); }
            expect((await post("archive")).statusCode).toBe(200);
            const admitted = await db.automationRun.findMany({ where: { triggerId: attached.id } });
            expect(admitted).toHaveLength(1);
            expect(admitted[0]).toMatchObject({ causeSessionLifecycleEvent: "sessionArchived", causeSourceTurnId: null });
            expect((await post("archive")).statusCode).toBe(200);
            expect((await post("unarchive")).statusCode).toBe(200);
            expect(await db.automationRun.count({ where: { triggerId: attached.id } })).toBe(1);
        });
    });

    it("settles a claimed workflow refusal as skipped without starting custody or producing effects", async () => {
        const current = await source();
        const attached = await trigger({ ...current, scoped: true });
        await applySessionTurnMutation({ actorUserId: current.accountId, mutation: {
            v: 1, sessionId: current.sessionId, turnId: current.turnId, mutationId: `complete-${current.suffix}`,
            action: "complete", observedAt: Date.now(),
        } });
        const assignment = await db.automationAssignment.findFirstOrThrow({ where: { automationId: attached.automationId } });
        const claimed = await claimAutomationRun({ accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000 });
        expect(claimed.run).not.toBeNull();
        // The database boundary supplies the workflow custody shape; the real refusal settlement remains under test.
        await db.automationRun.update({ where: { id: claimed.run!.id }, data: { workflowCustodyState: "pending" } });
        const settled = await failAutomationRun({ accountId: current.accountId, machineId: assignment.machineId,
            runId: claimed.run!.id, attempt: claimed.run!.attempt, accountCurrentness: claimed.accountCurrentness!,
            terminalState: "skipped", errorCode: "diff_unchanged",
        });
        expect(settled).toMatchObject({ state: "skipped", workflowCustodyState: "settled", startedAt: null,
            producedSessionId: null, workflowAcceptedSnapshotEnvelope: null, errorCode: "diff_unchanged" });
        expect(await db.automationRunEvent.count({ where: { runId: claimed.run!.id, type: "run_skipped" } })).toBe(1);
    });

    it("refuses late sessionStarted registration at the canonical server owner", async () => {
        const current = await source();
        await expect(inTx((tx) => validateSessionLifecycleTriggerRegistrationTx({
            tx, accountId: current.accountId, automationTargetType: "new_session",
            input: { kind: "sessionLifecycle", enabled: true,
                sourceSessionId: current.sessionId, events: ["sessionStarted"], policy: { kind: "firstMatch" } },
        }))).rejects.toMatchObject({ code: "session_already_started" });
    });

    it.each([
        { scoped: true, workflow: false, noTurn: false },
        { scoped: true, workflow: true, noTurn: true },
        { scoped: false, workflow: false, noTurn: true },
        { scoped: false, workflow: true, noTurn: false },
    ])("settles deleted-source queued work at claim without effects (scoped=$scoped, workflow=$workflow, noTurn=$noTurn)", async ({ scoped, workflow, noTurn }) => {
        const current = await source();
        const attached = await trigger({ ...current, scoped, workflow, policy: { kind: "everyMatch" } });
        const assignment = await db.automationAssignment.findFirstOrThrow({ where: { automationId: attached.automationId } });
        if (noTurn) {
            await db.automationTrigger.update({ where: { id: attached.id }, data: { sessionLifecycleEventsJson: '["sessionArchived"]' } });
            await inTx((tx) => admitSessionLifecycleAutomationRunsTx({ tx, accountId: current.accountId,
                occurrence: { v: 1, kind: "sessionLifecycle", event: "sessionArchived",
                    sourceSessionId: current.sessionId, occurredAt: Date.now() },
            }));
        } else await applySessionTurnMutation({ actorUserId: current.accountId,
            mutation: { v: 1, sessionId: current.sessionId, turnId: current.turnId, action: "complete",
                mutationId: `complete-delete-${current.suffix}`, observedAt: Date.now() } });
        const admitted = await db.automationRun.findFirstOrThrow({ where: { triggerId: attached.id } });
        await expect(deleteOwnedSession({ sessionId: current.sessionId, ownerAccountId: current.accountId, reason: "user_request" }))
            .resolves.toEqual({ ok: true });
        const retired = await db.automation.findUniqueOrThrow({ where: { id: attached.automationId } });
        expect(retired.deletedAt !== null).toBe(scoped);
        expect(retired.enabled).toBe(!scoped);
        expect(await db.automationRun.count({ where: { triggerId: attached.id } })).toBe(1);
        // Deletion retires the definition, but queued history is disposed only at claim.
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: admitted.id } }))
            .toMatchObject({ state: "queued", errorCode: null, attempt: 0,
                workflowCustodyState: workflow ? "pending" : null });
        const machineInstallationId = randomUUID();
        await db.machine.update({ where: { id: assignment.machineId }, data: { installationId: machineInstallationId } });
        const claimParams = { accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000,
            claimRequest: { machineInstallationId, nonce: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } };
        await expect(claimAutomationRun(claimParams)).resolves.toMatchObject({ run: null });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: admitted.id } }))
            .toMatchObject({ state: "failed", errorCode: "source_unavailable", attempt: 0,
                workflowCustodyState: workflow ? "settled" : null, startedAt: null, claimedAt: null,
                producedSessionId: null, workflowAcceptedSnapshotEnvelope: null });
        expect(await db.automationRunEvent.findMany({ where: { runId: admitted.id, type: "run_failed" } }))
            .toMatchObject([{ payload: { errorCode: "source_unavailable" } }]);
        // The signed no-work result and terminal event remain exact on retry.
        await expect(claimAutomationRun(claimParams)).resolves.toMatchObject({ run: null });
        expect(await db.automationRunEvent.count({ where: { runId: admitted.id, type: "run_failed" } })).toBe(1);
    });

    it("settles queued scoped schedule work when its session disappears, without guessing a lifecycle depth", async () => {
        const current = await source();
        const attached = await trigger({ ...current, scoped: true, workflow: true });
        const assignment = await db.automationAssignment.findFirstOrThrow({ where: { automationId: attached.automationId } });
        const now = new Date();
        const schedule = await db.automationTrigger.create({ data: { automationId: attached.automationId,
            kind: "schedule", enabled: true, revision: 1, scheduleKind: "interval", everyMs: 60_000, nextRunAt: now } });
        const admitted = await inTx((tx) => admitDueAutomationScheduleTriggerTx({ tx, triggerId: schedule.id,
            expectedRevision: schedule.revision, expectedNextRunAt: now, now }));
        expect(admitted?.kind).toBe("admitted");
        await expect(deleteOwnedSession({ sessionId: current.sessionId, ownerAccountId: current.accountId, reason: "user_request" }))
            .resolves.toEqual({ ok: true });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: admitted!.run.id } })).toMatchObject({ state: "queued" });
        await expect(claimAutomationRun({ accountId: current.accountId, machineId: assignment.machineId, leaseDurationMs: 60_000 }))
            .resolves.toMatchObject({ run: null });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: admitted!.run.id } }))
            .toMatchObject({ state: "failed", errorCode: "source_unavailable", workflowCustodyState: "settled",
                attempt: 0, startedAt: null, producedSessionId: null, workflowAcceptedSnapshotEnvelope: null });
    });

    it("selects exact-turn candidates from the settled Session Account only", async () => {
        const current = await source();
        const foreign = await source();
        await trigger({
            ...foreign,
            sessionId: current.sessionId,
            turnId: current.turnId,
        });

        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: {
                v: 1,
                kind: "sessionLifecycle",
                event: "parentTurnCompleted",
                sourceSessionId: current.sessionId,
                sourceTurnId: current.turnId,
                occurredAt: Date.now(),
            },
        }))).resolves.toEqual([]);
    });

    it("fans out more than the portable SQL bind ceiling of exact-turn matches in the settlement transaction", async () => {
        const current = await source();
        const matchCount = 520;
        const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1({
            v: 1,
            templateVersion: 1,
            template: { t: "plain", v: { v: 1, prompt: "Exact turn fan-out" } },
            triggerEvidence: null,
            target: {
                kind: "newSession",
                spawn: {
                    executionTarget: { serverId: `server-${current.suffix}`, machineId: `machine-${current.suffix}` },
                    directory: { kind: "path", path: "/tmp/exact-turn" },
                    agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
                },
            },
        });
        if (recipe.kind !== "available") throw new Error("Recipe unavailable");
        const now = new Date();
        const automationRows = Array.from({ length: matchCount }, (_, index) => ({
            id: `fan-out-automation-${index}-${current.suffix}`,
            accountId: current.accountId,
            name: `Exact turn fan-out ${index}`,
            enabled: true,
            targetType: "new_session" as const,
            templateCiphertext: recipe.serialized,
            templateVersion: 1,
            updatedAt: now,
        }));
        for (const chunk of automationPortableQueryChunks({ values: automationRows, bindingsPerValue: 9 })) {
            await db.automation.createMany({ data: [...chunk] });
        }
        const lifecycle = encodeAutomationSessionLifecycleConfiguration({
            kind: "sessionLifecycle",
            sourceSessionId: current.sessionId,
            events: ["parentTurnCompleted"],
            policy: { kind: "currentTurn", sourceTurnId: current.turnId },
        });
        const triggerRows = automationRows.map((automation) => ({
            id: `fan-out-trigger-${automation.id}`,
            automationId: automation.id,
            kind: "sessionLifecycle" as const,
            enabled: true,
            ...lifecycle,
            updatedAt: now,
        }));
        for (const chunk of automationPortableQueryChunks({ values: triggerRows, bindingsPerValue: 9 })) {
            await db.automationTrigger.createMany({ data: [...chunk] });
        }
        // Assignments reference real Account machines. The production schema
        // enforces this FK, so seed the fan-out machines before inserting the
        // assignment rows used by this bind-ceiling regression.
        const fanOutMachines = automationRows.map((automation) => ({
            id: `fan-out-execution-${automation.id}`,
            accountId: current.accountId,
            metadata: "{}",
        }));
        for (const chunk of automationPortableQueryChunks({ values: fanOutMachines, bindingsPerValue: 9 })) {
            await db.machine.createMany({ data: [...chunk] });
        }
        const fanOutAssignmentRows = automationRows.map((automation) => ({
            automationId: automation.id,
            machineId: `fan-out-execution-${automation.id}`,
            enabled: true,
        }));
        for (const chunk of automationPortableQueryChunks({ values: fanOutAssignmentRows, bindingsPerValue: 9 })) {
            await db.automationAssignment.createMany({ data: [...chunk] });
        }

        // Observe the genuine DB boundary so a sanitized HTTP-owner failure retains its deciding diagnostic.
        const transactionBoundary = db as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
        const originalTransaction = transactionBoundary.$transaction;
        let transactionFailure: unknown;
        transactionBoundary.$transaction = async (...args) => {
            try { return await Reflect.apply(originalTransaction, db, args); }
            catch (error) { transactionFailure = error; throw error; }
        };
        let fanOutResult;
        try { fanOutResult = await applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `complete-fan-out-${current.suffix}`,
                action: "complete",
                turnId: current.turnId,
                observedAt: now.getTime(),
            },
        }); } finally { transactionBoundary.$transaction = originalTransaction; }
        expect(fanOutResult, transactionFailure instanceof Error ? transactionFailure.stack : String(transactionFailure))
            .toMatchObject({ ok: true, didApply: true });

        await expect(db.automationRun.count({
            where: { triggerId: { in: triggerRows.map((trigger) => trigger.id) } },
        })).resolves.toBe(matchCount);
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
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: created.id },
            select: { remainingOccurrences: true },
        })).resolves.toEqual({ remainingOccurrences: 0 });
    });

    it.each([
        { action: "fail" as const, event: "parentTurnFailed" as const },
        { action: "cancel" as const, event: "parentTurnCancelled" as const },
        { action: "end_session" as const, event: "parentTurnCancelled" as const },
        { action: "complete" as const, event: "parentTurnCompleted" as const },
    ])("rejoins a concurrent occurrence winner instead of failing $action settlement", async ({ action, event }) => {
        const current = await source();
        const created = await trigger({ ...current, events: [event] });
        const observedAt = Date.now();
        const injection = failFirstRunCreateWithOccurrenceConflict(created.automationId);
        try {
            await expect(applySessionTurnMutation({
                actorUserId: current.accountId,
                mutation: {
                    v: 1,
                    sessionId: current.sessionId,
                    mutationId: `${action}-occurrence-race-${current.suffix}`,
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
        } finally { injection.restore(); }

        expect(injection.didInject()).toBe(true);
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(1);
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: current.sessionId, turnId: current.turnId } },
            select: { status: true },
        })).resolves.toEqual({
            status: action === "complete"
                ? "completed"
                : action === "fail" ? "failed" : "cancelled",
        });
    });

    it.each(["fail", "cancel", "end_session"] as const)(
        "publishes one content-free Automation invalidation when %s consumes the budget without a Run",
        async (action) => {
            const current = await source();
            const created = await trigger(current);
            const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
            const observedAt = Date.now();
            try {
                await expect(applySessionTurnMutation({
                    actorUserId: current.accountId,
                    mutation: {
                        v: 1,
                        sessionId: current.sessionId,
                        mutationId: `${action}-invalidate-${current.suffix}`,
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

                await expect(db.automationTrigger.findUniqueOrThrow({
                    where: { id: created.id },
                    select: { remainingOccurrences: true },
                })).resolves.toEqual({ remainingOccurrences: 0 });
                await expect(db.automationRun.count({
                    where: { triggerId: created.id },
                })).resolves.toBe(0);

                const invalidations = emitUpdate.mock.calls.filter(([update]) => (
                    update.payload.body.t === "automation-source-status-updated"
                ));
                expect(invalidations).toHaveLength(1);
                expect(invalidations[0]?.[0]).toEqual(expect.objectContaining({
                    userId: current.accountId,
                    payload: expect.objectContaining({
                        body: { t: "automation-source-status-updated" },
                    }),
                    recipientFilter: { type: "user-scoped-only" },
                }));
            } finally { emitUpdate.mockRestore(); }

            await expect(db.accountChange.findUnique({
                where: {
                    accountId_kind_entityId: {
                        accountId: current.accountId,
                        kind: "automation",
                        entityId: created.automationId,
                    },
                },
                select: { entityId: true },
            })).resolves.toEqual({ entityId: created.automationId });
        },
    );

    it.each([
        { action: "fail" as const, event: "parentTurnFailed" as const },
        { action: "cancel" as const, event: "parentTurnCancelled" as const },
        { action: "end_session" as const, event: "parentTurnCancelled" as const },
    ])("admits the selected $event terminal occurrence", async ({ action, event }) => {
        const current = await source();
        const created = await trigger({ ...current, events: [event] });
        const observedAt = Date.now();
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `${action}-selected-${current.suffix}`,
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
        await expect(db.automationRun.findFirstOrThrow({
            where: { triggerId: created.id },
            select: { causeSessionLifecycleEvent: true },
        })).resolves.toEqual({ causeSessionLifecycleEvent: event });
    });

    it("shares one bounded budget across selected Events and never decrements a replay twice", async () => {
        const current = await source();
        const created = await trigger({
            ...current,
            events: ["parentTurnCompleted", "parentTurnFailed"],
            policy: { kind: "nextMatches", count: 2 },
        });
        const first = {
            v: 1 as const,
            kind: "sessionLifecycle" as const,
            event: "parentTurnCompleted" as const,
            sourceSessionId: current.sessionId,
            sourceTurnId: `${current.turnId}-1`,
            occurredAt: Date.now(),
        };
        // Admission reads host-stamped initiator facts, not an author-supplied turn id.
        await db.sessionTurn.createMany({ data: [1, 2, 3].map((index) => ({
            sessionId: current.sessionId, turnId: `${current.turnId}-${index}`,
            initiator: "user" as const, workDepth: 0, status: "completed" as const,
            startedAt: BigInt(first.occurredAt), updatedAt: BigInt(first.occurredAt),
        })) });
        await inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: first,
        }));
        await inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: first,
        }));
        const secondOccurrence = {
            ...first,
            event: "parentTurnFailed" as const,
            sourceTurnId: `${current.turnId}-2`,
            occurredAt: first.occurredAt + 2,
        };
        await inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: secondOccurrence,
        }));
        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: secondOccurrence,
        }))).resolves.toMatchObject([{ triggerId: created.id, result: { kind: "rejoined" } }]);
        await inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: {
                ...first,
                sourceTurnId: `${current.turnId}-3`,
                occurredAt: first.occurredAt + 3,
            },
        }));
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(2);
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: created.id },
            select: { remainingOccurrences: true },
        })).resolves.toEqual({ remainingOccurrences: 0 });
    });

    it("admits one content-free main-turn attention occurrence and rejects an unknown turn", async () => {
        const current = await source();
        const created = await trigger({
            ...current,
            events: ["userActionRequired"],
            policy: { kind: "firstMatch" },
        });
        const occurredAt = Date.now();
        const admitted = await inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: {
                v: 1,
                kind: "sessionLifecycle",
                event: "userActionRequired",
                sourceSessionId: current.sessionId,
                sourceTurnId: current.turnId,
                requestId: "request-1",
                requestKind: "user_action",
                occurredAt,
            },
        }));
        expect(admitted).toHaveLength(1);
        await expect(db.automationRun.findFirstOrThrow({
            where: { triggerId: created.id },
            select: {
                causeSessionLifecycleEvent: true,
                causeSessionLifecycleRequestId: true,
                causeSessionLifecycleRequestKind: true,
                causeOccurredAt: true,
            },
        })).resolves.toEqual({
            causeSessionLifecycleEvent: "userActionRequired",
            causeSessionLifecycleRequestId: "request-1",
            causeSessionLifecycleRequestKind: "user_action",
            causeOccurredAt: new Date(occurredAt),
        });

        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: {
                v: 1,
                kind: "sessionLifecycle",
                event: "userActionRequired",
                sourceSessionId: current.sessionId,
                sourceTurnId: "unknown-turn",
                requestId: "request-2",
                requestKind: "permission",
                occurredAt: occurredAt + 1,
            },
        }))).resolves.toEqual([]);
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(1);
    });

    it("never admits a main-turn attention occurrence for a superseded or terminalized turn", async () => {
        const current = await source();
        const created = await trigger({
            ...current,
            events: ["userActionRequired"],
            policy: { kind: "everyMatch" },
        });
        const attention = (sourceTurnId: string, requestId: string, occurredAt: number) => ({
            v: 1 as const,
            kind: "sessionLifecycle" as const,
            event: "userActionRequired" as const,
            sourceSessionId: current.sessionId,
            sourceTurnId,
            requestId,
            requestKind: "permission" as const,
            occurredAt,
        });
        const occurredAt = Date.now();

        // Control: the live parent turn still admits its attention occurrence.
        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: attention(current.turnId, "request-live", occurredAt),
        }))).resolves.toHaveLength(1);

        // Superseded: a newer parent turn is the Session's current turn, so a
        // late publisher's occurrence for the previous turn binds to nothing.
        const supersedingTurnId = `${current.turnId}-next`;
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `begin-next-${current.suffix}`,
                action: "begin",
                turnId: supersedingTurnId,
                observedAt: occurredAt + 1,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.sessionTurn.findFirstOrThrow({
            where: { sessionId: current.sessionId, turnId: current.turnId },
            select: { status: true },
        })).resolves.toEqual({ status: "in_progress" });
        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: attention(current.turnId, "request-superseded", occurredAt + 2),
        }))).resolves.toEqual([]);

        // Terminalized: the exact turn is the Session's current turn but has
        // already settled, so its pending request cannot still be awaiting a user.
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: {
                v: 1,
                sessionId: current.sessionId,
                mutationId: `complete-next-${current.suffix}`,
                action: "complete",
                turnId: supersedingTurnId,
                observedAt: occurredAt + 3,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(inTx(async (tx) => await admitSessionLifecycleAutomationRunsTx({
            tx,
            accountId: current.accountId,
            occurrence: attention(supersedingTurnId, "request-terminal", occurredAt + 4),
        }))).resolves.toEqual([]);

        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(1);
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
        { action: "fail" as const },
        { action: "cancel" as const },
        { action: "end_session" as const },
    ])("fails closed before settling a $action turn for a non-current Account", async ({ action }) => {
        const current = await source({ inconsistentE2ee: true });
        const created = await trigger({
            ...current,
            events: ["parentTurnCompleted", "parentTurnFailed", "parentTurnCancelled"],
        });
        const observedAt = Date.now();
        const base = {
            v: 1 as const,
            sessionId: current.sessionId,
            mutationId: `${action}-${current.suffix}`,
            turnId: current.turnId,
            observedAt,
        };
        await expect(applySessionTurnMutation({
            actorUserId: current.accountId,
            mutation: action === "fail"
                ? {
                    ...base,
                    action,
                    issue: {
                        v: 1,
                        scope: "primary_session",
                        status: "failed",
                        code: "opencode_prompt_submission_failed",
                        source: "agent_session_error",
                        occurredAt: observedAt,
                        provider: "opencode",
                        sanitizedPreview: "test",
                    },
                }
                : { ...base, action },
        })).resolves.toEqual({ ok: false, error: "internal" });

        // Terminal settlement is the exact-turn admission transaction, so it
        // must not commit the turn without its eligible Run.
        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
        await expect(db.sessionTurn.findFirstOrThrow({
            where: { sessionId: current.sessionId, turnId: current.turnId },
            select: { status: true },
        })).resolves.toEqual({ status: "in_progress" });
    });

    it("fails closed before settling a main-turn attention occurrence for a non-current Account", async () => {
        const current = await source({ inconsistentE2ee: true });
        const created = await trigger({
            ...current,
            events: ["userActionRequired"],
        });
        const session = await db.session.findUniqueOrThrow({
            where: { id: current.sessionId },
            select: { agentStateVersion: true },
        });

        await expect(updateSessionAgentState({
            actorUserId: current.accountId,
            sessionId: current.sessionId,
            expectedVersion: session.agentStateVersion,
            agentStateCiphertext: "{}",
            userActionRequiredOccurrences: [{
                requestId: "request-non-current-account",
                sourceTurnId: current.turnId,
                requestKind: "permission",
                occurredAt: Date.now(),
            }],
        })).resolves.toEqual({ ok: false, error: "internal" });

        await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: current.sessionId },
            select: { agentStateVersion: true },
        })).resolves.toEqual({ agentStateVersion: session.agentStateVersion });
    });

    it("keeps an exact-turn trigger inert when its selected occurrence cannot admit a Run", async () => {
        const current = await source();
        const created = await trigger(current);
        // Removing every execution assignment makes admission permanently
        // ineligible for this occurrence without changing the occurrence.
        await db.automationAssignment.deleteMany({ where: { automationId: created.automationId } });
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});

        try {
            await expect(applySessionTurnMutation({
                actorUserId: current.accountId,
                mutation: {
                    v: 1,
                    sessionId: current.sessionId,
                    mutationId: `complete-${current.suffix}`,
                    action: "complete",
                    turnId: current.turnId,
                    observedAt: Date.now(),
                },
            })).resolves.toMatchObject({ ok: true, didApply: true });

            await expect(db.automationRun.count({ where: { triggerId: created.id } })).resolves.toBe(0);
            await expect(db.automationTrigger.findUniqueOrThrow({
                where: { id: created.id },
                select: { remainingOccurrences: true },
            })).resolves.toEqual({ remainingOccurrences: 0 });
            // The consumed budget changed the projected trigger status without
            // producing a Run, so the canonical invalidation still fires.
            expect(emitUpdate.mock.calls.filter(([update]) => (
                update.payload.body.t === "automation-source-status-updated"
            ))).toHaveLength(1);
        } finally { emitUpdate.mockRestore(); }
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
