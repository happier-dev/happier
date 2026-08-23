import type { Machine } from '@/sync/domains/state/storageTypes';

type MachineDaemonCliVersionState = Readonly<{
    machines: Readonly<Record<string, Machine | undefined>>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
}>;

export function readMachineDaemonCliVersionForServerScope(params: Readonly<{
    state: MachineDaemonCliVersionState;
    machineId: string;
    serverId?: string | null;
    activeServerId?: string | null;
}>): string | null {
    const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
    if (!machineId) return null;

    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const activeServerId = typeof params.activeServerId === 'string' ? params.activeServerId.trim() : '';
    const machine = !serverId || serverId === activeServerId
        ? params.state.machines[machineId]
        : activeServerId
            ? params.state.machineListByServerId?.[serverId]?.find((candidate) => candidate.id === machineId)
            : undefined;
    const version = machine?.daemonState?.cliVersion;
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null;
}
