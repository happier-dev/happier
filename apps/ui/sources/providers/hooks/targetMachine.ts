type ProviderSettingsMachine = Readonly<{
    id: string;
    active?: boolean | null;
    revokedAt?: number | null;
}>;

export function resolveProviderSettingsTargetMachine(input: Readonly<{
    serverId: string | null;
    preferredMachineId?: string | null;
    machines: readonly ProviderSettingsMachine[];
    machineListByServerId: Readonly<Record<string, readonly ProviderSettingsMachine[] | null | undefined>>;
}>): string | null {
    const eligible = listProviderSettingsTargetMachines(input);
    if (input.preferredMachineId && eligible.some((machine) => machine.id === input.preferredMachineId)) {
        return input.preferredMachineId;
    }
    return eligible.find((machine) => machine.active === true)?.id ?? eligible[0]?.id ?? null;
}

export function listProviderSettingsTargetMachines(input: Readonly<{
    serverId: string | null;
    machines: readonly ProviderSettingsMachine[];
    machineListByServerId: Readonly<Record<string, readonly ProviderSettingsMachine[] | null | undefined>>;
}>): readonly ProviderSettingsMachine[] {
    if (!input.serverId) return [];
    const explicit = input.machineListByServerId[input.serverId];
    if (Array.isArray(explicit)) {
        return explicit.filter((machine) => machine.revokedAt == null);
    }
    const claimedElsewhere = new Set<string>();
    for (const [serverId, machines] of Object.entries(input.machineListByServerId)) {
        if (serverId === input.serverId || !Array.isArray(machines)) continue;
        for (const machine of machines) if (machine.revokedAt == null) claimedElsewhere.add(machine.id);
    }
    return input.machines.filter((machine) => machine.revokedAt == null && !claimedElsewhere.has(machine.id));
}
