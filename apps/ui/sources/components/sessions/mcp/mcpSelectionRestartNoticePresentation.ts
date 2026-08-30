import {
    areSessionMcpSelectionsEquivalent,
    readSessionMcpSelectionRestartRequiredV1FromMetadata,
    readSessionMcpSelectionV1FromMetadata,
} from '@happier-dev/protocol';

import type { AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';

export type McpSelectionRestartNoticeTranslationKey =
    | 'session.mcpRestartRequired.title'
    | 'session.mcpRestartRequired.body'
    | 'session.mcpRestartRequired.failureBody'
    | 'session.mcpRestartRequired.restartAction'
    | 'session.mcpRestartRequired.restartPendingAction'
    | 'session.mcpRestartRequired.badgeLabel';

export type McpSelectionRestartNoticeTranslate = (
    key: McpSelectionRestartNoticeTranslationKey,
) => string;

export type McpSelectionRestartOperationStatus = 'pending' | 'failed' | 'restarted' | null;

export type McpSelectionRestartNoticePresentation = Readonly<{
    fingerprint: string;
    banner: Readonly<{
        testID: string;
        title: string;
        body: string;
        primaryAction: Readonly<{
            label: string;
            accessibilityLabel: string;
            testID: string;
            disabled: boolean;
        }>;
    }>;
    badge: Readonly<{
        key: string;
        label: string;
        testID: string;
        accessibilityLabel: string;
        tone: AgentInputStatusBadgeTone;
    }>;
}>;

export function buildMcpSelectionRestartNoticePresentation(params: Readonly<{
    sessionActive: boolean;
    metadata: unknown;
    operationStatus: McpSelectionRestartOperationStatus;
    translate: McpSelectionRestartNoticeTranslate;
}>): McpSelectionRestartNoticePresentation | null {
    if (!params.sessionActive || params.operationStatus === 'restarted') return null;

    const desiredSelection = readSessionMcpSelectionV1FromMetadata(params.metadata);
    const marker = readSessionMcpSelectionRestartRequiredV1FromMetadata(params.metadata);
    if (
        !desiredSelection
        || !marker
        || areSessionMcpSelectionsEquivalent(desiredSelection, marker.appliedSelection)
    ) {
        return null;
    }

    const pending = params.operationStatus === 'pending';
    const actionLabel = params.translate(pending
        ? 'session.mcpRestartRequired.restartPendingAction'
        : 'session.mcpRestartRequired.restartAction');
    const badgeLabel = params.translate('session.mcpRestartRequired.badgeLabel');

    return {
        fingerprint: JSON.stringify({ desiredSelection, appliedSelection: marker.appliedSelection }),
        banner: {
            testID: 'session.mcpSelectionRestartRequired.banner',
            title: params.translate('session.mcpRestartRequired.title'),
            body: params.translate(params.operationStatus === 'failed'
                ? 'session.mcpRestartRequired.failureBody'
                : 'session.mcpRestartRequired.body'),
            primaryAction: {
                label: actionLabel,
                accessibilityLabel: actionLabel,
                testID: 'session.mcpSelectionRestartRequired.restart',
                disabled: pending,
            },
        },
        badge: {
            key: 'session-mcp-selection-restart-required',
            label: badgeLabel,
            testID: 'session.mcpSelectionRestartRequired.badge',
            accessibilityLabel: badgeLabel,
            tone: 'warning',
        },
    };
}
