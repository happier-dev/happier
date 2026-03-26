import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';

export function resolveToolPermissionTerminalErrorMessage(params: Readonly<{
    tool: ToolCall;
    metadata: Metadata | null;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
}>): string | null {
    const permission = params.tool.permission;
    if (!permission) return null;
    if (permission.status !== 'denied' && permission.status !== 'canceled') return null;

    if (permission.status === 'denied') {
        const canBlameReadOnlyMode = (() => {
            if (params.metadata?.permissionMode !== 'read-only') return false;
            const agentId = resolveAgentIdFromFlavor(params.metadata?.flavor);
            if (!agentId) return false;
            const core = getAgentCore(agentId);
            return core.permissions?.modeGroup === 'codexLike';
        })();

        return canBlameReadOnlyMode
            ? t('errors.permissionDeniedReadOnlyMode')
            : t('errors.permissionDenied');
    }

    // canceled
    if (params.permissionDisabledReason === 'inactive') {
        return t('errors.permissionCanceledSessionInactive');
    }
    return t('errors.permissionCanceled');
}
