import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import {
    AutomationRunCauseSchema,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";
import { AutomationV3WorkerClaimResponseSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { db, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { readDatabaseTransactionConfigFromEnv } from "@/config/databaseTransactions";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from "@/testkit/pluginInstallationPublisherTestkit";
import { encodeAutomationRunCause } from "./automationRunCauseCodec";
import { claimAutomationRun } from "./automationClaimService";
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from "./automationAccountCurrentness";

const provider = process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres";

describe.skipIf(provider !== "postgres" && provider !== "postgresql")("Automation claim candidate publication (real PostgreSQL)", () => {
    const accountIds: string[] = [];
    let restoreTransport: (() => void) | undefined;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable DATABASE_URL for claim DB contract");
        initDbPostgres();
        await db.$connect();
    });

    afterEach(async () => {
        restoreTransport?.();
        restoreTransport = undefined;
        await db.automationRun.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.automation.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        accountIds.length = 0;
    });

    afterAll(async () => { await db.$disconnect(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        accountIds.push(owner.id, recipient.id);
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: owner.id, machineId, installationId, keyPair });
        const recipe = serializeAutomationRunExecutionRecipeV1({
            v: 1, templateVersion: 1, assignmentMachineIds: [machineId],
            template: { t: "plain", v: { v: 1, prompt: "Run the frozen task." } }, triggerEvidence: null,
            target: { kind: "newSession", spawn: {
                executionTarget: { serverId: "server", machineId },
                directory: { kind: "path", path: "/repo" },
                agentTarget: { kind: "agent", identity: { pluginId: "example.external-agent", localId: "agent" } },
            } },
        });
        if (recipe.kind !== "available") throw new Error("Claim fixture recipe unavailable");
        const automation = await db.automation.create({ data: { accountId: owner.id,
            name: "Bounded claim", enabled: true, templateCiphertext: recipe.serialized, templateVersion: 1 } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, automationId: automation.id,
            state: "queued", scheduledAt: new Date(0), dueAt: new Date(0), executionInputEnvelope: recipe.serialized,
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "manual", invokedAt: Date.now() })),
            assignments: { create: { machineId, priority: 0 } },
        } });
        const session = await db.session.create({ data: { accountId: owner.id,
            tag: randomUUID(), encryptionMode: "plain", metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: recipient.id, accessLevel: "view" } });
        // This nonterminal Run is assigned to the worker but cannot be claimed.
        // Its Session has an additional publication recipient absent from run.
        const future = await db.automationRun.create({ data: { accountId: owner.id,
            originKind: "direct", causeKind: null, originSessionId: session.id,
            state: "queued", workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
            scheduledAt: new Date("2099-01-01"), dueAt: new Date("2099-01-01"),
            assignments: { create: { machineId, priority: 0 } },
        } });
        return { owner, recipient, machineId, installationId, keyPair, automation, run, future, recipe: recipe.serialized };
    }

    it.each(["future-only", "candidate"] as const)("signed route claim fences only its bounded candidate audience (%s)", async audience => {
        const f = await fixture();
        if (audience === "candidate") await db.automationRun.update({
            where: { id: f.run.id }, data: { originSessionId: f.future.originSessionId },
        });
        const app: Fastify = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const holderReady = new Promise<void>(resolve => { ready = resolve; });
        let holderPid = -1;
        const holder = db.$transaction(async tx => {
            const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>(
                'SELECT pg_backend_pid() AS pid FROM "Account" WHERE "id" = $1 FOR UPDATE', f.recipient.id);
            holderPid = row.pid;
            ready();
            await mayCommit;
        }, { timeout: 60_000 });
        const holderOutcome = Promise.allSettled([holder]);
        await holderReady;
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        const path = "/v3/automations/runs/claim";
        const body = { machineId: f.machineId, leaseDurationMs: 30_000 };
        const publisherHeader = createSignedPluginInstallationPublisherHeader({ keyPair: f.keyPair,
            machineId: f.machineId, installationId: f.installationId, path, body });
        const request = { method: "POST" as const, url: path, payload: body, headers: {
            "x-test-user-id": f.owner.id, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
        } };
        try {
            let settled = false;
            let observedBlock = false;
            const responsePromise = app.inject(request).finally(() => { settled = true; });
            while (!settled) {
                const [row] = await db.$queryRawUnsafe<{ blocked: boolean }[]>(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", holderPid);
                if (!row.blocked) continue;
                observedBlock = true;
                if (audience === "candidate") {
                    release();
                    break;
                }
                // Prisma's expiry does not cancel an in-flight raw lock wait.
                // Only after PostgreSQL proves this exact unrelated blocker,
                // release after the existing owner budget so the old
                // path surfaces P2028 rather than stranding test cleanup.
                releaseTimer = setTimeout(release, readDatabaseTransactionConfigFromEnv(process.env, "postgres").timeoutMs);
                break;
            }
            const response = await responsePromise;
            expect(response.statusCode, response.body).toBe(200);
            expect(observedBlock).toBe(audience === "candidate");
            const claimed = AutomationV3WorkerClaimResponseSchema.parse(response.json());
            expect(claimed.run).toMatchObject({ id: f.run.id, attempt: 1, executionInputEnvelope: f.recipe });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: f.run.id } }))
                .toMatchObject({ state: "claimed", attempt: 1, claimedByMachineId: f.machineId });
            expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: f.owner.id } })).toBe(1);
            const replay = await app.inject(request);
            expect(replay.statusCode, replay.body).toBe(200);
            // The signed receipt retains its claim outcome; its content witness
            // comes from the current Account, including the first claim's publication.
            const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
                where: { id: f.owner.id }, select: automationAccountCurrentnessSelect,
            }));
            expect(AutomationV3WorkerClaimResponseSchema.parse(replay.json())).toEqual({ ...claimed, accountCurrentness });

            // A valid proof for this installation cannot authorize a different
            // request machine, even when that other machine belongs to owner.
            const otherMachineId = randomUUID();
            await db.machine.create({ data: { id: otherMachineId, accountId: f.owner.id, metadata: "{}" } });
            const crossedBody = { ...body, machineId: otherMachineId };
            const crossed = await app.inject({ ...request, payload: crossedBody, headers: {
                ...request.headers, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: f.keyPair, machineId: f.machineId, installationId: f.installationId,
                    path, body: crossedBody, nonce: "crossed-machine",
                }),
            } });
            expect(crossed.statusCode).toBe(401);
            expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: f.owner.id } })).toBe(1);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: f.future.id } })).toMatchObject({ state: "queued", attempt: 0 });
        } finally {
            if (releaseTimer !== undefined) clearTimeout(releaseTimer);
            release();
            const [outcome] = await holderOutcome;
            await app.close();
            if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it("revalidates candidate eligibility after publication locks rather than claiming stale discovery", async () => {
        const f = await fixture();
        const originalTransaction = db.$transaction.bind(db);
        let moved = false;
        // Interleave a real committed reschedule at the database transport
        // boundary; candidate selection, audience locks and CAS remain real.
        const interleaved = async (operation: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof originalTransaction>[1]) =>
            originalTransaction(async tx => operation(new Proxy(tx, { get(target, property, receiver) {
                if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                return async (query: string, ...values: unknown[]) => {
                    if (!moved && query.includes('FROM "Account"') && query.includes("FOR ")) {
                        moved = true;
                        await db.automationRun.update({ where: { id: f.run.id }, data: { dueAt: new Date("2099-01-01") } });
                    }
                    return target.$queryRawUnsafe(query, ...values);
                };
            } })), options);
        db.$transaction = interleaved as typeof db.$transaction;
        restoreTransport = () => { db.$transaction = originalTransaction; };
        const result = await claimAutomationRun({ accountId: f.owner.id, machineId: f.machineId, leaseDurationMs: 30_000 });
        expect(moved).toBe(true);
        expect(result.run).toBeNull();
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ state: "queued", attempt: 0 });
    });

    it("records and replays an empty signed claim without joining an unrelated Account publication", async () => {
        const f = await fixture();
        await db.automationRun.update({ where: { id: f.run.id }, data: { dueAt: new Date("2099-01-01") } });
        const app: Fastify = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        const path = "/v3/automations/runs/claim";
        const body = { machineId: f.machineId, leaseDurationMs: 30_000 };
        const request = { method: "POST" as const, url: path, payload: body, headers: {
            "x-test-user-id": f.owner.id,
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                keyPair: f.keyPair, machineId: f.machineId, installationId: f.installationId, path, body,
            }),
        } };
        const injectRequest = () => app.inject(request);
        let pending: ReturnType<typeof injectRequest> | undefined;
        let blocked = false;
        let waits: Array<{ wait_event_type: string | null; wait_event: string | null; account_statement: boolean }> = [];
        try {
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.account.update({ where: { id: f.owner.id }, data: { seq: { increment: 1 } } });
                let settled = false;
                pending = injectRequest();
                void pending.finally(() => { settled = true; });
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) {
                        blocked = true;
                        waits = await db.$queryRaw`SELECT wait_event_type, wait_event, query LIKE '%Account%' AS account_statement
                            FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
                        break;
                    }
                }
            });
            const response = await pending!;
            console.info("FIX99 empty claim publication wait", { blocked, waits });
            expect(response.statusCode, response.body).toBe(200);
            expect(blocked, "An empty claim publishes no Account change").toBe(false);
            const result = AutomationV3WorkerClaimResponseSchema.parse(response.json());
            expect(result.run).toBeNull();
            expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: f.owner.id } })).toBe(1);
            const replay = await app.inject(request);
            expect(replay.statusCode, replay.body).toBe(200);
            expect(AutomationV3WorkerClaimResponseSchema.parse(replay.json())).toEqual(result);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ state: "queued", attempt: 0 });
            await db.machine.update({ where: { id: f.machineId }, data: { installationId: randomUUID() } });
            const retiredInstallation = await app.inject(request);
            expect(retiredInstallation.statusCode).toBe(401);
            expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: f.owner.id } })).toBe(1);
        } finally { await app.close(); }
    });
});
