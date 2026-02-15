export function buildMachinePickerRouteParams(params: Readonly<{
    selectedMachineId: string | null;
    targetServerId: string | null;
}>): Readonly<{
    selectedId?: string;
    spawnServerId?: string;
}> {
    return {
        ...(params.selectedMachineId ? { selectedId: params.selectedMachineId } : {}),
        ...(params.targetServerId ? { spawnServerId: params.targetServerId } : {}),
    };
}

export function buildServerPickerRouteParams(params: Readonly<{
    targetServerId: string | null;
}>): Readonly<{
    selectedId?: string;
}> {
    return {
        ...(params.targetServerId ? { selectedId: params.targetServerId } : {}),
    };
}

export function buildProfilePickerRouteParams(params: Readonly<{
    selectedProfileId: string | null;
    selectedMachineId: string | null;
    targetServerId: string | null;
}>): Readonly<{
    selectedId?: string;
    machineId?: string;
    spawnServerId?: string;
}> {
    return {
        ...(params.selectedProfileId ? { selectedId: params.selectedProfileId } : {}),
        ...(params.selectedMachineId ? { machineId: params.selectedMachineId } : {}),
        ...(params.targetServerId ? { spawnServerId: params.targetServerId } : {}),
    };
}
