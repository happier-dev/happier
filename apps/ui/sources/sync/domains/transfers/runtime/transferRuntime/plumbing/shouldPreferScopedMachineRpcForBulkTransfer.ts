import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';

export function shouldPreferScopedMachineRpcForBulkTransfer(input: Readonly<{
    serverId?: string | null;
    machineId: string;
}>): boolean {
    const cached = readCachedMachineRpcDirectRoute({
        serverId: input.serverId,
        remoteMachineId: input.machineId,
    });
    return cached.status === 'unavailable';
}
