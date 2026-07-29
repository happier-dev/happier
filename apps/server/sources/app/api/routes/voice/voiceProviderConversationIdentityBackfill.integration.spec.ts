import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { backfillVoiceProviderConversationIdentityBatch } from "./voiceProviderConversationIdentityBackfill";
import {
    VoiceProviderConversationIdentityCollisionError,
    deriveVoiceProviderConversationKey,
} from "./voiceProviderConversationIdentity";
import {
    runVoiceProviderIdentityBackfill,
    verifyVoiceProviderIdentityBackfillZero,
} from "@/app/voice/providerIdentityBackfill/run";
import { runVoiceProviderIdentityBackfillOperator } from "@/app/voice/providerIdentityBackfill/operator";
import {
    runVoiceProviderIdentityBackfillWorkerPass,
    startVoiceProviderIdentityBackfillWorker,
} from "@/app/voice/providerIdentityBackfill/worker";
import { register } from "@/app/monitoring/metrics/registry";

describe("voice provider conversation identity backfill (sqlite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-voice-identity-backfill-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.voiceConversation.deleteMany().catch(() => {});
        await db.voiceSessionLease.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    async function createLegacyIdentity(params: Readonly<{
        publicKey: string;
        providerConversationId: string;
        providerConversationKey?: string | null;
    }>) {
        const account = await db.account.create({ data: { publicKey: params.publicKey }, select: { id: true } });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: account.id,
                sessionId: null,
                periodKey: "2026-07",
                grantedBy: "subscription",
                elevenLabsAgentId: "agent_dev",
                providerId: "elevenlabs_agents",
                providerConversationId: params.providerConversationId,
                providerConversationKey: params.providerConversationKey ?? null,
                providerBindingNonce: `nonce_${params.publicKey}`,
                expiresAt: new Date(Date.now() + 60_000),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: account.id,
                leaseId: lease.id,
                providerId: "elevenlabs_agents",
                providerConversationId: params.providerConversationId,
                providerConversationKey: params.providerConversationKey ?? null,
                durationSeconds: 1,
            },
            select: { id: true },
        });
        return { account, lease, conversation };
    }

    async function readCounterValue(name: string): Promise<number> {
        const metric = (await register.getMetricsAsJSON()).find((entry) => entry.name === name);
        return metric?.values.reduce((total, value) => total + Number(value.value), 0) ?? 0;
    }

    it("backfills legacy conversation and lease rows in bounded idempotent batches", async () => {
        const legacy = await createLegacyIdentity({
            publicKey: "pk-voice-backfill",
            providerConversationId: "conv_backfill",
        });

        const first = await backfillVoiceProviderConversationIdentityBatch({ batchSize: 1 });
        expect(first).toEqual({ conversationsUpdated: 1, leasesUpdated: 1 });
        const expectedKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: "conv_backfill",
        });
        expect(await db.voiceConversation.findUnique({
            where: { id: legacy.conversation.id },
            select: { providerConversationKey: true },
        })).toEqual({ providerConversationKey: expectedKey });
        expect(await db.voiceSessionLease.findUnique({
            where: { id: legacy.lease.id },
            select: { providerConversationKey: true },
        })).toEqual({ providerConversationKey: expectedKey });

        expect(await backfillVoiceProviderConversationIdentityBatch({ batchSize: 1 }))
            .toEqual({ conversationsUpdated: 0, leasesUpdated: 0 });
    });

    it("fails closed without mutating a legacy row on an exact-identity collision", async () => {
        const targetId = "conv_backfill_target";
        const collisionKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: targetId,
        });
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-collision-owner",
            providerConversationId: "conv_backfill_other_raw",
            providerConversationKey: collisionKey,
        });
        const target = await createLegacyIdentity({
            publicKey: "pk-voice-backfill-collision-target",
            providerConversationId: targetId,
        });

        await expect(backfillVoiceProviderConversationIdentityBatch({ batchSize: 10 }))
            .rejects.toBeInstanceOf(VoiceProviderConversationIdentityCollisionError);
        expect(await db.voiceConversation.findUnique({
            where: { id: target.conversation.id },
            select: { providerConversationKey: true },
        })).toEqual({ providerConversationKey: null });
    });

    it("fails closed without mutating a legacy lease when its digest collides in the same account", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-voice-backfill-lease-collision" },
            select: { id: true },
        });
        const targetId = "conv_backfill_lease_target";
        const collisionKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: targetId,
        });
        const commonLeaseData = {
            accountId: account.id,
            sessionId: null,
            periodKey: "2026-07",
            grantedBy: "subscription",
            elevenLabsAgentId: "agent_dev",
            providerId: "elevenlabs_agents",
            expiresAt: new Date(Date.now() + 60_000),
        } as const;
        await db.voiceSessionLease.create({
            data: {
                ...commonLeaseData,
                providerConversationId: "conv_backfill_lease_other_raw",
                providerConversationKey: collisionKey,
                providerBindingNonce: "nonce_lease_collision_owner",
            },
        });
        const target = await db.voiceSessionLease.create({
            data: {
                ...commonLeaseData,
                providerConversationId: targetId,
                providerConversationKey: null,
                providerBindingNonce: "nonce_lease_collision_target",
            },
            select: { id: true },
        });

        await expect(backfillVoiceProviderConversationIdentityBatch({ batchSize: 10 }))
            .rejects.toBeInstanceOf(VoiceProviderConversationIdentityCollisionError);
        expect(await db.voiceSessionLease.findUnique({
            where: { id: target.id },
            select: { providerConversationKey: true },
        })).toEqual({ providerConversationKey: null });
    });

    it("runs bounded batches, observes a concurrent legacy/live write, and resumes to zero", async () => {
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-runner-initial",
            providerConversationId: "conv_runner_initial",
        });
        let insertedDuringRun = false;

        const firstRun = await runVoiceProviderIdentityBackfill({
            batchSize: 1,
            timeBudgetMs: 5,
            batchDelayMs: 0,
            nowMs: (() => {
                const values = [0, 0, 10];
                return () => values.shift() ?? 10;
            })(),
            onBatchCompleted: async () => {
                if (insertedDuringRun) return;
                insertedDuringRun = true;
                await createLegacyIdentity({
                    publicKey: "pk-voice-backfill-runner-legacy-live",
                    providerConversationId: "conv_runner_legacy_live",
                });
                const dualWriteId = "conv_runner_dual_write_live";
                await createLegacyIdentity({
                    publicKey: "pk-voice-backfill-runner-dual-live",
                    providerConversationId: dualWriteId,
                    providerConversationKey: deriveVoiceProviderConversationKey({
                        providerId: "elevenlabs_agents",
                        providerConversationId: dualWriteId,
                    }),
                });
            },
        });

        expect(firstRun).toMatchObject({
            stopReason: "time_budget",
            batches: 1,
            conversationsProcessed: 1,
            leasesProcessed: 1,
            remainingConversations: 1,
            remainingLeases: 1,
        });

        const resumed = await runVoiceProviderIdentityBackfill({
            batchSize: 1,
            timeBudgetMs: 5_000,
            batchDelayMs: 0,
        });
        expect(resumed).toMatchObject({
            stopReason: "zero",
            remainingConversations: 0,
            remainingLeases: 0,
        });
    });

    it("verifies zero twice and fails when a legacy row appears during the stability window", async () => {
        const initiallyZero = await verifyVoiceProviderIdentityBackfillZero({
            stabilityMs: 0,
        });
        expect(initiallyZero.stableZero).toBe(true);

        const becameNonZero = await verifyVoiceProviderIdentityBackfillZero({
            stabilityMs: 1_000,
            wait: async () => {
                await createLegacyIdentity({
                    publicKey: "pk-voice-backfill-zero-window",
                    providerConversationId: "conv_zero_window",
                });
            },
        });
        expect(becameNonZero).toEqual({
            stableZero: false,
            first: { conversations: 0, leases: 0 },
            second: { conversations: 1, leases: 1 },
        });
    });

    it("returns operator exit codes for partial runs, zero verification, collisions, and MySQL no-op", async () => {
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-operator-partial",
            providerConversationId: "conv_operator_partial",
        });
        const outputs: unknown[] = [];
        const nonzeroVerify = await runVoiceProviderIdentityBackfillOperator({
            mode: "verify",
            provider: "sqlite",
            stabilityMs: 0,
            writeResult: (value) => outputs.push(value),
        });
        expect(nonzeroVerify).toEqual({ exitCode: 2, outcome: "nonzero" });
        expect(outputs.at(-1)).toMatchObject({ phaseBReady: false });

        const partial = await runVoiceProviderIdentityBackfillOperator({
            mode: "run",
            provider: "sqlite",
            batchSize: 1,
            timeBudgetMs: 1,
            batchDelayMs: 0,
            writeResult: (value) => outputs.push(value),
        });
        expect(partial.exitCode).toBe(0);
        expect(outputs).not.toEqual([]);

        const verify = await runVoiceProviderIdentityBackfillOperator({
            mode: "verify",
            provider: "sqlite",
            stabilityMs: 1_000,
            writeResult: (value) => outputs.push(value),
        });
        expect(verify.exitCode).toBe(0);
        expect(outputs.at(-1)).toMatchObject({
            phaseBReady: true,
            stabilityMs: 1_000,
        });

        const collisionTargetId = "conv_operator_collision_target";
        const collisionKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: collisionTargetId,
        });
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-operator-collision-owner",
            providerConversationId: "conv_operator_collision_other",
            providerConversationKey: collisionKey,
        });
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-operator-collision-target",
            providerConversationId: collisionTargetId,
        });
        const collision = await runVoiceProviderIdentityBackfillOperator({
            mode: "run",
            provider: "sqlite",
            batchSize: 10,
            timeBudgetMs: 1_000,
            batchDelayMs: 0,
            writeResult: (value) => outputs.push(value),
        });
        expect(collision).toEqual({ exitCode: 3, outcome: "collision" });
        expect(outputs.at(-1)).toMatchObject({
            outcome: "collision",
            operatorAction: expect.stringContaining("Phase B"),
        });

        const mysql = await runVoiceProviderIdentityBackfillOperator({
            mode: "run",
            provider: "mysql",
            batchSize: 1,
            timeBudgetMs: 1,
            batchDelayMs: 0,
            writeResult: (value) => outputs.push(value),
        });
        expect(mysql).toEqual({ exitCode: 0, outcome: "not_applicable" });
    });

    it("reports an interrupted run as a failure instead of a successful partial rollout", async () => {
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-operator-interrupted",
            providerConversationId: "conv_operator_interrupted",
        });
        const controller = new AbortController();
        controller.abort();
        const outputs: unknown[] = [];

        const interrupted = await runVoiceProviderIdentityBackfillOperator({
            mode: "run",
            provider: "sqlite",
            batchSize: 1,
            timeBudgetMs: 1_000,
            batchDelayMs: 0,
            signal: controller.signal,
            writeResult: (value) => outputs.push(value),
        });

        expect(interrupted).toEqual({ exitCode: 130, outcome: "aborted" });
        expect(outputs.at(-1)).toEqual({
            exitCode: 130,
            outcome: "aborted",
            phaseBReady: false,
        });
    });

    it("allows only one replica to run a backfill pass and releases the lock on completion", async () => {
        for (let index = 0; index < 3; index += 1) {
            await createLegacyIdentity({
                publicKey: `pk-voice-backfill-replica-${index}`,
                providerConversationId: `conv_replica_${index}`,
            });
        }
        const policy = {
            enabled: true,
            batchSize: 1,
            timeBudgetMs: 5_000,
            batchDelayMs: 25,
            intervalMs: 60_000,
            lockTtlMs: 35_000,
        } as const;

        const firstPromise = runVoiceProviderIdentityBackfillWorkerPass({
            provider: "sqlite",
            policy,
            reason: "startup",
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await db.globalLock.count({
                where: { key: "server.voice.provider-identity-backfill" },
            }) === 1) break;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }

        const second = await runVoiceProviderIdentityBackfillWorkerPass({
            provider: "sqlite",
            policy,
            reason: "interval",
        });
        const first = await firstPromise;

        expect(first.status).toBe("completed");
        expect(second).toEqual({ status: "locked" });
        expect(await db.globalLock.count({
            where: { key: "server.voice.provider-identity-backfill" },
        })).toBe(0);
        expect(await readCounterValue("voice_provider_identity_backfill_remaining")).toBe(0);
        expect(await readCounterValue("voice_provider_identity_backfill_processed_total")).toBeGreaterThanOrEqual(2);
        expect(await readCounterValue("voice_provider_identity_backfill_last_success_unixtime_seconds")).toBeGreaterThan(0);
    });

    it("starts non-blocking, reaches zero, and awaits shutdown without leaving its lock", async () => {
        await createLegacyIdentity({
            publicKey: "pk-voice-backfill-worker-stop",
            providerConversationId: "conv_worker_stop",
        });

        const worker = startVoiceProviderIdentityBackfillWorker({
            provider: "sqlite",
            env: {
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "true",
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: "1",
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: "1",
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: "1000",
            },
        });
        expect(worker).not.toBeNull();

        for (let attempt = 0; attempt < 200; attempt += 1) {
            const remaining = await db.voiceConversation.count({
                where: { providerConversationKey: null },
            });
            if (remaining === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        await worker?.stop();

        expect(await db.voiceConversation.count({
            where: { providerConversationKey: null },
        })).toBe(0);
        expect(await db.globalLock.count({
            where: { key: "server.voice.provider-identity-backfill" },
        })).toBe(0);
    });

    it("halts automatic retries after a collision so it cannot loop on the same conflicting batch", async () => {
        const targetId = "conv_worker_collision_target";
        const collisionKey = deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: targetId,
        });
        await createLegacyIdentity({
            publicKey: "pk-worker-collision-owner",
            providerConversationId: "conv_worker_collision_other",
            providerConversationKey: collisionKey,
        });
        await createLegacyIdentity({
            publicKey: "pk-worker-collision-target",
            providerConversationId: targetId,
        });
        const before = await readCounterValue("voice_provider_identity_backfill_collisions_total");

        const worker = startVoiceProviderIdentityBackfillWorker({
            provider: "sqlite",
            env: {
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: "true",
                HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: "1000",
            },
        });
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (await readCounterValue("voice_provider_identity_backfill_collisions_total") > before) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const afterFirst = await readCounterValue("voice_provider_identity_backfill_collisions_total");
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const afterInterval = await readCounterValue("voice_provider_identity_backfill_collisions_total");
        await worker?.stop();

        expect(afterFirst).toBe(before + 1);
        expect(afterInterval).toBe(afterFirst);
    });
});
