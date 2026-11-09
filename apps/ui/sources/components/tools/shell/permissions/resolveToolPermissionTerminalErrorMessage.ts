import { getAgentSessionModeDescriptor, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';

import { formatToolPermissionDecisionLabel } from '@/components/approvals/approvalStatusLabel';
import { t } from '@/text';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

export function resolveToolPermissionTerminalErrorMessage(params: Readonly<{
    tool: ToolCall;
    metadata: Metadata | null;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
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
    const decision = formatToolPermissionDecisionLabel(permission);
    if (decision) return decision;
    if (permission?.status !== 'denied') return null;
    const canBlameReadOnlyMode = (() => {
        if (params.metadata?.permissionMode !== 'read-only') return false;
        const agentId = params.historicalAgentId ?? resolveAgentIdFromSessionMetadata(params.metadata);
        if (!agentId) return false;
        const descriptor = getAgentSessionModeDescriptor(agentId);
        return descriptor != null && descriptor.source !== 'provider-native';
    })();
    return canBlameReadOnlyMode
        ? t('errors.permissionDeniedReadOnlyMode')
        : t('errors.permissionDenied');
}
