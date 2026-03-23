import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export function resolveMachineServerId(machines: readonly Machine[], machineId: string | null | undefined): string | null {
    if (!machineId) return null;
    const machine = machines.find((entry) => entry.id === machineId) ?? null;
    const legacyServerIdValue = machine ? (machine as unknown as Record<string, unknown>).serverId : null;
    const legacyServerId = typeof legacyServerIdValue === 'string' ? legacyServerIdValue : null;
    return legacyServerId ?? getActiveServerSnapshot().serverId ?? null;
}
