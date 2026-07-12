import type { AgentState } from '@/sync/domains/state/storageTypes';

export function getPermissionsInUiWhileLocal(capabilities: AgentState['capabilities'] | null | undefined): boolean {
    if (!capabilities) return false;
    return capabilities.permissionsInUiWhileLocal === true || capabilities.localPermissionBridgeInLocalMode === true;
}

export function getStructuredQuestionAnswersV1Supported(
    capabilities: unknown,
): boolean {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
    return (capabilities as Readonly<Record<string, unknown>>).structuredQuestionAnswersV1Supported === true;
}
