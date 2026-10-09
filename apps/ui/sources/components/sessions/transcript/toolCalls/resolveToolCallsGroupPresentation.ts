import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';

export type ToolCallsGroupStatus = 'running' | 'completed' | 'error' | 'permission_denied' | 'permission_canceled';

export function resolveToolCallsGroupStatus(params: Readonly<{
    toolMessages: readonly ToolCallMessage[];
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
    showToolCalls?: boolean;
}>): ToolCallsGroupStatus {
    let sawError = false;
    let sawPermissionDenied = false;
    let sawPermissionCanceled = false;
    let sawRunning = false;
    for (const message of params.toolMessages) {
        const tool = resolveInactiveSessionToolCallFailure({
            tool: message.tool,
            permissionDisabledReason: params.permissionDisabledReason,
        });
        const kind = resolveToolStatusIndicatorKind(tool);
        if (kind === 'running' || kind === 'permission_pending') {
            if (params.showToolCalls !== false) return 'running';
            sawRunning = true;
        }
        if (kind === 'error') sawError = true;
        if (kind === 'permission_blocked') {
            if (tool.permission?.status === 'denied') sawPermissionDenied = true;
            else sawPermissionCanceled = true;
        }
    }
    if (sawError) return 'error';
    if (sawPermissionDenied) return 'permission_denied';
    if (sawPermissionCanceled) return 'permission_canceled';
    if (sawRunning) return 'running';
    return 'completed';
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
