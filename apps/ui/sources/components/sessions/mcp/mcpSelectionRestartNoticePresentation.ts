import {
    areSessionMcpSelectionsEquivalent,
    readSessionMcpSelectionRestartRequiredV1FromMetadata,
    readSessionMcpSelectionV1FromMetadata,
} from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

import type { AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';

export type McpSelectionRestartOperationStatus = 'pending' | 'failed' | 'restarted' | null;

export function buildMcpSelectionRestartNoticePresentation(input: Readonly<{
    sessionActive: boolean;
    metadata: unknown;
    operationStatus: McpSelectionRestartOperationStatus;
    translate: (key: string) => string;
}>): Readonly<{
    fingerprint: string;
    banner: Readonly<{
        testID: string;
        actionTestID: string;
        title: string;
        body: string;
        actionLabel: string;
        actionAccessibilityLabel: string;
        actionBusy: boolean;
        disabled: boolean;
    }>;
    statusBadge: Readonly<{
        key: string;
        label: string;
        testID: string;
        accessibilityLabel: string;
        tone: AgentInputStatusBadgeTone;
    }>;
}> | null {
    if (!input.sessionActive || input.operationStatus === 'restarted') return null;
    const desiredSelection = readSessionMcpSelectionV1FromMetadata(input.metadata);
    const marker = readSessionMcpSelectionRestartRequiredV1FromMetadata(input.metadata);
    if (!desiredSelection || !marker || areSessionMcpSelectionsEquivalent(desiredSelection, marker.appliedSelection)) {
        return null;
    }

    const pending = input.operationStatus === 'pending';
    const actionLabel = input.translate(pending
        ? 'session.mcpRestartRequired.actions.restarting'
        : 'session.mcpRestartRequired.actions.restart');
    const badgeLabel = input.translate('session.mcpRestartRequired.status.changed');
    return {
        fingerprint: JSON.stringify({ desiredSelection, appliedSelection: marker.appliedSelection }),
        banner: {
            testID: 'session.mcpSelectionRestartRequired.banner',
            actionTestID: 'session.mcpSelectionRestartRequired.restart',
            title: input.translate('session.mcpRestartRequired.banner.title'),
            body: input.translate(input.operationStatus === 'failed'
                ? 'session.mcpRestartRequired.banner.failedBody'
                : 'session.mcpRestartRequired.banner.body'),
            actionLabel,
            actionAccessibilityLabel: actionLabel,
            actionBusy: pending,
            disabled: pending,
        },
        statusBadge: {
            key: 'session-mcp-selection-restart-required',
            label: badgeLabel,
            testID: 'session.mcpSelectionRestartRequired.badge',
            accessibilityLabel: badgeLabel,
            tone: 'warning',
        },
    };
}
