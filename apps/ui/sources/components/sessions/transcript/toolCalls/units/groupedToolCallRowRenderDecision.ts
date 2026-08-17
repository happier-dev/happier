import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

/**
 * Pure render decisions for one grouped tool-call row.
 *
 * These live apart from `groupedToolCallRowContent.tsx` so the transcript MEASUREMENT layer can
 * consume the very same decision (see `groupedToolCallRowPaintDependsOnGroupExpansion`) without
 * importing the renderer graph (`MessageView`/`ToolView`/`ToolTimelineRow`). This module is the
 * single owner of "what does a grouped tool row render, and when does group expansion change it".
 */

export type GroupedToolCallChromeMode = 'activity_feed' | 'cards';

const GROUPED_TOOL_CALL_CHROME_MODES = [
    'activity_feed',
    'cards',
] as const satisfies readonly GroupedToolCallChromeMode[];

export function shouldRenderGroupedToolCallWithMessageView(
    message: ToolCallMessage,
    chromeMode: GroupedToolCallChromeMode,
    groupExpanded: boolean,
): boolean {
    if (chromeMode === 'cards') {
        return true;
    }
    const hasStructuredMeta = Boolean(message.meta?.happier);
    if (hasStructuredMeta) return true;

    // Avoid switching the renderer for subagent tool calls based on streaming children.
    // Otherwise the row remounts (ToolTimelineRow → MessageView) and the user's expanded/collapsed state resets.
    if (isSubAgentTranscriptToolName(message.tool?.name ?? '')) {
        return groupExpanded;
    }

    return false;
}

export function resolveGroupedPreviewSidechainIds(params: Readonly<{
    chromeMode: GroupedToolCallChromeMode;
    previewMessages: readonly ToolCallMessage[];
}>): readonly string[] {
    if (params.chromeMode !== 'activity_feed') {
        return [];
    }

    const sidechainIds = new Set<string>();
    for (const message of params.previewMessages) {
        const toolName = typeof message.tool?.name === 'string' ? message.tool.name : '';
        if (!isSubAgentTranscriptToolName(toolName)) continue;
        const sidechainId = resolveToolTranscriptSidechainId({
            tool: message.tool,
            normalizedToolName: toolName,
        });
        if (!sidechainId) continue;
        sidechainIds.add(sidechainId);
    }
    return [...sidechainIds];
}

/**
 * F-P1: can this row's PAINTED output differ between the expanded and collapsed group?
 *
 * Answered by QUANTIFYING over the two owners above rather than restating their rules, so a
 * renderer change that adds or removes an expansion dependency moves this answer with it and
 * no second predicate can drift from it. Two paths make a row expansion-sensitive:
 *  - the renderer swaps implementation (`ToolTimelineRow` <-> `MessageView`), and
 *  - the collapsed-preview sidechain eager-load, which only runs while collapsed and changes what
 *    the row paints once those children arrive.
 *
 * Deliberately chrome-mode-agnostic: the measurement layer holds no chrome fact, and quantifying
 * over every mode can only OVER-invalidate, never under-invalidate. It does not over-invalidate
 * today either — `cards` renders through `MessageView` for every expansion state and eager-loads
 * no preview sidechain, so it can never be the mode that contributes `true`.
 *
 * The measurement layer needs this because `ChatListInternal` wires Legend's vendored
 * `getItemSizeVersion` to the row-shell signature and the vendored `validateItemSizeVersion`
 * DELETES `sizesKnown` + `sizes` whenever that version moves: keying every grouped tool row on
 * group expansion threw away the measured height of the whole group on each expand/collapse tap.
 */
export function groupedToolCallRowPaintDependsOnGroupExpansion(message: ToolCallMessage): boolean {
    for (const chromeMode of GROUPED_TOOL_CALL_CHROME_MODES) {
        if (
            shouldRenderGroupedToolCallWithMessageView(message, chromeMode, true)
            !== shouldRenderGroupedToolCallWithMessageView(message, chromeMode, false)
        ) {
            return true;
        }
        if (resolveGroupedPreviewSidechainIds({ chromeMode, previewMessages: [message] }).length > 0) {
            return true;
        }
    }
    return false;
}
