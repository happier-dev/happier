import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Settings } from '@/sync/domains/settings/settings';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { readTurnChangesFromDiffTool, type TurnChangesFromDiffTool } from '@/components/sessions/files/turnChanges/readTurnChangesFromDiffTool';

/** The transcript tool row's display decision, shared with its pre-mount text projection. */
export function deriveToolMessageDisplay(params: Readonly<{
    tool: ToolCall;
    hasStructuredNode: boolean;
    toolViewTimelineChromeMode?: Settings['toolViewTimelineChromeMode'];
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}>): Readonly<{ turnChanges: TurnChangesFromDiffTool | null; shouldRenderToolChrome: boolean }> {
    const turnChanges = readTurnChangesFromDiffTool(params.tool);
    const showsTurnChangesCard = turnChanges !== null && turnChanges.files.length > 0;
    const toolForSession = resolveInactiveSessionToolCallFailure({
        tool: params.tool,
        permissionDisabledReason: params.permissionDisabledReason,
    });
    const statusKind = resolveToolStatusIndicatorKind(toolForSession);
    const forceChromeForStatus = statusKind === 'error' || statusKind === 'permission_blocked';
    return {
        turnChanges: showsTurnChangesCard ? turnChanges : null,
        shouldRenderToolChrome: !showsTurnChangesCard && !(params.toolViewTimelineChromeMode === 'activity_feed'
            && params.hasStructuredNode && !forceChromeForStatus),
    };
}
