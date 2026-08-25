function buildNewSessionContextRouteParams(params: Readonly<{
    dataId?: string | null;
    draftId?: string | null;
    targetServerId?: string | null;
}>): Readonly<{
    dataId?: string;
    draftId?: string;
    spawnServerId?: string;
}> {
    return {
        ...(params.dataId ? { dataId: params.dataId } : {}),
        ...(params.draftId ? { draftId: params.draftId } : {}),
        ...(params.targetServerId ? { spawnServerId: params.targetServerId } : {}),
    };
}

export function buildNewSessionLaunchRouteParams(params: Readonly<{
    draftId: string;
    directory?: string | null;
    machineId?: string | null;
    targetServerId?: string | null;
    worktree?: string | null;
}>): Readonly<{
    draftId: string;
    directory?: string;
    machineId?: string;
    spawnServerId?: string;
    worktree?: string;
}> {
    return {
        draftId: params.draftId,
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(params.directory ? { directory: params.directory } : {}),
        ...(params.worktree ? { worktree: params.worktree } : {}),
        ...(params.targetServerId ? { spawnServerId: params.targetServerId } : {}),
    };
}

export function buildSecretRequirementRouteParams(params: Readonly<{
    dataId?: string | null;
    draftId?: string | null;
    selectedMachineId: string | null;
    targetServerId: string | null;
}>): Readonly<{
    dataId?: string;
    draftId?: string;
    machineId?: string;
    spawnServerId?: string;
}> {
    return {
        ...buildNewSessionContextRouteParams(params),
        ...(params.selectedMachineId ? { machineId: params.selectedMachineId } : {}),
    };
}

export function buildMachinePickerRouteParams(params: Readonly<{
    dataId?: string | null;
    draftId?: string | null;
    selectedMachineId: string | null;
    targetServerId: string | null;
}>): Readonly<{
    dataId?: string;
    draftId?: string;
    selectedId?: string;
    spawnServerId?: string;
}> {
    return {
        ...buildNewSessionContextRouteParams(params),
        ...(params.selectedMachineId ? { selectedId: params.selectedMachineId } : {}),
    };
}

export function buildServerPickerRouteParams(params: Readonly<{
    dataId?: string | null;
    draftId?: string | null;
    targetServerId: string | null;
}>): Readonly<{
    dataId?: string;
    draftId?: string;
    selectedId?: string;
}> {
    return {
        ...buildNewSessionContextRouteParams(params),
        ...(params.targetServerId ? { selectedId: params.targetServerId } : {}),
    };
}

export function buildProfilePickerRouteParams(params: Readonly<{
    dataId?: string | null;
    draftId?: string | null;
    selectedProfileId: string | null;
    selectedMachineId: string | null;
    targetServerId: string | null;
}>): Readonly<{
    dataId?: string;
    draftId?: string;
    selectedId?: string;
    machineId?: string;
    spawnServerId?: string;
}> {
    return {
        ...buildNewSessionContextRouteParams(params),
        ...(params.selectedProfileId ? { selectedId: params.selectedProfileId } : {}),
        ...(params.selectedMachineId ? { machineId: params.selectedMachineId } : {}),
    };
}
