import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { forever } from "@/utils/runtime/forever";
import { shutdownSignal } from "@/utils/process/shutdown";
import {
    buildMachineActivityEphemeral,
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";
import { warn } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { expireSessionPublisherCandidates } from "./sessionPublisherPresence";

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

type ExactFenceUpdateDelegate = {
    updateMany: (args: {
        where: {
            id: string;
            active: true;
            lastActiveAt: Date;
        };
        data: { active: false };
    }) => Promise<{ count: number }>;
};

async function markTimedOutMachinesInactive(
    delegate: ExactFenceUpdateDelegate,
    candidates: TimedOutPresenceCandidate[],
): Promise<TimedOutPresenceCandidate[]> {
    const changed: TimedOutPresenceCandidate[] = [];
    for (const candidate of candidates) {
        const result = await delegate.updateMany({
            where: { id: candidate.id, active: true, lastActiveAt: candidate.lastActiveAt },
            data: { active: false },
        });
        if (result.count === 1) changed.push(candidate);
    }
    return changed;
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
        const candidateBySessionId = new Map(sessions.map((session) => [session.id, session]));
        const expiryResults = await expireSessionPublisherCandidates({
            candidates: sessions.map((session) => ({
                sessionId: session.id,
                observedFence: session.lastActiveAt,
            })),
        });
        for (const result of expiryResults) {
            if (result.status !== "expired") continue;
            for (const { accountId, cursor } of result.participantCursors) {
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildUpdateSessionUpdate(
                        result.sessionId,
                        cursor,
                        randomKeyNaked(12),
                        undefined,
                        undefined,
                        { active: false, activeAt: result.activeAt.getTime() },
                    ),
                    recipientFilter: { type: "all-interested-in-session", sessionId: result.sessionId },
                });
            }
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });
            const candidate = candidateBySessionId.get(result.sessionId);
            if (!candidate) continue;
            eventRouter.emitEphemeral({
                userId: candidate.accountId,
                payload: buildSessionActivityEphemeral(result.sessionId, false, result.activeAt.getTime(), false),
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
        const changedMachines = await markTimedOutMachinesInactive(db.machine, machines);
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
