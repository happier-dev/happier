import { readReleasedOutputNonTranscriptRecordTypes } from '@happier-dev/agents/definitions/released-output-transcript-record-reader';
import { createEmptyCanonicalTurnDiffSuppressionState, rememberSuppressedEmptyCanonicalTurnDiffCallId, shouldSuppressEmptyCanonicalTurnDiffToolResult } from '@happier-dev/protocol/sessions/messages/emptyCanonicalTurnDiffSuppression';
import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import type { EmptyCanonicalTurnDiffSuppressionState, MessageStructuredPresentationV1, SessionMessageRole } from '@happier-dev/protocol';
import { isSessionToolAnswerDeliveryMeta } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { readEmptyCanonicalTurnDiffToolCallId, shouldSuppressEmptyCanonicalTurnDiffToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { SessionForkVisualOriginV1Schema } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readTranscriptPeerSenderV1, type TranscriptPeerSenderV1 } from '@happier-dev/protocol/sessions/messages/transcriptPeerSenderV1';
import type { z } from 'zod/mini';

import type { MessageMeta } from "../messages/messageMetaTypes.js";
import { markUnsupportedContentMeta } from "../messages/unsupportedContentMeta.js";
import type { TranscriptObservationMetadata } from "../messages/transcriptObservationProvenance.js";
import type { TranscriptAccountActorMetadata } from "../messages/transcriptAccountActor.js";
import {
    hasSyntheticNoResponseMeta,
    markSyntheticNoResponseMeta,
    SYNTHETIC_NO_RESPONSE_TEXT,
} from "../messages/syntheticNoResponseMessageMeta.js";
import { rawRecordSchema, type AgentEvent, type RawAgentContent, type RawRecord, type UsageData } from "./schemas.js";
import { extractUsageDataFromTokenCountRecord } from "./tokenCountUsage.js";

// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
        /** Sender when another agent delivered this text into the Agent's conversation. */
        peer?: TranscriptPeerSenderV1;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        /** Original native correlation id, when this is an inherited source projection. */
        sourceToolId?: string;
        name: string;
        input: any;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        sourceToolId?: string;
        content: any;
        toolUseResult?: unknown;
        tool_use_result?: unknown;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        };
    } | {
        type: 'summary',
        summary: string;
    } | {
        type: 'sidechain'
        uuid: string;
        prompt: string
    };

type ToolResultPermissions = Extract<NormalizedAgentContent, { type: 'tool-result' }>['permissions'];

export type NormalizedMessage = ({
    role: 'user'
    content: {
        type: 'text';
        text: string;
    }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string,
    /**
     * Materialized transcript sequence (server ordering cursor).
     * Optional for backwards compatibility with older call sites.
     */
    seq?: number,
    localId: string | null,
    createdAt: number,
    isSidechain: boolean,
    // Provider-emitted identifier linking sidechain messages to their originating tool call.
    // Used to group sub-agent threads (e.g. Claude Task sidechains) in a provider-agnostic way.
    sidechainId?: string,
    meta?: MessageMeta,
    usage?: UsageData,
    /** Validated persisted transcript snapshot; never re-resolved against the current daemon. */
    structuredPresentation?: MessageStructuredPresentationV1,
    /** Set only by canonical ACK and socket readers for a server-declared durable row update. */
    isAuthoritativeUpdate?: true,
} & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type RawMessageNormalizationInput = Readonly<{
    id: string;
    localId?: string | null;
    sidechainId?: string | null;
    createdAt: number;
    raw: unknown;
    seq?: number | null;
    messageRole?: SessionMessageRole | null;
}>;

type RawMessageNormalizationOptions = Readonly<{
    seq?: number;
    messageRole?: SessionMessageRole | null;
    sidechainId?: string | null;
}>;

function normalizeExplicitSidechainId(sidechainId: string | null | undefined): string | undefined {
    return typeof sidechainId === 'string' && sidechainId.trim().length > 0
        ? sidechainId.trim()
        : undefined;
}

export type RawMessageNormalizationSequenceState = EmptyCanonicalTurnDiffSuppressionState;

type ContextCompactionAgentEvent = Extract<AgentEvent, { type: 'context-compaction' }>;
const storedAgentEventSchema = createStoredReadSchema(TranscriptRawAgentEventV1Schema);

function isContextCompactionPhase(value: unknown): value is ContextCompactionAgentEvent['phase'] {
    return value === 'started' || value === 'progress' || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isContextCompactionAgentEvent(value: unknown): value is ContextCompactionAgentEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.type === 'context-compaction' && isContextCompactionPhase(record.phase);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordString(value: unknown, key: string): string | null {
    if (!isPlainRecord(value)) return null;
    const raw = value[key];
    return typeof raw === 'string' ? raw : null;
}

/** The canonical parser, not a second kind inventory, decides whether a presentation tag is known. */
function isUnknownPresentationKind(input: unknown, issues: readonly z.core.$ZodIssue[]): boolean {
    return issues.length > 0 && issues.every((issue) => {
        if (issue.code !== 'invalid_union' || issue.discriminator !== 'type' || issue.errors.length > 0) return false;
        let value: unknown = input;
        for (const key of issue.path) {
            if (!isPlainRecord(value) || typeof key !== 'string') return false;
            value = value[key];
        }
        return typeof value === 'string' && value.trim().length > 0;
    });
}

function unparsedRawMessage(input: Readonly<{
    id: string; localId: string | null; createdAt: number; seq?: number;
    role: 'user' | 'agent'; sidechainId?: string; meta?: MessageMeta;
}>): NormalizedMessage {
    const { role, sidechainId, meta, ...identity } = input;
    const kind = role === 'user' ? 'unparsed-user-message' : 'unparsed-agent-message';
    const text = role === 'user' ? '[Unparsed user message]' : '[Unparsed agent message]';
    return role === 'user'
        ? { ...identity, role, ...(sidechainId ? { sidechainId } : {}), isSidechain: Boolean(sidechainId),
            content: { type: 'text', text }, meta: markUnsupportedContentMeta(meta, kind) }
        : { ...identity, role, isSidechain: false,
            content: [{ type: 'text', text, uuid: input.id, parentUUID: null }], meta: markUnsupportedContentMeta(meta, kind) };
}

function readSingleTextContentBlock(value: unknown): string | null {
    if (!Array.isArray(value) || value.length !== 1) return null;
    const block = value[0];
    if (!isPlainRecord(block) || block.type !== 'text') return null;
    return typeof block.text === 'string' ? block.text : null;
}

function isClaudeSyntheticNoResponseOutputData(value: unknown): boolean {
    if (!isPlainRecord(value) || value.type !== 'assistant') return false;
    const message = value.message;
    if (!isPlainRecord(message)) return false;
    const model = readRecordString(value, 'model') ?? readRecordString(message, 'model');
    return model === '<synthetic>'
        && readSingleTextContentBlock(message.content)?.trim() === SYNTHETIC_NO_RESPONSE_TEXT;
}

/**
 * 0.2 CLIs (PR #702, `formatClaudePeerMessageText`) persist Claude peer deliveries as raw `user`
 * output rows with `origin.kind === 'peer'` and a `From <sender>:` label on the body. They are
 * the delivering agent's text, not user input. Current CLIs commit the clean body with a `peer`
 * sidecar instead; remove this reader once 0.2 peer rows are no longer readable history.
 */
function readLegacyClaudePeerOutput(data: unknown): Readonly<{ text: string; peer: TranscriptPeerSenderV1 }> | null {
    if (!isPlainRecord(data) || data.type !== 'user' || !isPlainRecord(data.origin) || data.origin.kind !== 'peer') return null;
    const content = isPlainRecord(data.message) ? data.message.content : undefined;
    if (typeof content !== 'string') return null;
    const name = typeof data.origin.name === 'string' && data.origin.name.trim() ? data.origin.name.trim() : null;
    const label = `From ${name ?? 'Peer'}:\n\n`;
    return {
        text: content.startsWith(label) ? content.slice(label.length) : content,
        peer: { name, handback: data.origin.handback === true },
    };
}

function shouldKeepNormalizedEventRoleOutput(message: NormalizedMessage, messageRole: SessionMessageRole | null | undefined): boolean {
    if (messageRole !== 'event') return true;
    if (message.role !== 'agent') return false;
    if (hasSyntheticNoResponseMeta(message.meta)) return true;
    return message.content.some((content) =>
        content.type === 'thinking'
        || content.type === 'tool-call'
        || content.type === 'tool-result'
    );
}

function filterNormalizedEventRoleOutput(
    message: NormalizedMessage,
    messageRole: SessionMessageRole | null | undefined,
): NormalizedMessage | null {
    return shouldKeepNormalizedEventRoleOutput(message, messageRole) ? message : null;
}

export function createRawMessageNormalizationSequenceState(): RawMessageNormalizationSequenceState {
    return createEmptyCanonicalTurnDiffSuppressionState();
}

function filterSuppressedEmptyCanonicalTurnDiffToolResults(
    message: NormalizedMessage,
    state: RawMessageNormalizationSequenceState,
): NormalizedMessage | null {
    const suppressedEmptyCanonicalTurnDiffCallIds = state.suppressedEmptyCanonicalTurnDiffCallIds;
    if (message.role !== 'agent') {
        return message;
    }

    let didFilter = false;
    const matchedCallIds = new Set<string>();
    const content = message.content.filter((item) => {
        if (item.type !== 'tool-result') {
            return true;
        }
        const shouldFilter = shouldSuppressEmptyCanonicalTurnDiffToolResult(state, item.tool_use_id, item.content, matchedCallIds);
        if (shouldFilter) didFilter = true;
        return !shouldFilter;
    });
    for (const callId of matchedCallIds) {
        suppressedEmptyCanonicalTurnDiffCallIds.delete(callId);
    }
    if (!didFilter) return message;
    if (content.length === 0) return null;
    return {
        ...message,
        content,
    };
}

export function normalizeRawMessageInSequence(
    input: RawMessageNormalizationInput,
    state: RawMessageNormalizationSequenceState,
): NormalizedMessage | null {
    const emptyTurnDiffCallId = readEmptyCanonicalTurnDiffToolCallId(input.raw);
    const normalized = normalizeRawMessage(
        input.id,
        typeof input.localId === 'string' ? input.localId : null,
        input.createdAt,
        input.raw,
        {
            seq: typeof input.seq === 'number' ? input.seq : undefined,
            messageRole: input.messageRole ?? undefined,
            sidechainId: input.sidechainId ?? undefined,
        },
    );
    if (!normalized) {
        if (emptyTurnDiffCallId) {
            rememberSuppressedEmptyCanonicalTurnDiffCallId(state, emptyTurnDiffCallId);
        }
        return null;
    }

    return filterSuppressedEmptyCanonicalTurnDiffToolResults(
        normalized,
        state,
    );
}

export function normalizeRawMessages(items: ReadonlyArray<RawMessageNormalizationInput>): NormalizedMessage[] {
    const state = createRawMessageNormalizationSequenceState();
    const out: NormalizedMessage[] = [];
    for (const item of items) {
        const normalized = normalizeRawMessageInSequence(item, state);
        if (normalized) out.push(normalized);
    }
    return out;
}

function normalizeRawMessageFromRaw(
    id: string,
    localId: string | null,
    createdAt: number,
    rawInput: unknown,
    opts?: RawMessageNormalizationOptions,
): NormalizedMessage | null {
    const seq = typeof opts?.seq === 'number' && Number.isFinite(opts.seq) ? Math.trunc(opts.seq) : undefined;
    const sidechainId = normalizeExplicitSidechainId(opts?.sidechainId);

    // Zod transform handles normalization during validation
    const parsed = rawRecordSchema.safeParse(rawInput);
    if (!parsed.success) {
        if (isPlainRecord(rawInput) && rawInput.role === 'agent' && isUnknownPresentationKind(rawInput, parsed.error.issues)) return null;
        // Never log full raw messages in production: tool outputs and user text may contain secrets.
        // Keep enough context for debugging in dev builds only.
        console.error(`[typesRaw] Message validation failed (id=${id})`);
        if ((globalThis as { __DEV__?: boolean }).__DEV__) {
            const contentType = (rawInput as any)?.content?.type;
            const dataType = (rawInput as any)?.content?.data?.type;
            const provider = (rawInput as any)?.content?.agentId;
            const toolName =
                contentType === 'codex'
                    ? (rawInput as any)?.content?.data?.name
                    : contentType === 'acp'
                        ? (rawInput as any)?.content?.data?.name
                        : null;
            const callId =
                contentType === 'codex'
                    ? (rawInput as any)?.content?.data?.callId
                    : contentType === 'acp'
                        ? (rawInput as any)?.content?.data?.callId
                        : null;

            console.error('Zod issues:', JSON.stringify(parsed.error.issues, null, 2));
            console.error('Raw summary:', {
                role: (rawInput as any)?.role,
                contentType,
                dataType,
                provider,
                toolName: typeof toolName === 'string' ? toolName : undefined,
                callId: typeof callId === 'string' ? callId : undefined,
            });
        }
        const raw = isPlainRecord(rawInput) ? rawInput : null;
        return unparsedRawMessage({ id, localId, createdAt, ...(seq !== undefined ? { seq } : {}),
            role: raw?.role === 'user' ? 'user' : 'agent', sidechainId,
            // Unparsed metadata is retained only with the existing diagnostic marker at this read boundary.
            meta: raw?.meta as MessageMeta | undefined });
    }
    const raw = parsed.data as RawRecord;
    if (raw.role === 'user' && isSessionToolAnswerDeliveryMeta(raw.meta)) return null;

    const toolResultContentToText = (content: unknown): string => {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') return content;

        // Claude sometimes sends tool_result.content as [{ type: 'text', text: '...' }]
        if (Array.isArray(content)) {
            const maybeTextBlocks = content as Array<{ type?: unknown; text?: unknown }>;
            const isTextBlocks = maybeTextBlocks.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
            if (isTextBlocks) {
                return maybeTextBlocks.map((b) => b.text as string).join('');
            }

            try {
                return JSON.stringify(content);
            } catch {
                return String(content);
            }
        }

        try {
            return JSON.stringify(content);
        } catch {
            return String(content);
        }
    };

    const normalizeToolResultPermissions = (rawPermissions: unknown): ToolResultPermissions => {
        if (!rawPermissions || typeof rawPermissions !== 'object') return undefined;
        const record = rawPermissions as Record<string, unknown>;
        const date = typeof record.date === 'number' ? record.date : undefined;
        const result = record.result === 'approved' || record.result === 'denied' ? record.result : undefined;
        const mode = typeof record.mode === 'string' ? record.mode : undefined;
        const allowedTools = Array.isArray(record.allowedTools)
            ? record.allowedTools.filter((tool): tool is string => typeof tool === 'string')
            : undefined;
        const decisionRaw = record.decision;
        const decision =
            decisionRaw === 'approved'
            || decisionRaw === 'approved_for_session'
            || decisionRaw === 'approved_execpolicy_amendment'
            || decisionRaw === 'denied'
            || decisionRaw === 'abort'
                ? decisionRaw
                : undefined;

        if (date === undefined || result === undefined) return undefined;
        return {
            date,
            result,
            ...(mode !== undefined ? { mode } : {}),
            ...(allowedTools !== undefined ? { allowedTools } : {}),
            ...(decision !== undefined ? { decision } : {}),
        };
    };

    const isClaudeTaskNotificationText = (text: string): boolean => {
        const raw = String(text ?? '');
        // Claude Code emits these as user-text messages; they are redundant with task sidechain transcripts
        // and make the main session transcript unreadable.
        return /^\s*<task-notification>/i.test(raw);
    };

    const maybeParseJsonString = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed) return value;
        const first = trimmed[0];
        if (first !== '{' && first !== '[') return value;
        try {
            return JSON.parse(trimmed) as unknown;
        } catch {
            return value;
        }
    };

    if (raw.role === 'user') {
        return {
            id,
            ...(seq !== undefined ? { seq } : {}),
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            ...(sidechainId ? { sidechainId } : {}),
            isSidechain: Boolean(sidechainId),
            meta: raw.meta,
        };
    }
    if (raw.role === 'agent') {
        const metaSidechainIdRaw =
            raw.meta && typeof (raw.meta as any).sidechainId === 'string'
                ? (raw.meta as any).sidechainId
                : (
                    raw.meta && typeof (raw.meta as any).sidechain_id === 'string'
                        ? (raw.meta as any).sidechain_id
                        : undefined
                );
        const metaSidechainId =
            typeof metaSidechainIdRaw === 'string' && metaSidechainIdRaw.trim().length > 0
                ? metaSidechainIdRaw.trim()
                : undefined;
        const metaIsSidechain =
            raw.meta && typeof (raw.meta as any).isSidechain === 'boolean'
                ? Boolean((raw.meta as any).isSidechain)
                : (
                    raw.meta && typeof (raw.meta as any).is_sidechain === 'boolean'
                        ? Boolean((raw.meta as any).is_sidechain)
                        : false
                );

        const getOutputSidechainId = (data: any): string | undefined => {
            const rawId =
                typeof data?.sidechainId === 'string'
                    ? data.sidechainId
                    : (typeof data?.sidechain_id === 'string' ? data.sidechain_id : undefined);
            return typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : undefined;
        };

        const getOutputIsSidechain = (data: any): boolean => {
            if (typeof data?.isSidechain === 'boolean') return Boolean(data.isSidechain);
            if (typeof data?.is_sidechain === 'boolean') return Boolean(data.is_sidechain);
            return false;
        };

        const resolveStructuredContentSidechain = (data: any): Readonly<{
            sidechainId?: string;
            isSidechain: boolean;
        }> => {
            const sidechainId = metaSidechainId ?? getOutputSidechainId(data);
            const legacyIsSidechain = getOutputIsSidechain(data);
            return {
                ...(sidechainId ? { sidechainId } : {}),
                isSidechain: Boolean(sidechainId) || legacyIsSidechain || metaIsSidechain,
            };
        };

        type OutputAssistantData = {
            type: 'assistant';
            uuid?: string | null;
            parentUuid?: string | null;
            message: { content: string | RawAgentContent[]; usage?: UsageData };
        };

        const isOutputAssistantData = (value: unknown): value is OutputAssistantData => {
            if (!value || typeof value !== 'object') return false;
            const v = value as Record<string, unknown>;
            if (v.type !== 'assistant') return false;
            const message = v.message;
            if (!message || typeof message !== 'object') return false;
            const content = (message as Record<string, unknown>).content;
            return typeof content === 'string' || Array.isArray(content);
        };

        type OutputUserData = {
            type: 'user';
            uuid?: string | null;
            parentUuid?: string | null;
            toolUseResult?: unknown | null;
            message: { content: string | RawAgentContent[] };
        };

        const isOutputUserData = (value: unknown): value is OutputUserData => {
            if (!value || typeof value !== 'object') return false;
            const v = value as Record<string, unknown>;
            if (v.type !== 'user') return false;
            const message = v.message;
            if (!message || typeof message !== 'object') return false;
            const content = (message as Record<string, unknown>).content;
            return typeof content === 'string' || Array.isArray(content);
        };

			        if (raw.content.type === 'output') {
            const outputData: unknown = raw.content.data;
            const outputOrigin = isPlainRecord(outputData) ? outputData.origin : null;
            const nativeTaskNotification = isPlainRecord(outputOrigin) && outputOrigin.kind === 'task-notification';
            // cli-v0.2.13 persisted settled native task results with isMeta. Only that
            // single correlated result is compatibility data, not arbitrary metadata.
            const nativeTaskResult = nativeTaskNotification
                && isOutputUserData(raw.content.data) && Array.isArray(raw.content.data.message.content)
                && raw.content.data.message.content.length === 1
                && raw.content.data.message.content.every(block => isPlainRecord(block)
                    && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
                    && typeof outputOrigin.toolUseId === 'string' && outputOrigin.toolUseId === block.tool_use_id);
            if (raw.content.data.isMeta && !nativeTaskResult) {
                return null;
            }

            // Skip compact summary messages
            if (raw.content.data.isCompactSummary) {
                return null;
            }

            if (isClaudeSyntheticNoResponseOutputData(raw.content.data)) {
                const outputUuid = readRecordString(raw.content.data, 'uuid') ?? id;
                return {
                    id,
                    ...(seq !== undefined ? { seq } : {}),
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: SYNTHETIC_NO_RESPONSE_TEXT,
                        uuid: outputUuid,
                        parentUUID: null,
                    }],
                    meta: markSyntheticNoResponseMeta(raw.meta),
                } satisfies NormalizedMessage;
            }

            // Legacy Claude output rows from predecessor writers use the native plugin's
            // classification. Unknown event types retain their unsupported-content diagnostic.
            if (typeof raw.content.data.type === 'string' && readReleasedOutputNonTranscriptRecordTypes().has(raw.content.data.type)) {
                return null;
            }

            // Progress can carry sidechain data used by native observers, but is not a UI row.
            if (raw.content.data.type === 'progress') {
                return null;
            }

            // Claude Code "system" output payloads (e.g. `stop_hook_summary`, `away_summary`) are
            // informational only and are not part of the agent transcript. Drop them so they don't
            // surface as `[Unsupported agent output]` placeholders.
            if ((raw.content.data as { type?: unknown }).type === 'system') {
                return null;
            }

		            // Handle Assistant messages (including sidechains)
		            if (isOutputAssistantData(raw.content.data)) {
		                const outputUuid = raw.content.data.uuid ?? id;

		                const isRecord = (value: unknown): value is Record<string, unknown> =>
		                    typeof value === 'object' && value !== null;

	                // Claude's streaming API encodes sidechains via parent_tool_use_id.
	                // Map that to the provider-agnostic `sidechainId` so reducer sidechain linking can attach
	                // sub-agent transcripts to the originating tool call and keep them out of the main transcript.
	                const claudeParentToolUseId =
	                    typeof (raw.content.data as any).parent_tool_use_id === 'string'
                        ? String((raw.content.data as any).parent_tool_use_id)
	                        : undefined;
		                let content: NormalizedAgentContent[] = [];
                        const assistantRawContent = raw.content.data.message.content;
                        if (typeof assistantRawContent === 'string') {
                            content.push({
                                type: 'text',
                                text: assistantRawContent,
                                uuid: outputUuid,
                                parentUUID: raw.content.data.parentUuid ?? null,
                            });
                        } else {
		                    for (const cRaw of assistantRawContent) {
			                        if (!isRecord(cRaw) || typeof cRaw.type !== 'string') continue;
			                        if (cRaw.type === 'text') {
			                            content.push({
			                                ...(cRaw as Record<string, unknown>),  // WOLOG: Preserve all fields including unknown ones
			                                uuid: outputUuid,
			                                parentUUID: raw.content.data.parentUuid ?? null
			                            } as NormalizedAgentContent);
			                        } else if (cRaw.type === 'thinking') {
			                            content.push({
			                                ...(cRaw as Record<string, unknown>),  // WOLOG: Preserve all fields including unknown ones (signature, etc.)
			                                uuid: outputUuid,
			                                parentUUID: raw.content.data.parentUuid ?? null
			                            } as NormalizedAgentContent);
			                        } else if (cRaw.type === 'tool_use') {
		                                let description: string | null = null;
		                                const input = cRaw.input;
		                                if (isRecord(input) && typeof input.description === 'string') {
		                                    description = input.description;
			                            }
			                            content.push({
			                                ...(cRaw as Record<string, unknown>),  // WOLOG: Preserve all fields including unknown ones
			                                type: 'tool-call',
			                                description,
			                                uuid: outputUuid,
			                                parentUUID: raw.content.data.parentUuid ?? null
	                                } as NormalizedAgentContent);
	                        }
	                    }
	                }
                    const sidechainId = metaSidechainId ?? getOutputSidechainId(raw.content.data) ?? claudeParentToolUseId;
                    const legacyIsSidechain = getOutputIsSidechain(raw.content.data);
	                  return filterNormalizedEventRoleOutput({
	                        id,
	                        ...(seq !== undefined ? { seq } : {}),
	                        localId,
	                        createdAt,
	                      role: 'agent',
	                      sidechainId,
	                      isSidechain: Boolean(sidechainId) || legacyIsSidechain || metaIsSidechain,
	                      content,
	                      meta: raw.meta,
	                      usage: raw.content.data.message.usage
	                  }, opts?.messageRole);
	            } else if (isOutputUserData(raw.content.data)) {
	                const outputUuid = raw.content.data.uuid ?? id;

                const claudeParentToolUseId =
                    typeof (raw.content.data as any).parent_tool_use_id === 'string'
                        ? String((raw.content.data as any).parent_tool_use_id)
                        : undefined;
                  const sidechainId = metaSidechainId ?? getOutputSidechainId(raw.content.data) ?? claudeParentToolUseId;
                const isSidechain = Boolean(sidechainId) || getOutputIsSidechain(raw.content.data) || metaIsSidechain;

                // Another agent's delivery belongs to the Agent's conversation, not the user's.
                const legacyPeer = readLegacyClaudePeerOutput(raw.content.data);
                if (legacyPeer) {
                    return filterNormalizedEventRoleOutput({
                        id,
                        ...(seq !== undefined ? { seq } : {}),
                        localId,
                        createdAt,
                        role: 'agent',
                        ...(sidechainId ? { sidechainId } : {}),
                        isSidechain,
                        content: [{
                            type: 'text',
                            text: legacyPeer.text,
                            uuid: outputUuid,
                            parentUUID: raw.content.data.parentUuid ?? null,
                            peer: legacyPeer.peer,
                        }],
                    }, opts?.messageRole);
                }

	                // Handle sidechain user messages
	                if (isSidechain && raw.content.data.message && typeof raw.content.data.message.content === 'string') {
	                    // Return as a special agent message with sidechain content
	                      return filterNormalizedEventRoleOutput({
	                          id,
	                          ...(seq !== undefined ? { seq } : {}),
	                          localId,
	                          createdAt,
	                          role: 'agent',
	                          isSidechain: true,
	                          sidechainId,
	                        content: [{
	                            type: 'sidechain',
	                            uuid: outputUuid,
	                            prompt: raw.content.data.message.content
	                        }]
	                    }, opts?.messageRole);
	                }

                // Handle regular user messages
                if (raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    if (nativeTaskNotification && isClaudeTaskNotificationText(raw.content.data.message.content)) {
                        return null;
                    }
                    return filterNormalizedEventRoleOutput({
                        id,
                        ...(seq !== undefined ? { seq } : {}),
                        localId,
                        createdAt,
                        role: 'user',
                        sidechainId,
                        isSidechain,
                        content: {
                            type: 'text',
                            text: raw.content.data.message.content
                        }
                    }, opts?.messageRole);
                }

                // Handle tool results
	                let content: NormalizedAgentContent[] = [];
	                if (typeof raw.content.data.message.content === 'string') {
	                    content.push({
	                        type: 'text',
	                        text: raw.content.data.message.content,
	                        uuid: outputUuid,
	                        parentUUID: raw.content.data.parentUuid ?? null
	                    });
	                } else {
	                    for (let c of raw.content.data.message.content) {
		                        if (c.type === 'tool_result') {
		                            const rawResultContent = raw.content.data.toolUseResult ?? c.content;
		                            content.push({
		                                ...c,  // WOLOG: Preserve all fields including unknown ones
	                                type: 'tool-result',
	                                content: toolResultContentToText(rawResultContent),
                                is_error: c.is_error || Boolean(raw.content.data.isMeta && nativeTaskResult
                                    && (outputOrigin.status === 'failed' || outputOrigin.status === 'stopped')),
		                                uuid: outputUuid,
		                                parentUUID: raw.content.data.parentUuid ?? null,
		                                permissions: normalizeToolResultPermissions(c.permissions),
		                            } as NormalizedAgentContent);
		                        }
		                    }
		                }
                  return filterNormalizedEventRoleOutput({
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      sidechainId,
                      isSidechain,
                    content,
                    meta: raw.meta
                }, opts?.messageRole);
            }
            // Future provider presentation records are skippable; they are not assistant text.
            return null;
        }
          if (raw.content.type === 'event') {
              return {
                  id,
                  ...(seq !== undefined ? { seq } : {}),
                  localId,
                  createdAt,
                  role: 'event',
                  content: raw.content.data,
                  isSidechain: false,
            };
        }
        if (raw.content.type === 'codex') {
            const codexDataRecord = raw.content.data as unknown as Record<string, unknown>;
            const structuredSidechain = resolveStructuredContentSidechain(raw.content.data);
              if (raw.content.data.type === 'message') {
                  // Cast codex messages to agent text messages
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                };
            }
              if (raw.content.data.type === 'reasoning') {
                  // Cast codex messages to agent text messages
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'tool-call') {
                  const toolName = raw.content.data.name || 'unknown';
                  if (shouldSuppressEmptyCanonicalTurnDiffToolCall({
                      toolName,
                      input: raw.content.data.input,
                  })) {
                      return null;
                  }
                  // Cast tool calls to agent tool-call messages
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: toolName,
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id ?? id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'tool-call-result' || raw.content.data.type === 'tool-result') {
                  // Cast tool call results to agent tool-result messages
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: toolResultContentToText(raw.content.data.output),
                        is_error: typeof codexDataRecord.isError === 'boolean' ? codexDataRecord.isError : false,
                        uuid: raw.content.data.id ?? id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'token_count') {
                const usage = extractUsageDataFromTokenCountRecord(raw.content.data);
                if (!usage) {
                    return null;
                }

                return {
                    id,
                    ...(seq !== undefined ? { seq } : {}),
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [],
                    meta: raw.meta,
                    usage,
                } satisfies NormalizedMessage;
            }
        }
          // ACP (Agent Communication Protocol) - unified format for all agent providers
          if (raw.content.type === 'acp') {
              const structuredSidechain = resolveStructuredContentSidechain(raw.content.data);
              const acpDataRecord = raw.content.data as unknown as Record<string, unknown>;

              // The host's committed event writer uses this ACP carrier for every Agent.
              // Decode its payload through the same event owner as top-level event records.
              if (raw.content.data.type === 'event') {
                  const event = storedAgentEventSchema.safeParse(acpDataRecord.data);
                  if (!event.success) {
                      if (isUnknownPresentationKind(acpDataRecord.data, event.error.issues)) return null;
                      return unparsedRawMessage({ id, localId, createdAt, ...(seq !== undefined ? { seq } : {}),
                          role: 'agent', meta: raw.meta });
                  }
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'event',
                      isSidechain: false,
                      content: event.data,
                      meta: raw.meta,
                  } satisfies NormalizedMessage;
              }

              if (isContextCompactionAgentEvent(raw.content.data)) {
                  const agentId = typeof raw.content.data.agentId === 'string' && raw.content.data.agentId.trim().length > 0
                      ? raw.content.data.agentId
                      : raw.content.agentId;
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'event',
                      isSidechain: false,
                      content: { ...raw.content.data, agentId },
                      meta: raw.meta,
                  } satisfies NormalizedMessage;
              }

              if (raw.content.data.type === 'text' && typeof acpDataRecord.text === 'string') {
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                      ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                      content: [{
                          type: 'text',
                          text: acpDataRecord.text,
                          uuid: id,
                          parentUUID: null,
                      }],
                      meta: raw.meta,
                  } satisfies NormalizedMessage;
              }

              if (raw.content.data.type === 'message') {
                  const messageText = typeof acpDataRecord.message === 'string' ? acpDataRecord.message : '';
                  const peer = readTranscriptPeerSenderV1(acpDataRecord.peer);
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'text',
                        text: messageText,
                        uuid: id,
                        parentUUID: null,
                        ...(peer ? { peer } : {}),
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'reasoning') {
                  const messageText = typeof acpDataRecord.message === 'string' ? acpDataRecord.message : '';
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'text',
                        text: messageText,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'tool-call') {
                  let description: string | null = null;
                  const parsedInput = maybeParseJsonString(raw.content.data.input);
                const toolName = typeof acpDataRecord.name === 'string' ? acpDataRecord.name : 'unknown';
                if (shouldSuppressEmptyCanonicalTurnDiffToolCall({
                    toolName,
                    input: parsedInput,
                })) {
                    return null;
                }
                const inputObj = (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput))
                    ? (parsedInput as Record<string, unknown>)
                    : null;
                const acpMeta = inputObj && inputObj._acp && typeof inputObj._acp === 'object' && !Array.isArray(inputObj._acp)
                    ? (inputObj._acp as Record<string, unknown>)
                    : null;
                const acpTitle = acpMeta && typeof acpMeta.title === 'string' ? acpMeta.title : null;
                const inputDescription = inputObj && typeof inputObj.description === 'string' ? inputObj.description : null;
                description = acpTitle ?? inputDescription ?? null;
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-call',
                        id: typeof acpDataRecord.callId === 'string' ? acpDataRecord.callId : '',
                        name: toolName,
                        input: parsedInput,
                        description,
                        uuid: typeof acpDataRecord.id === 'string' ? acpDataRecord.id : id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'tool-result') {
                  const parsedOutput = maybeParseJsonString(raw.content.data.output);
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-result',
                        tool_use_id: typeof acpDataRecord.callId === 'string' ? acpDataRecord.callId : '',
                        content: parsedOutput,
                        is_error: typeof acpDataRecord.isError === 'boolean' ? acpDataRecord.isError : false,
                        uuid: typeof acpDataRecord.id === 'string' ? acpDataRecord.id : id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Handle hyphenated tool-call-result (backwards compatibility)
              if (raw.content.data.type === 'tool-call-result') {
                  const parsedOutput = maybeParseJsonString(raw.content.data.output);
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-result',
                        tool_use_id: typeof acpDataRecord.callId === 'string' ? acpDataRecord.callId : '',
                        content: parsedOutput,
                        is_error: false,
                        uuid: typeof acpDataRecord.id === 'string' ? acpDataRecord.id : id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'thinking') {
                  const thinkingText = typeof acpDataRecord.text === 'string' ? acpDataRecord.text : '';
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'thinking',
                        thinking: thinkingText,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'file-edit') {
                  const fileEditId = typeof acpDataRecord.id === 'string' ? acpDataRecord.id : id;
                  const descriptionText = typeof acpDataRecord.description === 'string' ? acpDataRecord.description : '';
                  const filePathText = typeof acpDataRecord.filePath === 'string' ? acpDataRecord.filePath : '';
                  const diffText = typeof acpDataRecord.diff === 'string' ? acpDataRecord.diff : undefined;
                  const oldContentText = typeof acpDataRecord.oldContent === 'string' ? acpDataRecord.oldContent : undefined;
                  const newContentText = typeof acpDataRecord.newContent === 'string' ? acpDataRecord.newContent : undefined;
                  // Map file-edit to tool-call for UI rendering
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-call',
                        id: fileEditId,
                        name: 'file-edit',
                        input: {
                            filePath: filePathText,
                            description: descriptionText,
                            diff: diffText,
                            oldContent: oldContentText,
                            newContent: newContentText
                        },
                        description: descriptionText,
                        uuid: fileEditId,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'terminal-output') {
                  const toolUseId = typeof acpDataRecord.callId === 'string' ? acpDataRecord.callId : '';
                  const toolOutputText = typeof acpDataRecord.data === 'string' ? acpDataRecord.data : '';
                  // Map terminal-output to tool-result
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-result',
                        tool_use_id: toolUseId,
                        content: toolOutputText,
                        is_error: false,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
              if (raw.content.data.type === 'permission-request') {
                  const permissionId = typeof acpDataRecord.permissionId === 'string' ? acpDataRecord.permissionId : '';
                  const toolName = typeof acpDataRecord.toolName === 'string' ? acpDataRecord.toolName : '';
                  const descriptionText = typeof acpDataRecord.description === 'string' ? acpDataRecord.description : '';
                  // Map permission-request to tool-call for UI to show permission dialog
                  const rawOptions = acpDataRecord.options ?? {};
                const input =
                    rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
                        ? { ...(rawOptions as Record<string, unknown>), title: (rawOptions as any).title ?? descriptionText }
                        : rawOptions;
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [{
                        type: 'tool-call',
                        id: permissionId,
                        name: toolName,
                        input,
                        description: descriptionText,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'token_count') {
                const usage = extractUsageDataFromTokenCountRecord(raw.content.data);
                if (!usage) {
                    return null;
                }

                return {
                    id,
                    ...(seq !== undefined ? { seq } : {}),
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [],
                    meta: raw.meta,
                    usage,
                } satisfies NormalizedMessage;
            }
            // Task lifecycle events (including canonical turn terminal markers)
            // are status/metrics - skip normalization, they don't need UI rendering
        }
    }
    // Status/metrics and unknown future presentation records have no visible transcript row.
    return null;
}

export function normalizeRawMessage(
    id: string,
    localId: string | null,
    createdAt: number,
    rawInput: unknown,
    opts?: RawMessageNormalizationOptions,
): NormalizedMessage | null {
    let normalized = normalizeRawMessageFromRaw(id, localId, createdAt, rawInput, opts);
    // Resolve before the raw schema strips provider-only fields (including Codex's role).
    const rawContent = isPlainRecord(rawInput) && isPlainRecord(rawInput.content) ? rawInput.content : null;
    if (normalized?.role === 'agent' && rawContent && (rawContent.type === 'acp' || rawContent.type === 'codex')) {
        const bodyRole = resolveTranscriptBodySessionMessageRole({ protocol: rawContent.type, body: rawContent.data });
        if (bodyRole === 'user') {
            normalized = {
                ...normalized,
                role: 'user',
                content: {
                    type: 'text',
                    text: normalized.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n'),
                },
            };
        }
    }
    const explicitSidechainId = normalizeExplicitSidechainId(opts?.sidechainId);

    // The public external item owns its validated sidechain identity. Provider raw data remains
    // a legacy fallback only when that explicit carrier is absent.
    if (explicitSidechainId && normalized) {
        normalized = { ...normalized, sidechainId: explicitSidechainId, isSidechain: true };
    }
    const storedOrigin = normalized?.meta?.forkVisualOriginV1;
    if (storedOrigin === undefined || normalized?.role !== 'agent') return normalized;
    const origin = SessionForkVisualOriginV1Schema.safeParse(storedOrigin);
    if (!origin.success) return normalized;
    // Native tool ids are Session-local. Only the projection is scoped; the
    // provider-native stored body and original id remain unchanged for replay.
    const scope = (toolId: string) => JSON.stringify(['forkVisualOriginV1', origin.data.serverId, origin.data.sessionId, toolId]);
    return {
        ...normalized,
        ...(normalized.sidechainId ? { sidechainId: scope(normalized.sidechainId) } : {}),
        content: normalized.content.map(content => content.type === 'tool-call'
            ? { ...content, sourceToolId: content.id, id: scope(content.id) }
            : content.type === 'tool-result'
                ? { ...content, sourceToolId: content.tool_use_id, tool_use_id: scope(content.tool_use_id) }
                : content),
    };
}
