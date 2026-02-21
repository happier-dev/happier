import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { forever } from "@/utils/runtime/forever";
import { shutdownSignal } from "@/utils/process/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

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

export function startTimeout() {
    const timeoutConfig = resolvePresenceTimeoutConfig(process.env);
    forever('session-timeout', async () => {
        while (true) {
            // Find timed out sessions
            const sessions = await db.session.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - timeoutConfig.sessionTimeoutMs)
                    }
                }
            });
            for (const session of sessions) {
                const { count } = await db.session.updateMany({
                    where: { id: session.id, active: true },
                    data: { active: false }
                });
                if (count === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: session.accountId,
                    payload: buildSessionActivityEphemeral(session.id, false, session.lastActiveAt.getTime(), false),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Find timed out machines
            const machines = await db.machine.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - timeoutConfig.machineTimeoutMs)
                    }
                }
            });
            for (const machine of machines) {
                const { count } = await db.machine.updateMany({
                    where: { id: machine.id, active: true },
                    data: { active: false }
                });
                if (count === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: machine.accountId,
                    payload: buildMachineActivityEphemeral(machine.id, false, machine.lastActiveAt.getTime()),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            await delay(timeoutConfig.tickMs, shutdownSignal);
        }
    });
}
