import { eventRouter } from "@/app/events/eventRouter";
import { resolvePresenceTimeoutConfig } from "@/app/presence/timeout";
import { db } from "@/storage/db";

export function hasExactMachineScopedConnection(accountId: string, machineId: string): boolean {
    const connections = eventRouter.getConnections(accountId);
    if (!connections) return false;
    for (const connection of connections) {
        if (connection.connectionType !== "machine-scoped") continue;
        if (connection.machineId !== machineId) continue;
        if (connection.socket.connected === false) continue;
        return true;
    }
    return false;
}

export async function hasExactMachineReadiness(accountId: string, machineId: string): Promise<boolean> {
    const hasLocalExactConnection = hasExactMachineScopedConnection(accountId, machineId);
    const { machineTimeoutMs } = resolvePresenceTimeoutConfig(process.env);
    const machine = await db.machine.findFirst({
        where: {
            accountId,
            id: machineId,
            revokedAt: null,
            replacedByMachineId: null,
            ...(hasLocalExactConnection
                ? {}
                : {
                    active: true,
                    lastActiveAt: {
                        gte: new Date(Date.now() - machineTimeoutMs),
                    },
                }),
        },
    });

    return Boolean(machine);
}
