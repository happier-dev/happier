import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { normalizeToolCallForRendering } from '@happier-dev/session-core/tools';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { resolveToolInlineErrorDisplay } from '@/components/tools/shell/presentation/resolveToolInlineErrorDisplay';
import { getToolDisplayTextProjector } from './_registry';
import { toolTextBlock, type ToolDisplayTextBlock, type ToolDisplayTextContext } from './toolDisplayTextTypes';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import type { Settings } from '@/sync/domains/settings/settings';
import { deriveToolMessageDisplay } from '@/components/sessions/transcript/toolCalls/deriveToolMessageDisplay';
import { projectTurnChangesCardDisplayText } from '@/components/sessions/files/turnChanges/turnChangesCardDisplayText';

export type ToolFindTextContext = ToolDisplayTextContext & Readonly<{
    metadata?: Metadata | null;
    historicalAgentId?: string | null;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
    toolViewTimelineChromeMode?: Settings['toolViewTimelineChromeMode'];
    canOpenFiles?: boolean;
    canNavigate?: boolean;
}>;

/** Project the transcript display owner: a turn recap, or the normalized tool shell and body. */
export function projectToolFindText(tool: ToolCall, context: ToolFindTextContext = {}): readonly ToolDisplayTextBlock[] {
    const { turnChanges } = deriveToolMessageDisplay({
        tool,
        hasStructuredNode: false,
        toolViewTimelineChromeMode: context.toolViewTimelineChromeMode,
        permissionDisabledReason: context.permissionDisabledReason,
    });
    if (turnChanges) return projectTurnChangesCardDisplayText(turnChanges.files);
    const normalized = normalizeToolCallForRendering(tool);
    const header = resolveToolHeaderTextPresentation({ tool: normalized, metadata: context.metadata ?? null });
    const blocks: ToolDisplayTextBlock[] = [{ id: 'tool-title', text: header.title, format: 'plain', kind: 'toolTitle' }];
    if (header.subtitle) blocks.push({ id: 'tool-subtitle', text: header.subtitle, format: 'plain', kind: 'toolTitle' });
    if (header.statusText) blocks.push({ id: 'tool-status', text: header.statusText, format: 'plain', kind: 'toolTitle' });
    const errors = resolveToolInlineErrorDisplay({
        tool: normalized,
        normalizedToolName: header.normalizedToolName,
        metadata: context.metadata ?? null,
        historicalAgentId: context.historicalAgentId,
        permissionDisabledReason: context.permissionDisabledReason,
    });
    if (errors.override) return [...blocks, ...toolTextBlock('tool-error-override', errors.override)];
    return [
        ...blocks,
        ...getToolDisplayTextProjector(header.normalizedToolName)(normalized, context.metadata ?? null, context),
        ...toolTextBlock('tool-error-append', errors.append),
    ];
}
