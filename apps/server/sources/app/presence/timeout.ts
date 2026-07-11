import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { forever } from "@/utils/runtime/forever";
import { shutdownSignal } from "@/utils/process/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { warn } from "@/utils/logging/log";

export interface PresenceTimeoutConfig {
    sessionTimeoutMs: number;
    machineTimeoutMs: number;
    tickMs: number;
}

const DEFAULT_PRESENCE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRESENCE_MACHINE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PRESENCE_TIMEOUT_TICK_MS = 60 * 1000;

export function resolvePresenceTimeoutConfig(env: NodeJS.ProcessEnv = process.env): PresenceTimeoutConfig {
    return {
        sessionTimeoutMs: parseIntEnv(env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS, DEFAULT_PRESENCE_SESSION_TIMEOUT_MS, { min: 1 }),
        machineTimeoutMs: parseIntEnv(env.HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS, DEFAULT_PRESENCE_MACHINE_TIMEOUT_MS, { min: 1 }),
        tickMs: parseIntEnv(env.HAPPIER_PRESENCE_TIMEOUT_TICK_MS, DEFAULT_PRESENCE_TIMEOUT_TICK_MS, { min: 1 }),
    };
}

export function isSessionPresenceFresh(input: Readonly<{
    active: boolean | null | undefined;
    lastActiveAt: Date | null | undefined;
    nowMs: number;
    timeoutMs?: number;
}>): boolean {
    const timeoutMs = input.timeoutMs ?? resolvePresenceTimeoutConfig().sessionTimeoutMs;
    return input.active === true
        && input.lastActiveAt instanceof Date
        && Number.isFinite(input.lastActiveAt.getTime())
        && input.lastActiveAt.getTime() + timeoutMs > input.nowMs;
}

type TimedOutPresenceCandidate = {
    id: string;
    accountId: string;
    lastActiveAt: Date;
};

type UpdateManyAndReturnDelegate = {
    updateManyAndReturn?: (args: {
        where: {
            id: { in: string[] };
            active: true;
        };
        data: { active: false };
        select: { id: true; accountId: true; lastActiveAt: true };
    }) => Promise<TimedOutPresenceCandidate[]>;
    updateMany: (args: {
        where: {
            id: { in: string[] };
            active: true;
        };
        data: { active: false };
    }) => Promise<{ count: number }>;
};

async function markTimedOutRowsInactive(
    delegate: UpdateManyAndReturnDelegate,
    candidates: TimedOutPresenceCandidate[],
): Promise<TimedOutPresenceCandidate[]> {
    if (candidates.length === 0) return [];

    const ids = candidates.map((candidate) => candidate.id);
    const where = { id: { in: ids }, active: true } as const;
    const data = { active: false } as const;

    if (delegate.updateManyAndReturn) {
        return await delegate.updateManyAndReturn({
            where,
            data,
            select: { id: true, accountId: true, lastActiveAt: true },
        });
    }

    const { count } = await delegate.updateMany({ where, data });
    // Without RETURNING support, exact changed IDs are unknowable after a race. Emit only when
    // every candidate was updated; otherwise stay conservative and let the next tick observe remaining active rows.
    return count === candidates.length ? candidates : [];
}

export async function runPresenceTimeoutTick(timeoutConfig: PresenceTimeoutConfig): Promise<void> {
    try {
        const sessions = await db.session.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(Date.now() - timeoutConfig.sessionTimeoutMs)
                }
            },
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        const changedSessions = await markTimedOutRowsInactive(db.session, sessions);
        for (const session of changedSessions) {
            eventRouter.emitEphemeral({
                userId: session.accountId,
                payload: buildSessionActivityEphemeral(session.id, false, session.lastActiveAt.getTime(), false),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }
    } catch (error) {
        if (!isRetryableSqliteWriteError(error)) throw error;
        warn({ module: "presence-timeout", error }, "Transient DB error while timing out sessions");
        return;
    }

    try {
        const machines = await db.machine.findMany({
            where: {
                active: true,
                lastActiveAt: {
                    lte: new Date(Date.now() - timeoutConfig.machineTimeoutMs)
                }
            },
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        const changedMachines = await markTimedOutRowsInactive(db.machine, machines);
        for (const machine of changedMachines) {
            eventRouter.emitEphemeral({
                userId: machine.accountId,
                payload: buildMachineActivityEphemeral(machine.id, false, machine.lastActiveAt.getTime()),
                recipientFilter: { type: 'user-scoped-only' }
            });
        }
    } catch (error) {
        if (!isRetryableSqliteWriteError(error)) throw error;
        warn({ module: "presence-timeout", error }, "Transient DB error while timing out machines");
    }
}

export function startTimeout() {
    const timeoutConfig = resolvePresenceTimeoutConfig(process.env);
    forever('session-timeout', async () => {
        while (true) {
            await runPresenceTimeoutTick(timeoutConfig);
            await delay(timeoutConfig.tickMs, shutdownSignal);
        }
    });
}
