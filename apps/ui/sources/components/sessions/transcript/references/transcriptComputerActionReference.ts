import { ComputerActionResultV1Schema, ComputerApprovalDisplayV1Schema, ComputerCaptureResponseV1Schema, ComputerInputRequestV1Schema, ComputerQueryResponseV1Schema, type ComputerCaptureResponseV1 } from '@happier-dev/protocol/computer/v1';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { z } from 'zod';
import type { ToolCall } from '@happier-dev/session-core/messages';

import {
    createHappierActionToolNameIndex,
    isRecord,
    readHappierActionExecuteActionId,
    readHappierActionId,
    readHappierActionToolResultCandidates,
} from './happierActionToolResult';

/** The agent's computer Actions a transcript row can carry (the person's own Actions never appear here). */
const COMPUTER_AGENT_ACTION_IDS = ['computer.capture', 'computer.query', 'computer.input'] as const;
type ComputerAgentActionId = (typeof COMPUTER_AGENT_ACTION_IDS)[number];
const COMPUTER_ACTION_ID_BY_TOOL_NAME = createHappierActionToolNameIndex(COMPUTER_AGENT_ACTION_IDS);
const isComputerAgentActionId = (actionId: string): actionId is ComputerAgentActionId =>
    (COMPUTER_AGENT_ACTION_IDS as readonly string[]).includes(actionId);

const SelectionRequiredSchema = z.object({ status: z.literal('target_selection_required'), approvalDisplay: ComputerApprovalDisplayV1Schema });

export type TranscriptComputerVerb = 'capture' | 'query' | 'click' | 'type' | 'press';
type CapturedMedia = Extract<ComputerCaptureResponseV1, { status: 'captured' }>['media'];

/**
 * What a transcript row says for an agent's computer Action (lab `computer` transcript and TP):
 * - `choose`: the agent needs a window and none is shared (W7 `target_selection_required`); the row is
 *   where the person chooses one (never an automatic pick);
 * - `action`: what it did on the shared window, in words — took a screenshot (with it), read the window,
 *   clicked, typed, pressed a named key — in progress or settled, and whether the result is known.
 *   Typed text is never carried here; clicked or focused names come only from the native owner's result.
 */
export type TranscriptComputerActionReference =
    | Readonly<{
        actionId: ComputerAgentActionId;
        machineId: string;
        kind: 'choose';
        /** The computer owner's name for the machine. */
        machineName: string;
    }>
    | Readonly<{
        actionId: ComputerAgentActionId;
        machineId: string;
        kind: 'action';
        verb: TranscriptComputerVerb;
        running: boolean;
        outcome: 'done' | 'mayHaveLanded' | 'failed' | null;
        /** A named key only (Return, Tab, Escape); a single character is never shown. */
        key: string | null;
        targetLabel: string | null;
        /** The screenshot the agent took, as the Session image the owner stored. */
        media: CapturedMedia | null;
        /** The action ran on the shared window: the row can open the viewer. */
        watch: boolean;
    }>;

function readVerb(actionId: ComputerAgentActionId, actionInput: unknown): Readonly<{ verb: TranscriptComputerVerb; key: string | null }> | null {
    if (actionId === 'computer.capture') return { verb: 'capture', key: null };
    if (actionId === 'computer.query') return { verb: 'query', key: null };
    const parsed = ComputerInputRequestV1Schema.safeParse(actionInput);
    if (!parsed.success) return null;
    const operation = parsed.data.operation;
    if (operation.kind !== 'press') return { verb: operation.kind, key: null };
    const key = operation.key.trim();
    return { verb: 'press', key: key.length > 1 ? key : null };
}

export function resolveTranscriptComputerActionReference(input: Readonly<{
    toolName: string;
    state: ToolCall['state'] | string;
    input: unknown;
    result: unknown;
}>): TranscriptComputerActionReference | null {
    const directActionId = readHappierActionId(input.toolName, COMPUTER_ACTION_ID_BY_TOOL_NAME);
    const executeActionId = directActionId
        ? null
        : readHappierActionExecuteActionId(input.toolName, input.input, isComputerAgentActionId);
    const actionId = directActionId ?? executeActionId;
    if (!actionId) return null;
    const toolInput = maybeParseJson(input.input);
    const actionInput = executeActionId && isRecord(toolInput) ? maybeParseJson(toolInput.input) : toolInput;
    const machineId = isRecord(actionInput) && typeof actionInput.machineId === 'string' ? actionInput.machineId.trim() : '';
    const verb = readVerb(actionId, actionInput);
    if (!machineId || !verb) return null;
    const action = { actionId, machineId, kind: 'action' as const, verb: verb.verb, key: verb.key };
    if (input.state === 'running' || input.state === 'pending') {
        return Object.freeze({ ...action, running: true, targetLabel: null, outcome: null, media: null, watch: true });
    }
    if (input.state !== 'completed') return null;
    for (const candidate of readHappierActionToolResultCandidates(input.result)) {
        const selection = SelectionRequiredSchema.safeParse(candidate);
        if (selection.success) {
            return Object.freeze({ actionId, machineId, kind: 'choose', machineName: selection.data.approvalDisplay.machineDisplayName });
        }
        const schema = actionId === 'computer.capture' ? ComputerCaptureResponseV1Schema
            : actionId === 'computer.query' ? ComputerQueryResponseV1Schema
            : ComputerActionResultV1Schema;
        const parsed = schema.safeParse(candidate);
        if (!parsed.success || parsed.data.status === 'target_selection_required') continue;
        const result = parsed.data;
        const outcome = result.status === 'failed'
            ? 'failed'
            : result.status === 'interrupted' && result.completion === 'unknown' ? 'mayHaveLanded' : 'done';
        return Object.freeze({
            ...action,
            running: false,
            outcome,
            targetLabel: 'targetLabel' in result ? result.targetLabel ?? null : null,
            media: result.status === 'captured' ? result.media : null,
            watch: true,
        });
    }
    return null;
}
