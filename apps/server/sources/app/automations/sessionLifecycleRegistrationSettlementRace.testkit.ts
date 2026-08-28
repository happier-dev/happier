import { randomUUID } from "node:crypto";
import { serializeAutomationStoredDefinitionExecutionRecipeV1 } from "@happier-dev/protocol";

import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { db } from "@/storage/db";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { createAutomationTrigger } from "./automationCrudService";
import { AutomationSessionLifecycleRegistrationValidationError } from "./automationSessionLifecycleRegistration";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve } as const;
}

/** Barrier over canonical delegates only; it reproduces no persistence behavior. */
function installCanonicalRaceBarrier(params: { sessionId: string; turnId: string }) {
    const registrationWitnessed = deferred();
    const settlementTransactionRequested = deferred();
    const settlementWriteAttempted = deferred();
    const settlementMembershipRead = deferred();
    const releaseRegistration = deferred();
    const releaseSettlementMembership = deferred();
    const originalTransaction = db.$transaction;
    let invocationCount = 0;
    let registrationReads = 0;
    let settlementWrites = 0;
    let settlementHasEntered = false;

    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") return await Reflect.apply(originalTransaction, db, args);
        const invocation = ++invocationCount;
        if (invocation === 2) settlementTransactionRequested.resolve();
        return await Reflect.apply(originalTransaction, db, [
            async (tx: object) => {
                if (invocation === 2) {
                    settlementHasEntered = true;
                }
                const turnDelegate = Reflect.get(tx, "sessionTurn") as object;
                const triggerDelegate = Reflect.get(tx, "automationTrigger") as object;
                const originalFindUnique = Reflect.get(turnDelegate, "findUnique");
                const originalUpdate = Reflect.get(turnDelegate, "update");
                const originalFindMany = Reflect.get(triggerDelegate, "findMany");
                if (
                    typeof originalFindUnique !== "function"
                    || typeof originalUpdate !== "function"
                    || typeof originalFindMany !== "function"
                ) throw new Error("Canonical race delegate unavailable");

                const sessionTurn = new Proxy(turnDelegate, {
                    get(target, property, receiver) {
                        if (property === "findUnique") return async (...findArgs: unknown[]) => {
                            const result = await Reflect.apply(originalFindUnique, target, findArgs);
                            const query = findArgs[0] as {
                                where?: { sessionId_turnId?: { sessionId?: unknown; turnId?: unknown } };
                                select?: { status?: unknown };
                            } | undefined;
                            if (
                                query?.where?.sessionId_turnId?.sessionId === params.sessionId
                                && query.where.sessionId_turnId.turnId === params.turnId
                                && query.select?.status === true
                            ) {
                                registrationReads += 1;
                                if (registrationReads === 1) {
                                    registrationWitnessed.resolve();
                                    await releaseRegistration.promise;
                                }
                            }
                            return result;
                        };
                        if (property === "update") return (...updateArgs: unknown[]) => {
                            const query = updateArgs[0] as { data?: { status?: unknown } } | undefined;
                            if (query?.data?.status === "completed") {
                                settlementWrites += 1;
                                const executing = Promise.resolve(Reflect.apply(originalUpdate, target, updateArgs));
                                settlementWriteAttempted.resolve();
                                return executing;
                            }
                            return Reflect.apply(originalUpdate, target, updateArgs);
                        };
                        return Reflect.get(target, property, receiver);
                    },
                });
                const automationTrigger = new Proxy(triggerDelegate, {
                    get(target, property, receiver) {
                        if (property !== "findMany") return Reflect.get(target, property, receiver);
                        return async (...findArgs: unknown[]) => {
                            const result = await Reflect.apply(originalFindMany, target, findArgs);
                            const query = findArgs[0] as {
                                where?: { kind?: unknown; sourceSessionId?: unknown; sourceTurnId?: unknown };
                            } | undefined;
                            if (
                                query?.where?.kind === "sessionLifecycle"
                                && query.where.sourceSessionId === params.sessionId
                                && query.where.sourceTurnId === params.turnId
                                && Array.isArray(result)
                                && result.length === 0
                            ) {
                                settlementMembershipRead.resolve();
                                await releaseSettlementMembership.promise;
                            }
                            return result;
                        };
                    },
                });
                return await Reflect.apply(operation, undefined, [new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "sessionTurn") return sessionTurn;
                        if (property === "automationTrigger") return automationTrigger;
                        return Reflect.get(target, property, receiver);
                    },
                })]);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        registrationWitnessed: registrationWitnessed.promise,
        settlementTransactionRequested: settlementTransactionRequested.promise,
        settlementWriteAttempted: settlementWriteAttempted.promise,
        settlementMembershipRead: settlementMembershipRead.promise,
        releaseRegistration: releaseRegistration.resolve,
        releaseSettlementMembership: releaseSettlementMembership.resolve,
        registrationAttempts: () => registrationReads,
        settlementAttempts: () => settlementWrites,
        settlementHasEntered: () => settlementHasEntered,
        restore: () => {
            releaseRegistration.resolve();
            releaseSettlementMembership.resolve();
            db.$transaction = originalTransaction;
        },
    } as const;
}

export type SessionLifecycleRegistrationSettlementRaceEvidence = Readonly<{
    registration: "committed" | "rejected_after_settlement";
    settlement: "committed";
    registrationAttempts: number;
    settlementAttempts: number;
    triggerCount: number;
    runCount: number;
    settlementEnteredBeforeRegistrationRelease: boolean;
}>;

async function createSessionLifecycleRaceFixture(label: string) {
    const suffix = randomUUID();
    const accountId = `session-lifecycle-${label}-account-${suffix}`;
    const sessionId = `session-lifecycle-${label}-session-${suffix}`;
    const turnId = `session-lifecycle-${label}-turn-${suffix}`;
    const automationId = `session-lifecycle-${label}-automation-${suffix}`;
    const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: `Session lifecycle ${label}` } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: `server-${suffix}`, machineId: `machine-${suffix}` },
                directory: `/tmp/session-lifecycle-${label}`,
                agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.codex", localId: "codex" } },
            },
        },
    });
    if (recipe.kind !== "available") throw new Error(`${label} recipe did not serialize`);
    await db.account.create({ data: { id: accountId, publicKey: `public-key-${suffix}`, encryptionMode: "plain" } });
    await db.session.create({ data: { id: sessionId, tag: `${label}-${suffix}`, accountId, encryptionMode: "plain", metadata: "{}" } });
    await db.automation.create({
        data: {
            id: automationId,
            accountId,
            name: `Session lifecycle ${label}`,
            enabled: true,
            targetType: "new_session",
            templateCiphertext: recipe.serialized,
            templateVersion: 1,
        },
    });
    const begun = await applySessionTurnMutation({
        actorUserId: accountId,
        mutation: { v: 1, sessionId, mutationId: `begin-${suffix}`, action: "begin", turnId, observedAt: Date.now() - 1_000 },
    });
    if (!begun.ok || !begun.didApply) throw new Error(`${label} source turn did not begin`);
    return {
        suffix,
        accountId,
        sessionId,
        turnId,
        automationId,
        cleanup: async () => {
            await db.automationRun.deleteMany({ where: { accountId } }).catch(() => {});
            await db.automationTrigger.deleteMany({ where: { automation: { accountId } } }).catch(() => {});
            await db.automation.deleteMany({ where: { accountId } }).catch(() => {});
            await db.session.deleteMany({ where: { accountId } }).catch(() => {});
            await db.accountChange.deleteMany({ where: { accountId } }).catch(() => {});
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => {});
        },
    } as const;
}

export async function proveSessionLifecycleRegistrationSettlementRace(
): Promise<SessionLifecycleRegistrationSettlementRaceEvidence> {
    const fixture = await createSessionLifecycleRaceFixture("race");
    const { suffix, accountId, sessionId, turnId, automationId } = fixture;

    const barrier = installCanonicalRaceBarrier({ sessionId, turnId });
    try {
        const registration = createAutomationTrigger({
            accountId,
            automationId,
            triggerId: `session-lifecycle-race-trigger-${suffix}`,
            trigger: {
                kind: "sessionLifecycle",
                enabled: true,
                event: "parentTurnCompleted",
                scope: { kind: "exactTurn", sourceSessionId: sessionId, sourceTurnId: turnId },
                consumption: "once",
            },
        });
        await barrier.registrationWitnessed;
        const settlement = applySessionTurnMutation({
            actorUserId: accountId,
            mutation: { v: 1, sessionId, mutationId: `complete-${suffix}`, action: "complete", turnId, observedAt: Date.now() },
        });
        const provider = getDbProviderFromEnv(process.env, "postgres");
        let settled: Awaited<typeof settlement> | null = null;
        if (provider === "postgres") {
            await barrier.settlementMembershipRead;
            barrier.releaseSettlementMembership();
            settled = await settlement;
            barrier.releaseRegistration();
        } else if (provider === "sqlite") {
            // SQLite's BEGIN IMMEDIATE writer reservation prevents the second
            // interactive transaction callback from entering while registration
            // is paused. Waiting for that callback here is a circular barrier.
            // Wait only until the canonical settlement asks Prisma for its
            // transaction, prove its callback has not entered, then release the
            // canonical first writer.
            await barrier.settlementTransactionRequested;
            const enteredBeforeRelease = barrier.settlementHasEntered();
            if (enteredBeforeRelease) {
                throw new Error("SQLite settlement entered while registration held the writer reservation");
            }
            barrier.releaseRegistration();
        } else {
            await barrier.settlementWriteAttempted;
            barrier.releaseRegistration();
        }
        const registrationResult = await registration.then(
            () => "committed" as const,
            (error) => {
                if (error instanceof AutomationSessionLifecycleRegistrationValidationError) {
                    return "rejected_after_settlement" as const;
                }
                throw error;
            },
        );
        settled ??= await settlement;
        if (!settled.ok || !settled.didApply) throw new Error("Canonical settlement did not commit");
        const triggers = await db.automationTrigger.findMany({
            where: { automationId, kind: "sessionLifecycle", sourceSessionId: sessionId, sourceTurnId: turnId },
            select: { id: true },
        });
        const runCount = await db.automationRun.count({ where: { triggerId: { in: triggers.map(({ id }) => id) } } });
        const turn = await db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId, turnId } },
            select: { status: true },
        });
        if (turn.status !== "completed") throw new Error("Completion was not retained");
        if (registrationResult === "committed" && triggers.length !== 1) throw new Error("Registration winner missing");
        if (triggers.length === 1 && runCount !== 1) throw new Error("Forbidden trigger-without-Run race outcome");
        if (triggers.length === 0 && runCount !== 0) throw new Error("Run retained without registration winner");
        return {
            registration: registrationResult,
            settlement: "committed",
            registrationAttempts: barrier.registrationAttempts(),
            settlementAttempts: Math.max(1, barrier.settlementAttempts()),
            triggerCount: triggers.length,
            runCount,
            settlementEnteredBeforeRegistrationRelease:
                provider === "sqlite" ? false : barrier.settlementHasEntered(),
        };
    } finally {
        barrier.restore();
        await fixture.cleanup();
    }
}

/**
 * Completion-first correspondence: once terminal truth commits, registration
 * must reject rather than backfilling an exact-turn trigger after settlement.
 */
export async function proveSessionLifecycleSettlementBeforeRegistration(
): Promise<SessionLifecycleRegistrationSettlementRaceEvidence> {
    const fixture = await createSessionLifecycleRaceFixture("completion-first");
    const { suffix, accountId, sessionId, turnId, automationId } = fixture;
    try {
        const settled = await applySessionTurnMutation({
            actorUserId: accountId,
            mutation: { v: 1, sessionId, mutationId: `complete-${suffix}`, action: "complete", turnId, observedAt: Date.now() },
        });
        if (!settled.ok || !settled.didApply) throw new Error("Completion-first settlement did not commit");
        const registration = await createAutomationTrigger({
            accountId,
            automationId,
            triggerId: `session-lifecycle-completion-first-trigger-${suffix}`,
            trigger: {
                kind: "sessionLifecycle",
                enabled: true,
                event: "parentTurnCompleted",
                scope: { kind: "exactTurn", sourceSessionId: sessionId, sourceTurnId: turnId },
                consumption: "once",
            },
        }).then(
            () => "committed" as const,
            (error) => {
                if (error instanceof AutomationSessionLifecycleRegistrationValidationError) {
                    return "rejected_after_settlement" as const;
                }
                throw error;
            },
        );
        const triggerCount = await db.automationTrigger.count({ where: { automationId } });
        const runCount = await db.automationRun.count({ where: { automationId } });
        if (registration !== "rejected_after_settlement" || triggerCount !== 0 || runCount !== 0) {
            throw new Error("Completion-first registration backfilled terminal source truth");
        }
        return {
            registration,
            settlement: "committed",
            registrationAttempts: 1,
            settlementAttempts: 1,
            triggerCount,
            runCount,
            settlementEnteredBeforeRegistrationRelease: false,
        };
    } finally {
        await fixture.cleanup();
    }
}
