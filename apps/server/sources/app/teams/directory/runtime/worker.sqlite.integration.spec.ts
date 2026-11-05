import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type { DirectoryProjectionCatchUp, DirectoryProjectionScan } from "../directoryReconciler";
import { runEnterpriseIdentitySyncWorkerPass, startEnterpriseIdentitySyncWorker } from "./worker";
import {
    DirectoryProjectionInvariantError,
    stageActiveWorkosGroupMemberEventPage,
} from "../directoryProjectionRepository";
import { NON_RETRYABLE_DIRECTORY_ERRORS } from "../directorySourceProjection";
import type { TeamDirectorySafeErrorCodeV1 } from "@happier-dev/protocol/teams";

describe("enterprise identity sync worker", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-directory-worker-",
            initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    async function createRunnableSource(suffix: string) {
        const team = await db.team.create({ data: { name: `Worker ${suffix}` } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "WorkOS",
                enabled: true,
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1 },
                settings: { v: 1 },
            },
        });
        return await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "workos_directory",
                state: "needs_attention",
                displayName: "WorkOS",
                externalSourceKey: `workos-worker:${suffix}`,
                bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: suffix },
                teamIdentityConnectionId: connection.id,
                manualSyncRequestedAt: new Date("2026-09-05T10:00:00.000Z"),
            },
        });
    }

    it("checks only for due work while idle and still runs a newly due source", async () => {
        // Observe the real database boundary; selection, Home policy and leases remain real.
        const findSource = db.teamDirectorySource.findFirst;
        const transaction = db.$transaction;
        const executeRaw = db.$executeRaw;
        const releaseLock = db.globalLock.deleteMany;
        let sourceReads = 0;
        let transactions = 0;
        let lockWrites = 0;
        let lockReleases = 0;
        db.teamDirectorySource.findFirst = new Proxy(findSource, { apply(target, receiver, args: unknown[]) {
            sourceReads++;
            return Reflect.apply(target, receiver, args);
        } });
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            transactions++;
            return Reflect.apply(target, receiver, args);
        } });
        db.$executeRaw = new Proxy(executeRaw, { apply(target, receiver, args: unknown[]) {
            lockWrites++;
            return Reflect.apply(target, receiver, args);
        } });
        db.globalLock.deleteMany = new Proxy(releaseLock, { apply(target, receiver, args: unknown[]) {
            lockReleases++;
            return Reflect.apply(target, receiver, args);
        } });
        try {
            for (let pass = 0; pass < 3; pass++) {
                await expect(runEnterpriseIdentitySyncWorkerPass()).resolves.toEqual({ status: "idle" });
            }
            expect(sourceReads).toBe(3);
            expect(transactions).toBe(0);
            expect(lockWrites).toBe(0);
            expect(lockReleases).toBe(0);

            const source = await createRunnableSource("after-idle");
            await expect(runEnterpriseIdentitySyncWorkerPass({
                scan: async () => ({ ok: true }),
                catchUp: async () => ({ ok: true }),
            })).resolves.toEqual({ status: "completed", sourceId: source.id });
            await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
                .resolves.toMatchObject({ state: "active", activeReconcileRunId: null });

            const disabled = await createRunnableSource("disabled-due");
            const writesBeforeDisabledPass = lockWrites;
            await expect(runEnterpriseIdentitySyncWorkerPass({
                env: { HAPPIER_FEATURE_TEAMS__ENABLED: "0" },
            })).resolves.toEqual({ status: "disabled" });
            expect(lockWrites).toBe(writesBeforeDisabledPass);
            await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: disabled.id } }))
                .resolves.toMatchObject({ state: "needs_attention", activeReconcileRunId: null });
            await db.teamDirectorySource.update({ where: { id: disabled.id }, data: { state: "paused" } });
        } finally {
            db.teamDirectorySource.findFirst = findSource;
            db.$transaction = transaction;
            db.$executeRaw = executeRaw;
            db.globalLock.deleteMany = releaseLock;
        }
    });

    it("uses the one database lease so two worker instances cannot scan the same source", async () => {
        await createRunnableSource("exclusive");
        let releaseScan!: () => void;
        const scanEntered = new Promise<void>((resolve) => {
            releaseScan = resolve;
        });
        let notifyEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            notifyEntered = resolve;
        });
        const scan = vi.fn(async () => {
            notifyEntered();
            await scanEntered;
            return { ok: true } as const;
        });

        const catchUp = vi.fn(async () => ({ ok: true } as const));
        const first = runEnterpriseIdentitySyncWorkerPass({ scan, catchUp });
        await entered;
        await expect(runEnterpriseIdentitySyncWorkerPass({ scan, catchUp })).resolves.toEqual({ status: "locked" });
        releaseScan();
        await expect(first).resolves.toMatchObject({ status: "completed" });
        expect(scan).toHaveBeenCalledTimes(1);
    });

    it("releases and reacquires the cluster lease around each source operation", async () => {
        const first = await createRunnableSource("lease-per-source-first");
        const second = await createRunnableSource("lease-per-source-second");
        await db.teamDirectorySource.update({
            where: { id: first.id },
            data: { lastAttemptAt: new Date("2026-09-05T08:00:00.000Z") },
        });
        await db.teamDirectorySource.update({
            where: { id: second.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const observedLeaseValues: string[] = [];
        const scan: DirectoryProjectionScan = async () => {
            const lease = await db.globalLock.findUniqueOrThrow({
                where: { key: "server.enterprise-identity.sync" },
                select: { value: true },
            });
            observedLeaseValues.push(lease.value);
            return { ok: true };
        };

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: second.id });
        expect(observedLeaseValues).toHaveLength(2);
        expect(new Set(observedLeaseValues).size).toBe(2);
    });

    it("polls due active WorkOS sources incrementally without running a full scan", async () => {
        const source = await createRunnableSource("incremental");
        const now = new Date();
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "active",
                activeReconcileRunId: null,
                manualSyncRequestedAt: null,
                eventCursor: "event_1",
                eventRangeStart: null,
                lastAttemptAt: new Date(now.getTime() - 10 * 60_000),
                lastSuccessAt: new Date(now.getTime() - 10 * 60_000),
                lastFullReconcileAt: now,
            },
        });
        const scan = vi.fn(async () => ({ ok: true } as const));
        const catchUp = vi.fn(async () => ({ ok: true } as const));

        await expect(runEnterpriseIdentitySyncWorkerPass({ scan, catchUp })).resolves.toEqual({
            status: "completed",
            sourceId: source.id,
        });
        expect(scan).not.toHaveBeenCalled();
        expect(catchUp).toHaveBeenCalledOnce();
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ state: "active", eventCursor: "event_1", lastFullReconcileAt: now });
    });

    it("repairs an abandoned incremental page attempt before draining later sources", async () => {
        const abandoned = await createRunnableSource("abandoned-incremental");
        const next = await createRunnableSource("after-abandoned-incremental");
        const now = new Date();
        await db.teamDirectorySource.update({
            where: { id: abandoned.id },
            data: {
                state: "active",
                activeReconcileRunId: null,
                manualSyncRequestedAt: null,
                eventCursor: "event_before_abandonment",
                eventRangeStart: null,
                lastAttemptAt: new Date(now.getTime() - 20 * 60_000),
                lastSuccessAt: new Date(now.getTime() - 20 * 60_000),
                lastFullReconcileAt: now,
            },
        });
        await db.teamDirectorySource.update({
            where: { id: next.id },
            data: { lastAttemptAt: new Date(now.getTime() - 10 * 60_000) },
        });
        const abandonedPage = {
            sourceId: abandoned.id,
            expectedPosition: { eventCursor: "event_before_abandonment" },
            eventId: "event_interrupted",
            attemptId: "abandoned-page-attempt",
            externalGroupId: "group_interrupted",
            people: [],
        };
        await expect(stageActiveWorkosGroupMemberEventPage(abandonedPage)).resolves.toEqual({ applied: true });
        const repaired: string[] = [];
        const scan: DirectoryProjectionScan = async ({ source }) => {
            repaired.push(source.id);
            if (source.id === abandoned.id) {
                expect(source.reconcileRunId).not.toBe(abandonedPage.attemptId);
                await expect(stageActiveWorkosGroupMemberEventPage(abandonedPage))
                    .resolves.toEqual({ applied: false, reason: "stale_run" });
            }
            return { ok: true };
        };

        await expect(runEnterpriseIdentitySyncWorkerPass({ scan, catchUp: async () => ({ ok: true }) }))
            .resolves.toEqual({ status: "completed", sourceId: next.id });
        expect(repaired).toEqual([abandoned.id, next.id]);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: abandoned.id } }))
            .resolves.toMatchObject({ state: "active", activeReconcileRunId: null, lastErrorCode: null });
    });

    it("does not turn a freshness target into a full-reconcile deadline", async () => {
        const source = await createRunnableSource("long-full-reconcile");
        const scan = vi.fn<DirectoryProjectionScan>(async ({ signal }) => await new Promise((resolve) => {
            const complete = setTimeout(() => resolve({ ok: true }), 40);
            signal?.addEventListener("abort", () => {
                clearTimeout(complete);
                resolve({ ok: false, code: "stale_run" });
            }, { once: true });
        }));
        // A stale caller value for the retired internal deadline seam must be ignored. Freshness
        // targets schedule observations; they do not bound the duration of a complete observation.
        const retiredWorkerInput: Parameters<typeof runEnterpriseIdentitySyncWorkerPass>[0] & {
            operationWindowMs: number;
        } = {
            scan,
            catchUp: async () => ({ ok: true } as const),
            operationWindowMs: 10,
        };

        await expect(runEnterpriseIdentitySyncWorkerPass(retiredWorkerInput)).resolves.toEqual({
            status: "completed",
            sourceId: source.id,
        });
        expect(scan.mock.calls[0]?.[0].signal).toBeUndefined();
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ state: "active", activeReconcileRunId: null });
    });

    it("does not turn a freshness target into an incremental-poll deadline", async () => {
        const source = await createRunnableSource("long-incremental-poll");
        const now = new Date();
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: {
                state: "active",
                activeReconcileRunId: null,
                manualSyncRequestedAt: null,
                eventCursor: "event_before_long_poll",
                eventRangeStart: null,
                lastAttemptAt: new Date(now.getTime() - 10 * 60_000),
                lastSuccessAt: new Date(now.getTime() - 10 * 60_000),
                lastFullReconcileAt: now,
            },
        });
        const catchUp = vi.fn<DirectoryProjectionCatchUp>(async ({ signal }) => await new Promise((resolve) => {
            const complete = setTimeout(() => resolve({ ok: true }), 40);
            signal?.addEventListener("abort", () => {
                clearTimeout(complete);
                resolve({ ok: false, code: "stale_run" });
            }, { once: true });
        }));
        const retiredWorkerInput: Parameters<typeof runEnterpriseIdentitySyncWorkerPass>[0] & {
            operationWindowMs: number;
        } = {
            scan: async () => ({ ok: true } as const),
            catchUp,
            operationWindowMs: 10,
        };

        await expect(runEnterpriseIdentitySyncWorkerPass(retiredWorkerInput)).resolves.toEqual({
            status: "completed",
            sourceId: source.id,
        });
        expect(catchUp.mock.calls[0]?.[0].signal).toBeUndefined();
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ state: "active", activeReconcileRunId: null });
    });

    it("skips an older source whose retry backoff is still active and runs the next eligible source", async () => {
        const backedOff = await createRunnableSource("backed-off-oldest");
        const eligible = await createRunnableSource("eligible-next");
        await db.teamDirectorySource.update({
            where: { id: backedOff.id },
            data: {
                lastAttemptAt: new Date("2026-09-05T08:00:00.000Z"),
                retryNotBefore: new Date(Date.now() + 60 * 60_000),
            },
        });
        await db.teamDirectorySource.update({
            where: { id: eligible.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const scan = vi.fn<DirectoryProjectionScan>(async () => ({ ok: true } as const));

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: eligible.id });
        expect(scan.mock.calls.map(([input]) => input.source.id)).toEqual([eligible.id]);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: backedOff.id } }))
            .resolves.toMatchObject({ retryNotBefore: expect.any(Date) });
    });

    it("records a thrown provider failure for one source and drains the next runnable source", async () => {
        const first = await createRunnableSource("throws-first");
        const second = await createRunnableSource("runs-second");
        await db.teamDirectorySource.update({
            where: { id: first.id },
            data: { lastAttemptAt: new Date("2026-09-05T08:00:00.000Z") },
        });
        await db.teamDirectorySource.update({
            where: { id: second.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const scan = vi.fn(async ({ source }: Parameters<DirectoryProjectionScan>[0]) => {
            if (source.id === first.id) throw new Error("upstream socket closed");
            return { ok: true } as const;
        });

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: second.id });
        expect(scan.mock.calls.map(([input]) => input.source.id)).toEqual([first.id, second.id]);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: first.id } }))
            .resolves.toMatchObject({
                state: "needs_attention",
                activeReconcileRunId: null,
                lastErrorCode: "directory_sync_unavailable",
            });
    });

    it("quarantines a broken projection invariant instead of retrying it forever", async () => {
        const broken = await createRunnableSource("invariant-broken");
        const healthy = await createRunnableSource("after-invariant");
        await db.teamDirectorySource.update({
            where: { id: broken.id },
            data: { lastAttemptAt: new Date("2026-09-05T08:00:00.000Z") },
        });
        await db.teamDirectorySource.update({
            where: { id: healthy.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        // The repository raises this exact class when its own ownership model is
        // broken (a bound identity that lost its source, a Group binding that
        // vanished mid-reconcile). Another provider read cannot repair any of
        // them, so the worker must not record a retryable outage.
        const scan = vi.fn(async ({ source }: Parameters<DirectoryProjectionScan>[0]) => {
            if (source.id === broken.id) {
                throw new DirectoryProjectionInvariantError("bound identity lost its directory source");
            }
            return { ok: true } as const;
        });

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: healthy.id });
        const recorded = await db.teamDirectorySource.findUniqueOrThrow({ where: { id: broken.id } });
        expect(recorded).toMatchObject({
            state: "needs_attention",
            activeReconcileRunId: null,
            lastErrorCode: "directory_source_identity_mismatch",
        });
        expect(NON_RETRYABLE_DIRECTORY_ERRORS.has(recorded.lastErrorCode as TeamDirectorySafeErrorCodeV1)).toBe(true);
    });

    it("records an incomplete provider scan and drains the next runnable source", async () => {
        const first = await createRunnableSource("incomplete-first");
        const second = await createRunnableSource("after-incomplete");
        await db.teamDirectorySource.update({
            where: { id: first.id },
            data: { lastAttemptAt: new Date("2026-09-05T08:00:00.000Z") },
        });
        await db.teamDirectorySource.update({
            where: { id: second.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const scan = vi.fn<DirectoryProjectionScan>(async ({ source }) => source.id === first.id
            ? { ok: false, code: "directory_snapshot_incomplete" }
            : { ok: true });

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: second.id });
        expect(scan.mock.calls.map(([input]) => input.source.id)).toEqual([first.id, second.id]);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: first.id } }))
            .resolves.toMatchObject({
                state: "needs_attention",
                activeReconcileRunId: null,
                lastErrorCode: "directory_snapshot_incomplete",
            });
    });

    it("quarantines a malformed oldest source and drains the next runnable source", async () => {
        const malformed = await createRunnableSource("malformed-oldest");
        const eligible = await createRunnableSource("after-malformed");
        await db.teamDirectorySource.update({
            where: { id: malformed.id },
            data: {
                lastAttemptAt: new Date("2026-09-05T08:00:00.000Z"),
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "wrong-kind" },
            },
        });
        await db.teamDirectorySource.update({
            where: { id: eligible.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const scan = vi.fn<DirectoryProjectionScan>(async () => ({ ok: true }));

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: eligible.id });
        expect(scan.mock.calls.map(([input]) => input.source.id)).toEqual([eligible.id]);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: malformed.id } }))
            .resolves.toMatchObject({
                state: "needs_attention",
                activeReconcileRunId: null,
                // A failed claim must not clear a durable manual request, but
                // it is the attempt that consumed it: the non-retryable error
                // keeps this source out of due selection until a new press,
                // which the request owner refuses for a mismatched binding.
                manualSyncRequestedAt: new Date("2026-09-05T10:00:00.000Z"),
                lastErrorCode: "directory_source_identity_mismatch",
            });
    });

    it("drains later runnable work when the selected source becomes stale", async () => {
        const stale = await createRunnableSource("stale-before-page");
        const next = await createRunnableSource("after-stale");
        await db.teamDirectorySource.update({
            where: { id: stale.id },
            data: { lastAttemptAt: new Date("2026-09-05T08:00:00.000Z") },
        });
        await db.teamDirectorySource.update({
            where: { id: next.id },
            data: { lastAttemptAt: new Date("2026-09-05T09:00:00.000Z") },
        });
        const scanned: string[] = [];
        const scan: DirectoryProjectionScan = async ({ source }) => {
            scanned.push(source.id);
            if (source.id === stale.id) {
                await db.teamDirectorySource.update({
                    where: { id: source.id },
                    data: {
                        state: "paused",
                        activeReconcileRunId: null,
                        activeReconcileStartedAt: null,
                    },
                });
                return { ok: false, code: "stale_run" };
            }
            return { ok: true };
        };

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: next.id });
        expect(scanned).toEqual([stale.id, next.id]);
    });

    it("stops by aborting and awaiting the active source operation before releasing the lease", async () => {
        const source = await createRunnableSource("awaited-stop");
        let notifyEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            notifyEntered = resolve;
        });
        let observedAbort = false;
        const scan: DirectoryProjectionScan = async ({ signal }) => {
            notifyEntered();
            await new Promise<void>((resolve) => {
                if (signal?.aborted) {
                    observedAbort = true;
                    resolve();
                    return;
                }
                signal?.addEventListener("abort", () => {
                    observedAbort = true;
                    resolve();
                }, { once: true });
            });
            return { ok: false, code: "stale_run" };
        };
        const worker = startEnterpriseIdentitySyncWorker({
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: "1" },
            scan,
            catchUp: async () => ({ ok: true }),
        });
        expect(worker).not.toBeNull();
        await entered;

        await worker?.stop();

        expect(observedAbort).toBe(true);
        await expect(db.globalLock.count({
            where: { key: "server.enterprise-identity.sync" },
        })).resolves.toBe(0);
        await db.teamDirectorySource.update({
            where: { id: source.id },
            data: { state: "paused", activeReconcileRunId: null, activeReconcileStartedAt: null },
        });
    });

    it("leaves a lease-lost run fenced and repairs it under the next acquired lease", async () => {
        const source = await createRunnableSource("lease-loss-repair");
        const firstScan: DirectoryProjectionScan = async () => {
            await db.globalLock.deleteMany({
                where: { key: "server.enterprise-identity.sync" },
            });
            throw new Error("provider failed after this worker lost its lease");
        };

        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan: firstScan,
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "stale" });
        const abandoned = await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } });
        expect(abandoned).toMatchObject({
            state: "initializing",
            activeReconcileRunId: expect.any(String),
        });

        const repairedRunIds: string[] = [];
        await expect(runEnterpriseIdentitySyncWorkerPass({
            scan: async ({ source: claimed }) => {
                repairedRunIds.push(claimed.reconcileRunId);
                return { ok: true };
            },
            catchUp: async () => ({ ok: true }),
        })).resolves.toEqual({ status: "completed", sourceId: source.id });
        expect(repairedRunIds).toHaveLength(1);
        expect(repairedRunIds[0]).not.toBe(abandoned.activeReconcileRunId);
        await expect(db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .resolves.toMatchObject({ state: "active", activeReconcileRunId: null });
    });
});
