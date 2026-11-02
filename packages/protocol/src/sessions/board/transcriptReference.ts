import type { ParsedApprovalArtifactBodyV1 } from '../../approvals/approvalArtifactHeaderV1.js';
import type { ApprovalTranscriptVisualPublicationV1 } from '../messages/transcriptObservationV1.js';
import { maybeParseJson } from '../../activity/parseJson.js';
import { createHappierActionToolNameIndex, isRecord, readHappierActionExecuteActionId, readHappierActionId, readHappierActionToolName, readHappierActionToolPayload, readHappierActionToolResultCandidates } from '../../actions/happierActionToolResult.js';
import { SESSION_BOARD_ACTION_IDS_V1, SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from './actionIds.js';
import { parseSessionBoardActionExecuteOutcomeV1, parseSessionBoardActionPortResultV1 } from './actions.js';
import type { SessionBoardItemWidth } from './layout.js';
import type { SessionTranscriptSurfaceItemReferenceReadV1 } from '../messages/transcriptObservationV1.js';
import type { ServerProfileScopeResolver } from '../../features/payload/capabilities/serverIdentityCapabilities.js';

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
    resolveServerScopeId?: ServerProfileScopeResolver;
}>): TranscriptSessionBoardItemReferenceV1 | null {
    if (!input.address || input.state !== 'completed') return null;
    const directActionId = readHappierActionId(readHappierActionToolName(input.toolName, input.input), createHappierActionToolNameIndex(
        SESSION_BOARD_ACTION_IDS_V1.map(actionId => ({ actionId, name: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1[actionId] })),
    ));
    const executeActionId = directActionId ? null : readHappierActionExecuteActionId(input.toolName, input.input,
        (id): id is 'session.board.item.upsert' => id === 'session.board.item.upsert');
    const actionId = directActionId ?? executeActionId;
    if (actionId !== 'session.board.item.upsert') return null;
    const options = { expectedServerId: input.address.serverId, expectedSessionId: input.address.sessionId,
        resolveServerScopeId: input.resolveServerScopeId };
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

/**
 * Layout only: whether a completed call acknowledged an item shown in the transcript, so its visual stands
 * as the reply rather than inside a tool group. It reads the acknowledgement's own address and is never an
 * authority to show content; the exact-address recognizer above decides that for the viewer's Home.
 */
export function isTranscriptSessionBoardItemReplyCallV1(input: Readonly<{
    toolName: string;
    state: string;
    input: unknown;
    result: unknown;
}>): boolean {
    if (input.state !== 'completed') return false;
    for (const candidate of readHappierActionToolResultCandidates(input.result, input.input)) {
        if (!isRecord(candidate)) continue;
        const acknowledgement = Object.hasOwn(candidate, 'ok') ? candidate.result : candidate;
        if (!isRecord(acknowledgement)) continue;
        const { serverId, sessionId } = acknowledgement;
        if (typeof serverId !== 'string' || typeof sessionId !== 'string') continue;
        const reference = resolveTranscriptSessionBoardItemReferenceV1({ ...input, address: { serverId, sessionId } });
        if (reference) return reference.itemDestination !== 'board';
    }
    return false;
}

/** The published association is authenticated by its current Session writer, never by origin metadata. */
export function isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1(input: Readonly<{
    acknowledgedReference: TranscriptSessionBoardItemReferenceV1;
    publishedReference: SessionTranscriptSurfaceItemReferenceReadV1;
    publishedSessionId: string;
}>): boolean {
    const acknowledged = input.acknowledgedReference;
    const published = input.publishedReference;
    if (!input.publishedSessionId
        || acknowledged.address.serverId !== published.sourceAddress.serverId
        || acknowledged.address.sessionId !== published.sourceAddress.sessionId) return false;
    if ('sourceItemId' in published) {
        if (published.sourceItemId !== acknowledged.itemId
            || published.sourceItemRevision !== acknowledged.itemRevision) return false;
        // The exact original identity selects a member, not a grant. Only the
        // published Session's admitted child Item/revision can supply content.
        // A copied Board-origin acknowledgement can therefore remain inline.
        if (published.itemId !== published.sourceItemId
            || published.sourceAddress.sessionId !== input.publishedSessionId) return true;
    }
    // Direct singleton reads remain exact. An old child association
    // without original identity cannot identify a sibling by source address alone.
    return published.sourceAddress.sessionId === input.publishedSessionId
        && acknowledged.itemRevision !== null && acknowledged.itemDestination !== 'board'
        && acknowledged.itemId === published.itemId && acknowledged.itemRevision === published.itemRevision;
}

export function readApprovalTranscriptVisualPublicationV1(input: Readonly<{
    artifactId: string; approval: ParsedApprovalArtifactBodyV1 | null;
}>): ApprovalTranscriptVisualPublicationV1 | null {
    if (input.approval?.family !== 'built_in') return null;
    const { request } = input.approval;
    if (request.actionId !== 'session.board.item.upsert' || request.origin?.kind !== 'transcript_tool_call'
        || request.status !== 'executed' || request.execution?.ok === false) return null;
    const result = request.execution?.result;
    if (!isRecord(result) || typeof result.serverId !== 'string') return null;
    const reference = resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert',
        state: 'completed', input: request.actionArgs, result,
        address: { serverId: result.serverId, sessionId: request.origin.sessionId } });
    if (!reference?.itemRevision || reference.itemDestination === 'board') return null;
    return { v: 1, sessionId: reference.address.sessionId, surfaceItemReference: { v: 1, references: [{
        v: 1, itemId: reference.itemId, itemRevision: reference.itemRevision,
        sourceAddress: reference.address, sourceItemId: reference.itemId, sourceItemRevision: reference.itemRevision,
    }] } };
}
