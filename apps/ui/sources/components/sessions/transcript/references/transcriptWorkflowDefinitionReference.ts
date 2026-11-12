import type { Message, ToolCall } from '@happier-dev/session-core/messages';
import type { SessionMessageChange } from '@/sync/store/sessionMessageChanges';
import type { WorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionEditRequestV1Schema, WorkflowDefinitionEditResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createHappierActionToolNameIndex, isRecord, readHappierActionCallInput, readHappierActionExecuteActionId, readHappierActionId, readHappierActionToolResultCandidates } from './happierActionToolResult';

const WRITES = ['workflow.definition.create', 'workflow.definition.update', 'workflow.definition.edit'] as const;
type DefinitionWrite = typeof WRITES[number];
export type TranscriptWorkflowDefinitionReference = WorkflowAgentRevision & Readonly<{ actionId: DefinitionWrite }>;
const INDEX = createHappierActionToolNameIndex(WRITES);
const isDefinitionWrite = (id: string): id is DefinitionWrite => WRITES.some((write) => write === id);

function readDefinitionWriteActionId(tool: ToolCall): DefinitionWrite | null {
    return readHappierActionId(tool.name, INDEX)
        ?? readHappierActionExecuteActionId(tool.name, tool.input, isDefinitionWrite);
}

/** The same Action family can be identified before its result is available. */
export function isTranscriptWorkflowDefinitionWrite(tool: ToolCall): boolean {
    return readDefinitionWriteActionId(tool) !== null;
}

/** Admit changed receipts, including sidechains, without revisiting unchanged siblings. */
export function visitChangedTranscriptWorkflowDefinitionReferences(
    changes: readonly SessionMessageChange[],
    eligible: (message: Message) => boolean,
    accept: (reference: TranscriptWorkflowDefinitionReference) => void,
): void {
    const visit = (previous: Message | null, next: Message) => {
        if (previous === next || next.kind !== 'tool-call') return;
        const before = previous?.kind === 'tool-call' ? previous : null;
        const tool = next.tool;
        if (eligible(next) && (!before || !eligible(before)
            || before.tool.state !== tool.state || before.tool.name !== tool.name
            || before.tool.input !== tool.input || before.tool.result !== tool.result)) {
            const reference = resolveTranscriptWorkflowDefinitionReference(tool);
            if (reference) accept(reference);
        }
        if (before?.children === next.children) return;
        const previousChildren = new Map(before?.children.map(child => [child.id, child]));
        for (const child of next.children) visit(previousChildren.get(child.id) ?? null, child);
    };
    for (const change of changes) visit(change.previous, change.next);
}

/** Only terminal successful definition writes can acknowledge a saved revision. */
export function resolveTranscriptWorkflowDefinitionReference(tool: ToolCall): TranscriptWorkflowDefinitionReference | null {
    if (tool.state !== 'completed') return null;
    const actionId = readDefinitionWriteActionId(tool);
    if (!actionId) return null;
    const input = readHappierActionCallInput(tool.name, tool.input);
    for (const candidate of readHappierActionToolResultCandidates(tool.result)) {
        // Refusals/deferred approvals are ordinary transcript outcomes, never revisions.
        if (isRecord(candidate) && 'ok' in candidate && candidate.ok !== true) continue;
        const value = isRecord(candidate) && candidate.ok === true ? candidate.result : candidate;
        if (actionId === 'workflow.definition.edit') {
            const request = WorkflowDefinitionEditRequestV1Schema.safeParse(input);
            const result = WorkflowDefinitionEditResultV1Schema.safeParse(value);
            if (request.success && result.success) return { actionId, definitionId: request.data.definitionId, ...result.data };
        } else {
            const result = WorkflowDefinitionGetResultV1Schema.safeParse(value);
            if (result.success) return { actionId, ...result.data, changedBlockIds: [] };
        }
    }
    return null;
}
