import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import {
    SESSION_BOARD_ACTION_IDS_V1,
    parseSessionBoardActionExecuteOutcomeV1,
    parseSessionBoardActionPortResultV1,
    type SessionBoardActionIdV1,
    type SessionBoardItemWidth,
    type SessionBoardMutationActionResultV1,
} from '@happier-dev/protocol/sessions/board';

import type { ToolCall } from "@happier-dev/session-core/messages";
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import {
    createHappierActionToolNameIndex,
    isRecord,
    readHappierActionId,
    readHappierActionToolResultCandidates,
} from './happierActionToolResult';

/**
 * The one projection from a transcript tool call to a Session Board item.
 *
 * The Agent visualization journey is Composer -> Agent Action -> item -> inline
 * result, and this module owns its only discriminating step: deciding whether a
 * row's recorded tool result *is* a truthful acknowledgement that one exact Board
 * item now exists on one exact Home's Session.
 *
 * It reads nothing heuristically. The tool name is matched against the canonical
 * `bindings.mcpToolName` the Action spec owner already declares, and the result is
 * validated by the canonical Board Action parsers, which cross-check the result
 * against the invoked input, the item id, the create/update operand and the exact
 * `{serverId, sessionId}` the row's own owner captured. Prose, partial JSON, a
 * lookalike payload from a foreign MCP server, a failure, a pending approval and
 * an ambiguous post-dispatch loss all produce no reference.
 */

export type TranscriptSessionBoardItemReference = Readonly<{
    /**
     * The exact Home and Session the transcript row carries. Two Homes may hold
     * the same local Session id, so this is captured, never inferred from the id
     * alone and never resolved against the ambient focused Home.
     */
    address: SessionAddress;
    itemId: string;
    outcome: 'created' | 'updated' | 'unchanged';
    /** Where the same Action placed it, when that call carried a placement. */
    destination: Readonly<{ tabId: string; width: SessionBoardItemWidth }> | null;
}>;

/** Canonical tool bindings for the four Board Actions. */
const BOARD_ACTION_ID_BY_TOOL_NAME = createHappierActionToolNameIndex<SessionBoardActionIdV1>(SESSION_BOARD_ACTION_IDS_V1);

function readAppliedMutationResult(input: Readonly<{
    actionId: SessionBoardActionIdV1;
    toolInput: unknown;
    candidate: unknown;
    address: SessionAddress;
}>): SessionBoardMutationActionResultV1 | null {
    const candidate = input.candidate;
    if (!isRecord(candidate)) return null;
    const options = {
        expectedServerId: input.address.serverId,
        expectedSessionId: input.address.sessionId,
    } as const;
    // `ok` is the executor envelope's own discriminator. Its arms — a failure, a
    // created approval request and an applied result — are all classified by the
    // canonical parser; only the applied arm survives.
    const parsed = Object.hasOwn(candidate, 'ok')
        ? parseSessionBoardActionExecuteOutcomeV1(
            input.actionId,
            input.toolInput,
            candidate as Parameters<typeof parseSessionBoardActionExecuteOutcomeV1>[2],
            options,
        )
        : parseSessionBoardActionPortResultV1(input.actionId, input.toolInput, candidate, options);
    if (!parsed.success) return null;
    if (parsed.kind !== 'applied' && parsed.kind !== 'success') return null;
    const data = parsed.data;
    return 'result' in data ? data : null;
}

export function resolveTranscriptSessionBoardItemReference(input: Readonly<{
    toolName: string;
    state: ToolCall['state'];
    input: unknown;
    result: unknown;
    /** `null` whenever the row cannot name its exact Home; there is no fallback. */
    address: SessionAddress | null;
}>): TranscriptSessionBoardItemReference | null {
    const address = input.address;
    if (!address) return null;
    // A running, errored or permission-blocked call has committed nothing. Only a
    // completed call can carry an acknowledgement worth mounting.
    if (input.state !== 'completed') return null;

    const actionId = readHappierActionId(input.toolName, BOARD_ACTION_ID_BY_TOOL_NAME);
    // Item upsert is the only Board intent whose result names an item: a layout
    // update commits an order, a removal deletes the record and a read returns an
    // inventory. Widening this needs a new arm in the result union first.
    if (actionId !== 'session.board.item.upsert') return null;

    const toolInput = maybeParseJson(input.input);
    for (const candidate of readHappierActionToolResultCandidates(input.result)) {
        const applied = readAppliedMutationResult({ actionId, toolInput, candidate, address });
        if (!applied || applied.result.operation !== 'upsert_item') continue;
        return Object.freeze({
            address,
            itemId: applied.result.itemId,
            outcome: applied.result.outcome,
            destination: applied.destination
                ? Object.freeze({ tabId: applied.destination.tabId, width: applied.destination.width })
                : null,
        });
    }
    return null;
}
