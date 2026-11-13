import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { formatApprovalDecisionFailureLabel, formatApprovalStatusLabel, formatToolPermissionDecisionLabel } from '@/components/approvals/approvalStatusLabel';
import { resolveToolActionFailure, toolActionOutcomeLabel } from '@/components/tools/shell/presentation/resolveToolActionFailure';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { readDeclinedApprovalAtToolCall } from '@/components/tools/shell/views/toolApprovalPromptMatching';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { projectReviewToolMessage } from '@/components/sessions/reviews/messages/projectReviewToolMessage';

export type ToolCallsGroupStatus = 'running' | 'completed' | 'stopped' | 'error' | 'refused' | 'permission_denied';

/** What a group's header says: its one status, and how many calls failed or were refused. */
export type ToolCallsGroupSummary = Readonly<{
    status: ToolCallsGroupStatus;
    failed: number;
    refused: number;
    /** Decision words come from the same presenter as the tool row. Absent for ordinary policy refusals. */
    refusalLabel?: string;
    /** True when a typed Action failure is among the failures, so the header uses the row's word ("Failed"). */
    failuresAreActionOutcomes: boolean;
}>;

export function resolveToolCallsGroupSummary(params: Readonly<{
    toolMessages: readonly ToolCallMessage[];
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
    showToolCalls?: boolean;
    /** The Session's approvals: a call whose Action approval the person declined is a refusal, never a success. */
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    sessionId?: string;
}>): ToolCallsGroupSummary {
    let failed = 0;
    let refused = 0;
    const refusalLabels = new Set<string>();
    let hasDecisionRefusal = false;
    let failuresAreActionOutcomes = false;
    let sawPermissionDenied = false;
    let sawRunning = false;
    let sawStopped = false;
    for (const message of params.toolMessages) {
        const tool = resolveInactiveSessionToolCallFailure({
            tool: projectReviewToolMessage(message).tool,
            permissionDisabledReason: params.permissionDisabledReason,
        });
        const declinedApproval = readDeclinedApprovalAtToolCall({
            requests: params.approvalRequests,
            sessionId: params.sessionId,
            messageId: message.id,
            tool,
        });
        const kind = resolveToolStatusIndicatorKind(tool, declinedApproval);
        if (kind === 'stopped') sawStopped = true;
        if (kind === 'running' || kind === 'permission_pending') sawRunning = true;
        if (kind === 'error') {
            // A refused call is the product saying no, not a break: it outranks nothing that failed.
            const actionFailure = resolveToolActionFailure(tool);
            if (actionFailure?.outcome === 'refused') {
                refused += 1;
                const decisionLabel = formatApprovalDecisionFailureLabel(actionFailure.code);
                hasDecisionRefusal ||= decisionLabel !== null;
                refusalLabels.add(decisionLabel ?? toolActionOutcomeLabel('refused'));
            } else {
                failed += 1;
                if (actionFailure) failuresAreActionOutcomes = true;
            }
        }
        if (kind === 'permission_blocked') {
            const decisionLabel = formatToolPermissionDecisionLabel(tool.permission);
            if (decisionLabel) {
                refused += 1;
                hasDecisionRefusal = true;
                refusalLabels.add(decisionLabel);
            } else if (tool.permission?.status === 'denied') sawPermissionDenied = true;
            // A declined Action approval has no permission request: the Action was refused by the person.
            else {
                refused += 1;
                if (declinedApproval) {
                    hasDecisionRefusal = true;
                    refusalLabels.add(formatApprovalStatusLabel(declinedApproval));
                } else refusalLabels.add(toolActionOutcomeLabel('refused'));
            }
        }
    }
    const status: ToolCallsGroupStatus =
        sawRunning && params.showToolCalls !== false ? 'running'
            : failed > 0 ? 'error'
                : refused > 0 ? 'refused'
                    : sawPermissionDenied ? 'permission_denied'
                        : sawStopped ? 'stopped'
                        : sawRunning ? 'running'
                            : 'completed';
    return { status, failed, refused, failuresAreActionOutcomes,
        ...(hasDecisionRefusal ? { refusalLabel: [...refusalLabels].join(' · ') } : {}),
    };
}

/** Shared row visibility for virtualized groups and whole-group transcript hosts. */
export function resolveToolCallsGroupPresentation<T>(params: Readonly<{
    toolCalls: readonly T[];
    expanded: boolean;
    collapsedPreviewCount: number;
    showToolCalls?: boolean;
}>) {
    const previewCount = params.showToolCalls === false ? 0 : Number.isFinite(params.collapsedPreviewCount)
        ? Math.max(0, Math.trunc(params.collapsedPreviewCount))
        : 0;
    const visibleToolCalls = params.expanded
        ? params.toolCalls
        : previewCount > 0
            ? params.toolCalls.slice(-previewCount)
            : [];
    const hiddenCount = params.toolCalls.length - visibleToolCalls.length;
    return {
        visibleToolCalls,
        hiddenCount,
        showExpandMore: !params.expanded && visibleToolCalls.length > 0 && hiddenCount > 0,
        showBody: visibleToolCalls.length > 0,
    };
}

/** The header owns group disclosure; ordinary activity is presented at Session scope. */
export function shouldShowToolCallsGroupStatusIndicator(input: Readonly<{
    showToolCalls?: boolean;
    status: ToolCallsGroupStatus;
}>) {
    return input.showToolCalls !== false || (input.status !== 'running' && input.status !== 'completed');
}
