import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Text rendered by a tool's display owner, including text revealed by Find. */
export type ToolDisplayTextBlock = Readonly<{
    id: string;
    text: string;
    format: 'plain' | 'markdown';
    kind: 'toolTitle' | 'toolBody';
}>;
export type ToolDisplayTextContext = Readonly<{
    messages?: readonly Message[];
    workflowRun?: SessionWorkflowRunSnapshotV1 | null;
    accountScope?: ServerAccountScope | null;
}>;
export type ToolDisplayTextProjector = (tool: ToolCall, metadata?: Metadata | null, context?: ToolDisplayTextContext) => readonly ToolDisplayTextBlock[];

export function toolTextBlock(id: string, text: string | null | undefined, format: 'plain' | 'markdown' = 'plain'): ToolDisplayTextBlock[] {
    return text ? [{ id, text, format, kind: 'toolBody' }] : [];
}
