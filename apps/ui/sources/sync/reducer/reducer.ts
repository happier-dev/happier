/**
 * Message Reducer for Real-time Sync System
 * 
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 * 
 * ## Core Responsibilities:
 * 
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 * 
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled)
 *    - Matches incoming tool calls to approved permissions
 *    - Prioritizes tool calls over permissions when both exist
 * 
 * 3. **Tool Call Lifecycle**: Manages the complete lifecycle of tool calls:
 *    - Creation from permission requests or direct tool calls
 *    - Matching tool calls to existing permission messages
 *    - Processing tool results and updating states
 *    - Handling errors and completion states
 * 
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Identifies sidechain messages using the tracer
 *    - Stores sidechain messages separately
 *    - Links sidechains to their parent tool calls
 * 
 * ## Processing Phases:
 * 
 * The reducer processes messages in a specific order to ensure correct behavior:
 * 
 * **Phase 0: AgentState Permissions**
 *   - Processes pending and completed permission requests
 *   - Creates tool messages for permissions
 *   - Skips completed permissions if matching tool call (same name AND arguments) exists in incoming messages
 *   - Phase 2 will handle matching tool calls to existing permission messages
 * 
 * **Phase 0.5: Message-to-Event Conversion**
 *   - Parses messages to check if they should be converted to events
 *   - Converts matching messages to events immediately
 *   - Converted messages skip all subsequent processing phases
 *   - Supports user commands, tool results, and metadata-driven conversions
 * 
 * **Phase 1: User and Text Messages**
 *   - Processes user messages with deduplication
 *   - Processes agent text messages
 *   - Skips tool calls for later phases
 * 
 * **Phase 2: Tool Calls**
 *   - Processes incoming tool calls from agents
 *   - Matches to existing permission messages when possible
 *   - Creates new tool messages when no match exists
 *   - Prioritizes newest permission when multiple matches
 * 
 * **Phase 3: Tool Results**
 *   - Updates tool messages with results
 *   - Sets completion or error states
 *   - Updates completion timestamps
 * 
 * **Phase 4: Sidechains**
 *   - Processes sidechain messages separately
 *   - Stores in sidechain map linked to parent tool
 *   - Handles nested tool calls within sidechains
 * 
 * **Phase 5: Mode Switch Events**
 *   - Processes agent event messages
 *   - Handles mode changes and other events
 * 
 * ## Key Behaviors:
 * 
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Argument Matching**: Tool calls match to permissions based on both name AND arguments
 * - **Timestamp Preservation**: Original timestamps are preserved when matching tools to permissions
 * - **State Persistence**: The ReducerState maintains all mappings across calls
 * - **Message Immutability**: NEVER modify message timestamps or core properties after creation
 *   Messages can only have their tool state/result updated, never their creation metadata
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp. The timestamp
 *   represents when the message was originally created and must be preserved throughout all
 *   processing phases. This is critical for maintaining correct message ordering.
 * - **Transcript Ordering Reconciliation**: AgentState permission placeholders are created before
 *   their transcript row exists. When the matching tool-call row arrives, missing transcript
 *   ordering coordinates (`seq`, `transcriptBlockIndex`) may be filled in without changing the
 *   placeholder's original `createdAt`.
 * 
 * ## Permission Matching Algorithm:
 * 
 * When a tool call arrives, the matching algorithm:
 * 1. Checks if the tool has already been processed (via toolIdToMessageId)
 * 2. Searches for approved permission messages with:
 *    - Same tool name
 *    - Matching arguments (deep equality)
 *    - Not already linked to another tool
 * 3. Prioritizes the newest matching permission
 * 4. Updates the permission message with tool execution details
 * 5. Falls back to creating a new tool message if no match
 * 
 * ## Data Flow:
 * 
 * Raw Messages → Normalizer → Reducer → Structured Messages
 *                              ↑
 *                         AgentState
 * 
 * The reducer receives:
 * - Normalized messages from the sync system
 * - Current AgentState with permission information
 * 
 * And produces:
 * - Structured Message objects for UI rendering
 * - Updated internal state for future processing
 */

import { Message, ToolCall } from "../domains/messages/messageTypes";
import { AgentEvent, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState } from "../domains/state/storageTypes";
import { MessageMeta } from "../domains/messages/messageMetaTypes";
import { compareToolCalls } from "../../utils/tools/toolComparison";
import { runMessageToEventConversion } from "./phases/messageToEventConversion";
import { runAgentStatePermissionsPhase } from "./phases/agentStatePermissions";
import { runUserAndTextPhase } from "./phases/userAndText";
import { runToolCallsPhase } from "./phases/toolCalls";
import { runToolResultsPhase } from "./phases/toolResults";
import { runSidechainsPhase } from "./phases/sidechains";
import { runModeSwitchEventsPhase } from "./phases/modeSwitchEvents";
import { equalOptionalStringArrays } from "./helpers/arrays";
import { coerceStreamingToolResultChunk, mergeExistingStdStreamsIntoFinalResultIfMissing, mergeStreamingChunkIntoResult } from "./helpers/streamingToolResult";
import type { OrphanToolResultBucket } from "./helpers/orphanToolResults";
import type { ReducerStoredPermission } from "./helpers/toolCallProjection";
import { isDebugFlagEnabled } from "./helpers/debugFlags";
import { readStreamSegmentMetaV1 } from './helpers/streamSegmentMeta';
import { compareIncomingTranscriptRowsOldestFirst, normalizeTranscriptSeq } from "../domains/messages/transcriptOrdering";
import {
    SessionContextUsageSnapshotV1Schema,
    type MessageStructuredPresentationV1,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol';
import {
    applyTranscriptObservationMetadata,
    isRecoveredHistoryTranscriptObservation,
    type TranscriptObservationMetadata,
} from '../domains/messages/transcriptObservationProvenance';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function areMessageActionReferencesEqual(
    left: TranscriptObservationMetadata['messageActionReference'],
    right: TranscriptObservationMetadata['messageActionReference'],
): boolean {
    return left === right || (
        left !== undefined
        && right !== undefined
        && left.v === right.v
        && left.sessionId === right.sessionId
        && left.messageId === right.messageId
        && left.observedRevision === right.observedRevision
    );
}

function areTranscriptSemanticValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || left === undefined || right === undefined) return false;
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => areTranscriptSemanticValuesEqual(value, right[index]));
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
            && areTranscriptSemanticValuesEqual(leftRecord[key], rightRecord[key]),
    );
}

function readTranscriptObservationMetadata(message: TranscriptObservationMetadata): TranscriptObservationMetadata {
    return {
        ...(message.sourceCreatedAt !== undefined ? { sourceCreatedAt: message.sourceCreatedAt } : {}),
        ...(message.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: message.sourceUpdatedAt } : {}),
        ...(message.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: message.transcriptObservationProvenance }
            : {}),
        ...(message.deliveryResolution !== undefined ? { deliveryResolution: message.deliveryResolution } : {}),
        ...(message.messageActionReference !== undefined ? { messageActionReference: message.messageActionReference } : {}),
    };
}

function areTranscriptObservationMetadataEqual(
    left: TranscriptObservationMetadata,
    right: TranscriptObservationMetadata,
): boolean {
    return left.sourceCreatedAt === right.sourceCreatedAt
        && left.sourceUpdatedAt === right.sourceUpdatedAt
        && areTranscriptSemanticValuesEqual(
            left.transcriptObservationProvenance,
            right.transcriptObservationProvenance,
        )
        && areTranscriptSemanticValuesEqual(left.deliveryResolution, right.deliveryResolution)
        && areMessageActionReferencesEqual(left.messageActionReference, right.messageActionReference);
}

function extractPermissionRequestId(input: unknown): string | null {
    const obj = asRecord(input);
    if (!obj) return null;

    const direct =
        firstString(obj.permissionId) ??
        firstString(obj.toolCallId) ??
        null;
    if (direct) return direct;

    const toolCall = asRecord(obj.toolCall);
    if (!toolCall) return null;

    return (
        firstString(toolCall.permissionId) ??
        firstString(toolCall.toolCallId) ??
        null
    );
}

function isPermissionRequestToolCall(toolId: string, input: unknown): boolean {
    const extracted = extractPermissionRequestId(input);
    if (!extracted || extracted !== toolId) return false;

    const obj = asRecord(input);
    const toolCall = obj ? asRecord(obj.toolCall) : null;
    const status = firstString(toolCall?.status) ?? firstString(obj?.status) ?? null;

    // Only treat as a permission request when it looks pending.
    return status === 'pending' || toolCall !== null;
}

export type ReducerMessage = {
    id: string;
    realID: string | null;
    seq: number | null;
    transcriptBlockIndex?: number | null;
    localId: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
    structuredPresentation?: MessageStructuredPresentationV1;
} & TranscriptObservationMetadata;

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId/permissionId -> messageId (since they're the same now)
    sidechainToolIdToMessageId: Map<string, string>; // toolId -> sidechain messageId (for dual tracking)
    permissions: Map<string, ReducerStoredPermission>; // Store permission details by ID for quick lookup
    orphanToolResults: Map<string, OrphanToolResultBucket>; // Buffer tool results that arrive before their tool call
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    tracerState: TracerState; // Tracer state for sidechain processing
    streamMergeCursor: { messageId: string; streamKey: string } | null;
    /**
     * Tracks the most recent main-timeline thinking message so streamed thinking deltas can append
     * even when server sequence metadata is missing or arrives later than the deltas.
     */
    thinkingMergeCursor: string | null;
    /**
     * Tracks main-timeline thinking messages by a stable segment key derived from provider UUID
     * plus a per-message thinking run index. This lets late-arriving or out-of-order thinking
     * updates merge into the existing rendered block even if merge cursors were cleared by
     * interleaved tool calls or text blocks.
     */
    thinkingSegmentKeyToMessageId: Map<string, string>;
    /**
     * Tracks the most recent thinking message for each sidechain. This allows streamed deltas to append
     * even when providers emit interleaved keepalive chunks or the reducer processes messages in separate invocations.
     */
    sidechainThinkingMergeCursors: Map<string, string>;
    latestTodos?: {
        todos: Array<{
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
            priority: 'high' | 'medium' | 'low';
            id: string;
        }>;
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
        contextSnapshot: SessionContextUsageSnapshotV1;
        contextSnapshotStale: boolean;
        timestamp: number;
    };
};

type AuthoritativeTranscriptTextTarget = Readonly<{
    messageId: string;
    message: ReducerMessage;
    text: string;
}>;

function readAuthoritativeTranscriptTextTarget(
    state: ReducerState,
    source: NormalizedMessage,
): AuthoritativeTranscriptTextTarget | null {
    if (source.isAuthoritativeUpdate !== true || isRecoveredHistoryTranscriptObservation(source)) {
        return null;
    }

    if (source.role === 'user') {
        const messageId = state.messageIds.get(source.id);
        if (!messageId) return null;
        const message = state.messages.get(messageId);
        if (!message || message.role !== 'user' || message.realID !== source.id) return null;
        return { messageId, message, text: source.content.text };
    }

    if (source.role !== 'agent' || source.content.length !== 1 || source.content[0]?.type !== 'text') {
        return null;
    }

    const isExactAgentTextTarget = (message: ReducerMessage | undefined): message is ReducerMessage => (
        message?.role === 'agent'
        && message.realID === source.id
        && message.text !== null
        && message.isThinking !== true
        && message.tool === null
        && message.event === null
        && message.transcriptBlockIndex === 0
    );
    const directMessageId = state.messageIds.get(source.id);
    const directMessage = directMessageId ? state.messages.get(directMessageId) : undefined;
    if (directMessageId && isExactAgentTextTarget(directMessage)) {
        return { messageId: directMessageId, message: directMessage, text: source.content[0].text };
    }
    for (const [messageId, message] of state.messages) {
        if (isExactAgentTextTarget(message)) {
            return { messageId, message, text: source.content[0].text };
        }
    }
    return null;
}

function hasExplicitAgentStreamIdentity(source: Extract<NormalizedMessage, { role: 'agent' }>): boolean {
    const meta = source.meta as Record<string, unknown> | undefined;
    return typeof meta?.happierStreamKey === 'string' || readStreamSegmentMetaV1(source.meta) !== null;
}

function isUnmarkedDurableAgentTextDuplicate(
    state: ReducerState,
    source: NormalizedMessage,
): boolean {
    if (
        source.role !== 'agent'
        || source.isAuthoritativeUpdate === true
        || isRecoveredHistoryTranscriptObservation(source)
        || source.content.length !== 1
        || source.content[0]?.type !== 'text'
        || hasExplicitAgentStreamIdentity(source)
    ) {
        return false;
    }
    const sourceSeq = normalizeTranscriptSeq(source.seq);
    if (sourceSeq === null) return false;

    for (const message of state.messages.values()) {
        if (
            message.role === 'agent'
            && message.realID === source.id
            && message.text !== null
            && message.isThinking !== true
            && message.tool === null
            && message.event === null
            && message.transcriptBlockIndex === 0
            && message.seq === sourceSeq
        ) {
            return true;
        }
    }
    return false;
}

function applyAuthoritativeTranscriptTextUpdate(
    target: AuthoritativeTranscriptTextTarget,
    source: NormalizedMessage,
): boolean {
    const { message } = target;
    const didTextChange = message.text !== target.text;
    const didMetaChange = !areTranscriptSemanticValuesEqual(message.meta, source.meta);
    const didStructuredPresentationChange = !areTranscriptSemanticValuesEqual(
        message.structuredPresentation,
        source.structuredPresentation,
    );
    const observationBefore = readTranscriptObservationMetadata(message);
    applyTranscriptObservationMetadata(message, source);
    const didObservationChange = !areTranscriptObservationMetadataEqual(
        observationBefore,
        readTranscriptObservationMetadata(message),
    );
    if (!didTextChange && !didMetaChange && !didStructuredPresentationChange && !didObservationChange) {
        return false;
    }

    // A server-declared update retains the durable row's id, local id, sequence,
    // and creation time; only its renderable semantic fields can be replaced.
    message.text = target.text;
    message.meta = source.meta;
    if (source.structuredPresentation !== undefined) {
        message.structuredPresentation = source.structuredPresentation;
    } else {
        delete message.structuredPresentation;
    }
    return true;
}

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        permissions: new Map(),
        orphanToolResults: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer(),
        streamMergeCursor: null,
        thinkingMergeCursor: null,
        thinkingSegmentKeyToMessageId: new Map(),
        sidechainThinkingMergeCursors: new Map(),
    };
}

export function reconcileLatestUsageContextSnapshotModel(
    state: ReducerState,
    activeModelId: string | null | undefined,
): void {
    const latestUsage = state.latestUsage;
    const normalizedActiveModelId = typeof activeModelId === 'string' ? activeModelId.trim() : '';
    const snapshotModelId = latestUsage?.contextSnapshot.modelId?.trim() ?? '';
    if (!latestUsage || !normalizedActiveModelId || !snapshotModelId) return;

    const contextSnapshotStale = snapshotModelId !== normalizedActiveModelId;
    if (latestUsage.contextSnapshotStale === contextSnapshotStale) return;
    state.latestUsage = {
        ...latestUsage,
        contextSnapshotStale,
    };
}

const ENABLE_LOGGING = false;

export type ReducerResult = {
    messages: Message[];
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    hasReadyEvent?: boolean;
    latestReadyEventSeq?: number;
    latestReadyEventAt?: number;
    reducerStateChanged?: boolean;
};

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
	    const DEBUG_SIDECHAINS = isDebugFlagEnabled({
	        // Enable in browser devtools via: `window.__HAPPIER_DEBUG_SIDECHAINS__ = true`
	        // (kept off by default to avoid noisy logs for users).
	        globalKey: '__HAPPIER_DEBUG_SIDECHAINS__',
	        localStorageKey: 'happier.debug.sidechains',
	    });

	    const DEBUG_MESSAGE_DECRYPT = isDebugFlagEnabled({
	        globalKey: '__HAPPIER_DEBUG_MESSAGE_DECRYPT__',
	        localStorageKey: 'happier.debug.messageDecrypt',
	    });

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
        if (agentState?.requests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.requests).length} pending requests`);
        }
        if (agentState?.completedRequests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.completedRequests).length} completed requests`);
        }
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;
    let latestReadyEventSeq: number | null = null;
    let latestReadyEventAt: number | null = null;

    const sidechainMessageIds = new Set<string>();
    for (const chain of state.sidechains.values()) {
        for (const m of chain) sidechainMessageIds.add(m.id);
    }

    // Only allow streaming chunks to append when the *latest* main-timeline message
    // is itself appendable. Use transcript ordering (`seq`) when available to avoid
    // relying on non-monotonic timestamps (e.g. mixed clock sources during streaming).
    let lastMainMessageId: string | null = null;
    let lastMainMessageSeq: number | null = null;
    let lastMainMessageCreatedAt: number | null = null;
    for (const [mid, m] of state.messages) {
        if (sidechainMessageIds.has(mid)) continue;

        const nextSeq = normalizeTranscriptSeq(m.seq);

        if (lastMainMessageId === null) {
            lastMainMessageId = mid;
            lastMainMessageSeq = nextSeq;
            lastMainMessageCreatedAt = m.createdAt;
            continue;
        }

        const prevSeq = lastMainMessageSeq;
        const prevCreatedAt = lastMainMessageCreatedAt;

        const shouldReplace = (() => {
            if (prevSeq !== null && nextSeq !== null) {
                if (nextSeq > prevSeq) return true;
                if (nextSeq < prevSeq) return false;
                // Tie-break: prefer later timestamps / later inserts.
                if (prevCreatedAt === null) return true;
                return m.createdAt >= prevCreatedAt;
            }
            if (prevSeq === null && nextSeq !== null) {
                return true;
            }
            if (prevSeq !== null && nextSeq === null) {
                return false;
            }
            if (prevCreatedAt === null) return true;
            return m.createdAt > prevCreatedAt || m.createdAt === prevCreatedAt;
        })();

        if (shouldReplace) {
            lastMainMessageId = mid;
            lastMainMessageSeq = nextSeq;
            lastMainMessageCreatedAt = m.createdAt;
        }
    }

    const lastMain = lastMainMessageId != null ? state.messages.get(lastMainMessageId) : null;
    const cursorThinking = state.thinkingMergeCursor != null ? state.messages.get(state.thinkingMergeCursor) : null;
    const lastMainThinkingMessageId =
        cursorThinking && cursorThinking.role === 'agent' && cursorThinking.isThinking && typeof cursorThinking.text === 'string'
            ? state.thinkingMergeCursor
            : (
                lastMain && lastMain.role === 'agent' && lastMain.isThinking && typeof lastMain.text === 'string'
                    ? lastMainMessageId
                    : null
            );

    // Seed streaming merge from a cursor that persists across reducer invocations.
    // This avoids losing the merge position when thinking deltas arrive between text chunks.
    const lastMainStreamKey =
        state.streamMergeCursor && typeof state.streamMergeCursor.streamKey === 'string'
            ? state.streamMergeCursor.streamKey
            : null;
    const lastMainStreamMessageId =
        state.streamMergeCursor && typeof state.streamMergeCursor.messageId === 'string'
            ? state.streamMergeCursor.messageId
            : null;


    // Socket batches are not guaranteed to arrive in chronological order. If we apply streamed
    // chunks out-of-order, streaming merge can produce fragmented blocks (or reversed text) and
    // the transcript ordering can temporarily look wrong until a full reload.
    //
    // Normalize ordering upfront so all phases (sidechain tracing, streaming merge, tool updates)
    // see a coherent timeline.
    const orderedIncomingMessages = (() => {
        if (messages.length <= 1) return messages;

        const indexed = messages.map((msg, index) => ({
            msg,
            id: msg.id,
            seq: normalizeTranscriptSeq(msg.seq),
            createdAt: msg.createdAt,
            inputIndex: index,
        }));

        indexed.sort(compareIncomingTranscriptRowsOldestFirst);

        return indexed.map((e) => e.msg);
    })();

    // A server-declared correction for an existing durable transcript row is
    // owned by that row, not by the live stream/event parser. Claim it before
    // tracing or conversion: replacement text can legitimately look like an
    // event payload, but it must never create a second rendered/event row.
    const authoritativeTranscriptTargetsBySource = new Map<
        NormalizedMessage,
        AuthoritativeTranscriptTextTarget
    >();
    const durableAgentDuplicates = new Set<NormalizedMessage>();
    for (const source of orderedIncomingMessages) {
        const target = readAuthoritativeTranscriptTextTarget(state, source);
        if (target) {
            authoritativeTranscriptTargetsBySource.set(source, target);
        } else if (isUnmarkedDurableAgentTextDuplicate(state, source)) {
            // The same one-block durable row can be delivered by an ordinary
            // page more than once. It is inert, including when its text happens
            // to match an event parser pattern; genuine streamed rows carry an
            // explicit stream identity and are intentionally excluded here.
            durableAgentDuplicates.add(source);
        }
    }
    const messagesForLivePhases = authoritativeTranscriptTargetsBySource.size === 0 && durableAgentDuplicates.size === 0
        ? orderedIncomingMessages
        : orderedIncomingMessages.filter((message) => (
            !authoritativeTranscriptTargetsBySource.has(message)
            && !durableAgentDuplicates.has(message)
        ));

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messagesForLivePhases);

    // Separate sidechain and non-sidechain messages.
    // Important: sidechain messages must never appear in the main transcript, even if sidechainId
    // isn't resolved yet (otherwise subagent tool execution leaks into the main timeline).
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId && !msg.isSidechain);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    if (DEBUG_MESSAGE_DECRYPT) {
        const isSidechainCount = tracedMessages.filter((m) => m.isSidechain).length;
        const hasSidechainIdCount = tracedMessages.filter((m) => Boolean(m.sidechainId)).length;
        // eslint-disable-next-line no-console
        console.log(
            `[debug][reducer] traced=${tracedMessages.length} `
                + `incoming=${messages.length} `
                + `nonSidechain=${nonSidechainMessages.length} `
                + `sidechain=${sidechainMessages.length} `
                + `flags={isSidechain:${isSidechainCount},sidechainId:${hasSidechainIdCount}}`
        );
    }

    //
    const conversion = runMessageToEventConversion({
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        enableLogging: ENABLE_LOGGING,
    });
    nonSidechainMessages = conversion.nonSidechainMessages.filter((message) => (
        !isUnmarkedDurableAgentTextDuplicate(state, message)
    ));
	    const incomingToolIds = conversion.incomingToolIds;
	    hasReadyEvent = hasReadyEvent || conversion.hasReadyEvent;
	    const readyAt = conversion.readyAt;
        if (conversion.latestReadyEventSeq !== null) {
            latestReadyEventSeq = latestReadyEventSeq === null
                ? conversion.latestReadyEventSeq
                : Math.max(latestReadyEventSeq, conversion.latestReadyEventSeq);
        }
        if (conversion.latestReadyEventAt !== null) {
            latestReadyEventAt = latestReadyEventAt === null
                ? conversion.latestReadyEventAt
                : Math.max(latestReadyEventAt, conversion.latestReadyEventAt);
        }

	    runAgentStatePermissionsPhase({
	        state,
	        agentState,
	        incomingToolIds,
	        changed,
	        allocateId,
	        enableLogging: ENABLE_LOGGING,
	    });

	    runUserAndTextPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	        allocateId,
	        processUsageData,
	        lastMainThinkingMessageId,
            lastMainStreamMessageId,
            lastMainStreamKey,
	        isPermissionRequestToolCall,
	    });
	    // Phase 1 controls the only thinking merge state within this reducer call; no other phase should append.
	    // We intentionally do not carry this across phases, because tool calls/results can interleave.

	    runToolCallsPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	        allocateId,
	        enableLogging: ENABLE_LOGGING,
	        isPermissionRequestToolCall,
	    });

	    runToolResultsPhase({
	        state,
	        nonSidechainMessages,
	        changed,
	    });

    //
    // Phase 4: Process sidechains and store them in state
    //

    const sidechainStateChanged = runSidechainsPhase({
        state,
        sidechainMessages,
        changed,
        allocateId,
    });

    runModeSwitchEventsPhase({
        state,
        nonSidechainMessages,
        changed,
        allocateId,
    });

    const incomingObservationMetadataById = new Map(
        orderedIncomingMessages.map((message) => [message.id, message] as const),
    );
    const incomingObservationMetadataByLocalId = new Map(
        orderedIncomingMessages
            .filter((message): message is typeof message & { localId: string } => typeof message.localId === 'string')
            .map((message) => [message.localId, message] as const),
    );
    for (const [source, target] of authoritativeTranscriptTargetsBySource) {
        if (applyAuthoritativeTranscriptTextUpdate(target, source)) {
            changed.add(target.messageId);
        }
    }
    const hasIncomingMessageActionReference = orderedIncomingMessages.some(
        (message) => message.messageActionReference !== undefined,
    );
    const hasIncomingReferenceRetraction = orderedIncomingMessages.some((message) => {
        const knownMessageId = state.messageIds.get(message.id)
            ?? (typeof message.localId === 'string' ? state.localIds.get(message.localId) : undefined);
        return knownMessageId !== undefined
            && state.messages.get(knownMessageId)?.messageActionReference !== undefined;
    });
    const shouldReconcileUnchangedMessageReferences = hasIncomingMessageActionReference
        || hasIncomingReferenceRetraction;
    const applyIncomingObservationMetadata = (message: ReducerMessage): boolean => {
        const source = (message.realID ? incomingObservationMetadataById.get(message.realID) : undefined)
            ?? (message.localId ? incomingObservationMetadataByLocalId.get(message.localId) : undefined);
        if (!source) return false;
        const previousReference = message.messageActionReference;
        applyTranscriptObservationMetadata(message, source);
        return !areMessageActionReferencesEqual(previousReference, message.messageActionReference);
    };

    // A server-issued reference can change or be revoked while the durable text
    // stays byte-for-byte identical. Reconcile existing flattened rows only for
    // those reference-bearing/retracting batches; normal streaming retains the
    // previous changed-row-only work.
    for (const [id, message] of state.messages) {
        if (!changed.has(id) && !shouldReconcileUnchangedMessageReferences) continue;
        if (applyIncomingObservationMetadata(message)) changed.add(id);
    }

    //
    // Collect changed messages (only root-level messages)
    //

    // Sidechain children should never be emitted as top-level transcript updates. They belong to
    // sidechain state only and are rendered under the owning tool-call when that tool-call exists.
    const sidechainChildIds = new Set<string>();
    for (const chain of state.sidechains.values()) {
        for (const m of chain) {
            sidechainChildIds.add(m.id);
            if ((changed.has(m.id) || shouldReconcileUnchangedMessageReferences)
                && applyIncomingObservationMetadata(m)) {
                changed.add(m.id);
            }
        }
    }

    const filteredSidechainChildIds: string[] = [];
    for (let id of changed) {
        if (sidechainChildIds.has(id)) {
            if (DEBUG_SIDECHAINS) filteredSidechainChildIds.push(id);
            continue;
        }

        let existing = state.messages.get(id);
        if (!existing) continue;

        let message = convertReducerMessageToMessage(existing, state);
        if (message) {
            newMessages.push(message);
        }
    }

    if (DEBUG_SIDECHAINS && filteredSidechainChildIds.length > 0) {
        console.debug('[REDUCER][sidechains] filtered sidechain child messages from root transcript update', {
            count: filteredSidechainChildIds.length,
            ids: filteredSidechainChildIds,
        });
    }

    //
    // Debug changes
    //

    if (ENABLE_LOGGING) {
        console.log(JSON.stringify(messages, null, 2));
        console.log(`[REDUCER] Changed messages: ${changed.size}`);
    }

    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize,
            ...(typeof state.latestUsage.contextWindowTokens === 'number'
                ? { contextWindowTokens: state.latestUsage.contextWindowTokens }
                : {})
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined,
        latestReadyEventSeq: latestReadyEventSeq ?? undefined,
        latestReadyEventAt: latestReadyEventAt ?? undefined,
        reducerStateChanged: sidechainStateChanged || undefined,
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function readContextUsageTelemetryNumber(usage: UsageData, key: string): number | null {
    const record = asRecord(usage);
    const value = record?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function readContextWindowTokensFromUsage(usage: UsageData): number | null {
    return readContextUsageTelemetryNumber(usage, 'context_window_tokens');
}

function readContextUsedTokensFromUsage(usage: UsageData): number | null {
    return readContextUsageTelemetryNumber(usage, 'context_used_tokens');
}

function readContextSnapshotFromUsage(usage: UsageData): SessionContextUsageSnapshotV1 | null {
    const usageRecord = asRecord(usage);
    const result = SessionContextUsageSnapshotV1Schema.safeParse(
        usageRecord?.contextSnapshot ?? usageRecord?.context_snapshot,
    );
    return result.success ? result.data : null;
}

function buildDerivedContextSnapshot(params: Readonly<{
    usedTokens: number;
    windowTokens: number | null;
    observedAtMs: number;
}>): SessionContextUsageSnapshotV1 {
    return {
        v: 1,
        modelId: null,
        usedTokens: params.usedTokens,
        windowTokens: params.windowTokens,
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: params.observedAtMs,
        source: 'derived_estimate',
    };
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number) {
    // Only update if this is newer than the current latest usage
    if (!state.latestUsage || timestamp > state.latestUsage.timestamp) {
        const reportedContextWindowTokens = readContextWindowTokensFromUsage(usage);
        const contextWindowTokens = reportedContextWindowTokens ?? state.latestUsage?.contextWindowTokens ?? null;
        const derivedContextSize = (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens;
        const contextSize =
            readContextUsedTokensFromUsage(usage) ??
            (reportedContextWindowTokens !== null ? state.latestUsage?.contextSize ?? 0 : derivedContextSize);
        const incomingProviderSnapshot = readContextSnapshotFromUsage(usage);
        const previousProviderSnapshot = state.latestUsage && state.latestUsage.contextSnapshot.source !== 'derived_estimate'
            ? state.latestUsage.contextSnapshot
            : null;
        // Prefer the snapshot the provider observed most recently. Record timestamps and
        // snapshot observedAtMs ride the same monotonic clock, but a transport reorder of a
        // turn-end vs on-demand snapshot could otherwise let a newer-arriving-but-staler
        // reading overwrite a fresher one. Tiebreak on observedAtMs (R-L2 F-R-L2-1).
        const providerSnapshot = incomingProviderSnapshot
            && (!previousProviderSnapshot
                || incomingProviderSnapshot.observedAtMs >= previousProviderSnapshot.observedAtMs)
            ? incomingProviderSnapshot
            : null;
        const contextSnapshot = providerSnapshot
            ?? previousProviderSnapshot
            ?? buildDerivedContextSnapshot({
                usedTokens: contextSize,
                windowTokens: contextWindowTokens,
                observedAtMs: timestamp,
            });
        // Context-only records (Claude on-demand/live `getContextUsage()`)
        // carry no token counts; keep the previous turn's totals and update
        // only the context truth.
        const isContextOnly = asRecord(usage)?.context_only === true;
        state.latestUsage = {
            inputTokens: isContextOnly ? state.latestUsage?.inputTokens ?? 0 : usage.input_tokens,
            outputTokens: isContextOnly ? state.latestUsage?.outputTokens ?? 0 : usage.output_tokens,
            cacheCreation: isContextOnly ? state.latestUsage?.cacheCreation ?? 0 : usage.cache_creation_input_tokens || 0,
            cacheRead: isContextOnly ? state.latestUsage?.cacheRead ?? 0 : usage.cache_read_input_tokens || 0,
            contextSize: contextSnapshot.usedTokens,
            ...(contextSnapshot.windowTokens !== null
                ? { contextWindowTokens: contextSnapshot.windowTokens }
                : contextWindowTokens !== null
                    ? { contextWindowTokens }
                    : {}),
            contextSnapshot,
            contextSnapshotStale: providerSnapshot
                ? false
                : previousProviderSnapshot
                    ? state.latestUsage?.contextSnapshotStale === true
                    : false,
            timestamp: timestamp
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    const observationMetadata: TranscriptObservationMetadata = {
        ...(reducerMsg.sourceCreatedAt !== undefined ? { sourceCreatedAt: reducerMsg.sourceCreatedAt } : {}),
        ...(reducerMsg.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: reducerMsg.sourceUpdatedAt } : {}),
        ...(reducerMsg.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: reducerMsg.transcriptObservationProvenance }
            : {}),
        ...(reducerMsg.deliveryResolution !== undefined
            ? { deliveryResolution: reducerMsg.deliveryResolution }
            : {}),
            ...(reducerMsg.messageActionReference !== undefined
            ? { messageActionReference: reducerMsg.messageActionReference }
            : {}),
    };
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        const displayText = typeof reducerMsg.meta?.displayText === 'string' ? reducerMsg.meta.displayText : undefined;
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(displayText !== undefined ? { displayText } : {}),
            meta: reducerMsg.meta,
            ...(reducerMsg.structuredPresentation !== undefined
                ? { structuredPresentation: reducerMsg.structuredPresentation }
                : {}),
            ...observationMetadata,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            meta: reducerMsg.meta,
            ...(reducerMsg.structuredPresentation !== undefined
                ? { structuredPresentation: reducerMsg.structuredPresentation }
                : {}),
            ...observationMetadata,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively
        let childMessages: Message[] = [];
        const toolId = typeof reducerMsg.tool.id === 'string' ? reducerMsg.tool.id.trim() : '';
        const sidechainKey =
            toolId.length > 0
                ? (!state.sidechains.has(toolId) && reducerMsg.realID ? reducerMsg.realID : toolId)
                : reducerMsg.realID ?? null;
        let children = sidechainKey ? state.sidechains.get(sidechainKey) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            localId: reducerMsg.localId,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool },
            children: childMessages,
            meta: reducerMsg.meta,
            ...observationMetadata,
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            realID: reducerMsg.realID,
            ...(typeof reducerMsg.seq === 'number' ? { seq: reducerMsg.seq } : {}),
            ...(typeof reducerMsg.transcriptBlockIndex === 'number' ? { transcriptBlockIndex: reducerMsg.transcriptBlockIndex } : {}),
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta,
            ...observationMetadata,
        };
    }

    return null;
}
