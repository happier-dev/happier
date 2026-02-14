import type { AgentState } from '@/sync/domains/state/storageTypes';

export function getPermissionsInUiWhileLocal(capabilities: AgentState['capabilities'] | null | undefined): boolean {
    if (!capabilities) return false;
    return capabilities.permissionsInUiWhileLocal === true || capabilities.localPermissionBridgeInLocalMode === true;
}

