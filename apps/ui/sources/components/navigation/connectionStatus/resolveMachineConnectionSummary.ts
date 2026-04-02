export type MachineConnectionSummary =
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'single'; label: string; online: boolean }>
    | Readonly<{ kind: 'multiple'; onlineCount: number; offlineCount: number }>;

export function resolveMachineConnectionSummary(params: Readonly<{
    machineCount: number;
    onlineCount: number;
    hasUnknownMachines: boolean;
    primaryMachineLabel: string | null;
}>): MachineConnectionSummary {
    if (params.hasUnknownMachines && params.machineCount === 0) {
        return { kind: 'unknown' };
    }

    if (params.machineCount <= 0) {
        return { kind: 'none' };
    }

    const onlineCount = Math.max(0, Math.min(params.machineCount, params.onlineCount));
    const offlineCount = Math.max(0, params.machineCount - onlineCount);

    if (params.machineCount === 1) {
        return {
            kind: 'single',
            label: params.primaryMachineLabel ?? 'machine',
            online: onlineCount === 1,
        };
    }

    return {
        kind: 'multiple',
        onlineCount,
        offlineCount,
    };
}
