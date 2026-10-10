import { maybeParseJson } from '../../activity/parseJson.js';
import { createHappierActionToolNameIndex, isRecord, readHappierActionExecuteActionId, readHappierActionId, readHappierActionToolName, readHappierActionToolPayload, readHappierActionToolResultCandidates } from '../../actions/happierActionToolResult.js';
import { SESSION_BOARD_ACTION_IDS_V1, SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from './actionIds.js';
import { parseSessionBoardActionExecuteOutcomeV1, parseSessionBoardActionPortResultV1 } from './actions.js';
import type { SessionBoardItemWidth } from './layout.js';
import type { SessionTranscriptSurfaceItemReferenceV1 } from '../messages/transcriptObservationV1.js';

export type TranscriptSessionBoardItemReferenceV1 = Readonly<{
    address: Readonly<{ serverId: string; sessionId: string }>;
    itemId: string;
    itemRevision: string | null;
    outcome: 'created' | 'updated' | 'unchanged';
    destination: Readonly<{ tabId: string; width: SessionBoardItemWidth }> | null;
    itemDestination: 'transcript' | 'board' | 'both';
}>;

/** One exact-source acknowledgement recognizer for authenticated, fork and public viewers. */
export function resolveTranscriptSessionBoardItemReferenceV1(input: Readonly<{
    toolName: string;
    state: string;
    input: unknown;
    result: unknown;
    address: TranscriptSessionBoardItemReferenceV1['address'] | null;
}>): TranscriptSessionBoardItemReferenceV1 | null {
    if (!input.address || input.state !== 'completed') return null;
    const directActionId = readHappierActionId(readHappierActionToolName(input.toolName, input.input), createHappierActionToolNameIndex(
        SESSION_BOARD_ACTION_IDS_V1.map(actionId => ({ actionId, name: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1[actionId] })),
    ));
    const executeActionId = directActionId ? null : readHappierActionExecuteActionId(input.toolName, input.input,
        (id): id is 'session.board.item.upsert' => id === 'session.board.item.upsert');
    const actionId = directActionId ?? executeActionId;
    if (actionId !== 'session.board.item.upsert') return null;
    const options = { expectedServerId: input.address.serverId, expectedSessionId: input.address.sessionId };
    const parsedInput = readHappierActionToolPayload(input.input);
    const toolInput = executeActionId && isRecord(parsedInput) ? maybeParseJson(parsedInput.input) : parsedInput;
    for (const candidate of readHappierActionToolResultCandidates(input.result, input.input)) {
        if (!isRecord(candidate)) continue;
        const parsed = Object.hasOwn(candidate, 'ok')
            ? parseSessionBoardActionExecuteOutcomeV1(actionId, toolInput,
                candidate as Parameters<typeof parseSessionBoardActionExecuteOutcomeV1>[2], options)
            : parseSessionBoardActionPortResultV1(actionId, toolInput, candidate, options);
        if (!parsed.success || (parsed.kind !== 'applied' && parsed.kind !== 'success')) continue;
        const data = parsed.data;
        if (!('result' in data) || data.result.operation !== 'upsert_item') continue;
        const intent = 'itemDestination' in data ? data.itemDestination : 'board';
        if (intent !== 'transcript' && intent !== 'board' && intent !== 'both') continue;
        return Object.freeze({
            address: input.address, itemId: data.result.itemId,
            itemRevision: data.result.itemRevision ?? null, outcome: data.result.outcome,
            destination: data.destination ? Object.freeze({ tabId: data.destination.tabId, width: data.destination.width }) : null,
            itemDestination: intent,
        });
    }
    return null;
}

/** The published association is authenticated by its current Session writer, never by origin metadata. */
export function isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1(input: Readonly<{
    acknowledgedReference: TranscriptSessionBoardItemReferenceV1;
    publishedReference: SessionTranscriptSurfaceItemReferenceV1;
    publishedSessionId: string;
}>): boolean {
    const acknowledged = input.acknowledgedReference;
    const published = input.publishedReference;
    if (!input.publishedSessionId || !acknowledged.itemRevision
        || acknowledged.address.serverId !== published.sourceAddress.serverId
        || acknowledged.address.sessionId !== published.sourceAddress.sessionId) return false;
    // A historical import stamps the independently owned child copy. Its original
    // immutable acknowledgement may still have Board intent and parent identity.
    if (published.sourceAddress.sessionId !== input.publishedSessionId) return true;
    return acknowledged.itemDestination !== 'board' && acknowledged.itemId === published.itemId
        && acknowledged.itemRevision === published.itemRevision;
}
