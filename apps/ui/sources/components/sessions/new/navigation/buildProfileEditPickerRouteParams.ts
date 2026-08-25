import type { SerializedBackendTargetRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';

export function buildProfileEditPickerRouteParams(params: Readonly<{
    backendTargetRouteParams: SerializedBackendTargetRouteParams;
    dataId?: string;
    draftId?: string;
    machineId?: string;
    spawnServerId?: string;
    nextParams: Readonly<Record<string, string>>;
}>): Readonly<Record<string, string>> {
    return {
        ...params.backendTargetRouteParams,
        ...(params.dataId ? { dataId: params.dataId } : {}),
        ...(params.draftId ? { draftId: params.draftId } : {}),
        ...params.nextParams,
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(params.spawnServerId ? { spawnServerId: params.spawnServerId } : {}),
    };
}
