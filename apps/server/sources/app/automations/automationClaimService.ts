import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

import { emitAutomationRunUpdated } from "./automationChangePublisher";
import type { AutomationRunWithAutomation } from "./automationTypes";

export function resolveClaimLeaseExpiresAt(params: { now: Date; leaseDurationMs: number }): Date {
    const leaseMs = Number.isFinite(params.leaseDurationMs)
        ? Math.min(Math.max(Math.floor(params.leaseDurationMs), 5_000), 15 * 60_000)
        : 30_000;
    return new Date(params.now.getTime() + leaseMs);
}

export function isRunClaimableState(params: {
    state: string;
    leaseExpiresAt: Date | null;
    now: Date;
}): boolean {
    if (params.state === "queued") return true;
    if (params.state !== "claimed" && params.state !== "running") return false;
    if (!params.leaseExpiresAt) return false;
    return params.leaseExpiresAt.getTime() < params.now.getTime();
}

async function findClaimCandidates(params: {
    tx: Tx;
    accountId: string;
    machineId: string;
    now: Date;
    limit: number;
}) {
    return await params.tx.automationRun.findMany({
        where: {
            accountId: params.accountId,
            dueAt: { lte: params.now },
            OR: [
                { state: "queued" },
                { state: "claimed", leaseExpiresAt: { lt: params.now } },
                { state: "running", leaseExpiresAt: { lt: params.now } },
            ],
            automation: {
                enabled: true,
                assignments: {
                    some: {
                        machineId: params.machineId,
                        enabled: true,
                    },
                },
            },
        },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
        take: params.limit,
        select: {
            id: true,
            state: true,
            leaseExpiresAt: true,
        },
    });
}

async function tryClaimRun(params: {
    tx: Tx;
    runId: string;
    previousState: string;
    now: Date;
    machineId: string;
    leaseExpiresAt: Date;
}) {
    if (params.previousState === "queued") {
        return await params.tx.automationRun.updateMany({
            where: {
                id: params.runId,
                state: "queued",
            },
            data: {
                state: "claimed",
                claimedAt: params.now,
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: { increment: 1 },
            },
        });
    }

    const previousState = params.previousState === "running" ? "running" : "claimed";
    return await params.tx.automationRun.updateMany({
        where: {
            id: params.runId,
            state: previousState,
            leaseExpiresAt: { lt: params.now },
        },
        data: {
            state: "claimed",
            claimedAt: params.now,
            claimedByMachineId: params.machineId,
            leaseExpiresAt: params.leaseExpiresAt,
            attempt: { increment: 1 },
        },
    });
}

async function fetchClaimedRun(tx: Tx, runId: string): Promise<AutomationRunWithAutomation | null> {
    const row = await tx.automationRun.findUnique({
        where: { id: runId },
        select: {
            id: true,
            automationId: true,
            accountId: true,
            state: true,
            scheduledAt: true,
            dueAt: true,
            claimedAt: true,
            startedAt: true,
            finishedAt: true,
            claimedByMachineId: true,
            leaseExpiresAt: true,
            attempt: true,
            summaryCiphertext: true,
            errorCode: true,
            errorMessage: true,
            producedSessionId: true,
            createdAt: true,
            updatedAt: true,
            automation: {
                select: {
                    id: true,
                    name: true,
                    enabled: true,
                    targetType: true,
                    templateCiphertext: true,
                },
            },
        },
    });

    if (!row) return null;
    return row as AutomationRunWithAutomation;
}

export async function claimAutomationRun(params: {
    accountId: string;
    machineId: string;
    leaseDurationMs: number;
}): Promise<{ run: AutomationRunWithAutomation | null }> {
    return await inTx(async (tx) => {
        const machine = await tx.machine.findFirst({
            where: {
                accountId: params.accountId,
                id: params.machineId,
            },
            select: { id: true },
        });
        if (!machine) {
            return { run: null };
        }

        const now = new Date();
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });

        const candidates = await findClaimCandidates({
            tx,
            accountId: params.accountId,
            machineId: params.machineId,
            now,
            limit: 25,
        });

        for (const candidate of candidates) {
            if (!isRunClaimableState({
                state: candidate.state,
                leaseExpiresAt: candidate.leaseExpiresAt,
                now,
            })) {
                continue;
            }

            const updated = await tryClaimRun({
                tx,
                runId: candidate.id,
                previousState: candidate.state,
                now,
                machineId: params.machineId,
                leaseExpiresAt,
            });
            if (updated.count !== 1) {
                continue;
            }

            const run = await fetchClaimedRun(tx, candidate.id);
            if (!run) {
                continue;
            }

            const cursor = await markAccountChanged(tx, {
                accountId: params.accountId,
                kind: "automation",
                entityId: run.automationId,
            });

            afterTx(tx, () => {
                emitAutomationRunUpdated({
                    accountId: params.accountId,
                    run,
                    cursor,
                });
            });

            return { run };
        }

        return { run: null };
    });
}

export async function heartbeatAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    leaseDurationMs: number;
}): Promise<{ ok: boolean; leaseExpiresAt: Date | null }> {
    return await inTx(async (tx) => {
        const now = new Date();
        const leaseExpiresAt = resolveClaimLeaseExpiresAt({ now, leaseDurationMs: params.leaseDurationMs });

        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                state: { in: ["claimed", "running"] },
            },
            data: {
                leaseExpiresAt,
                updatedAt: now,
            },
        });

        if (updated.count !== 1) {
            return { ok: false, leaseExpiresAt: null };
        }

        return { ok: true, leaseExpiresAt };
    });
}
