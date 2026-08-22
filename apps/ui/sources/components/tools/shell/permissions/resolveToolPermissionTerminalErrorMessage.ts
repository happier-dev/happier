import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { getAgentCore } from '@/agents/catalog/catalog';
import { t } from '@/text';

export function resolveToolPermissionTerminalErrorMessage(params: Readonly<{
    tool: ToolCall;
    metadata: Metadata | null;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    /**
     * The Agent that produced this row, when the transcript has divider
     * evidence for it. This outcome is already terminal, so the Session's
     * current Agent is not who made it: after a switch, reading live metadata
     * blamed the new Agent's read-only mode for the old Agent's denial.
     * `null`/absent keeps the live-metadata answer.
     */
    historicalAgentId?: string | null;
}>): string | null {
    const permission = params.tool.permission;
    if (!permission) return null;
    if (permission.status !== 'denied' && permission.status !== 'canceled') return null;

    if (permission.status === 'denied') {
        const canBlameReadOnlyMode = (() => {
            if (params.metadata?.permissionMode !== 'read-only') return false;
            const agentId = params.historicalAgentId ?? resolveAgentIdFromSessionMetadata(params.metadata);
            if (!agentId) return false;
            return getAgentCore(agentId)?.permissions?.modeGroup === 'codexLike';
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
