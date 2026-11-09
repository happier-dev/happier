import { readTranscriptSessionMediaMeta } from '../structured/happierMetaEnvelope';
import type { ParsedSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import type { ToolCall, ToolCallMessage } from '@happier-dev/session-core/messages';
import { readTurnChangesFromDiffTool, type TurnChangesFromDiffTool } from '@/components/sessions/files/turnChanges/readTurnChangesFromDiffTool';

/** The transcript tool row's display decision, shared with its pre-mount text projection. */
export function deriveToolMessageDisplay(params: Readonly<{
    tool: ToolCall;
    meta?: ToolCallMessage['meta'];
    /** The call is drawn as its Ask record, which replaces the generic tool row. */
    presentedAsAskRecord?: boolean;
}>): Readonly<{ turnChanges: TurnChangesFromDiffTool | null; shouldRenderToolChrome: boolean; sessionMedia: ParsedSessionMediaMessageMeta | null }> {
    const sessionMedia = readTranscriptSessionMediaMeta(params.meta);
    const turnChanges = readTurnChangesFromDiffTool(params.tool);
    const showsTurnChangesCard = turnChanges !== null && turnChanges.files.length > 0;
    return {
        sessionMedia,
        turnChanges: showsTurnChangesCard ? turnChanges : null,
        shouldRenderToolChrome: !showsTurnChangesCard && params.presentedAsAskRecord !== true,
    };
}
