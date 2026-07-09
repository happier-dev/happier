import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

/**
 * Props shared by every tool-calls-group unit row (header / expand / tool / footer).
 * The list wiring resolves these from the per-unit list items.
 */
export type ToolCallsGroupUnitRowCommonProps = Readonly<{
    sessionId: string;
    groupId: string;
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
}>;
