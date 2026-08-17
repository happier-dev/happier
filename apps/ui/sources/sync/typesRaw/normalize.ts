import {
    hasCanonicalTurnDiffEvidence,
    isCanonicalTurnDiffPayload,
    readEmptyCanonicalTurnDiffToolCallId,
    shouldSuppressEmptyCanonicalTurnDiffToolCall,
    type MessageStructuredPresentationV1,
    type SessionMessageRole,
} from '@happier-dev/protocol';

import type { MessageMeta } from '../domains/messages/messageMetaTypes';
import { markUnsupportedContentMeta } from '../domains/messages/unsupportedContentMeta';
import type { TranscriptObservationMetadata } from '../domains/messages/transcriptObservationProvenance';
import {
    hasSyntheticNoResponseMeta,
    markSyntheticNoResponseMeta,
    SYNTHETIC_NO_RESPONSE_TEXT,
} from '../domains/messages/syntheticNoResponseMessageMeta';
import { rawRecordSchema, type AgentEvent, type RawAgentContent, type RawRecord, type UsageData } from './schemas';
import { extractUsageDataFromTokenCountRecord } from './tokenCountUsage';

// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
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
} & TranscriptObservationMetadata;

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

export type RawMessageNormalizationSequenceState = {
    suppressedEmptyCanonicalTurnDiffCallIds: Set<string>;
};

const RAW_MESSAGE_NORMALIZATION_SUPPRESSED_EMPTY_DIFF_CALL_ID_MAX = 256;

type ContextCompactionAgentEvent = Extract<AgentEvent, { type: 'context-compaction' }>;

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
    return {
        suppressedEmptyCanonicalTurnDiffCallIds: new Set<string>(),
    };
}

function rememberSuppressedEmptyCanonicalTurnDiffCallId(
    state: RawMessageNormalizationSequenceState,
    callId: string,
): void {
    const callIds = state.suppressedEmptyCanonicalTurnDiffCallIds;
    if (callIds.has(callId)) {
        callIds.delete(callId);
    }
    while (callIds.size >= RAW_MESSAGE_NORMALIZATION_SUPPRESSED_EMPTY_DIFF_CALL_ID_MAX) {
        const oldest = callIds.keys().next().value;
        if (typeof oldest !== 'string') break;
        callIds.delete(oldest);
    }
    callIds.add(callId);
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
        const isKnownSuppressedResult = suppressedEmptyCanonicalTurnDiffCallIds.has(item.tool_use_id);
        const isCanonicalTurnDiffResult = isCanonicalTurnDiffPayload(item.content);
        if (!isKnownSuppressedResult && !isCanonicalTurnDiffResult) return true;
        if (isKnownSuppressedResult) matchedCallIds.add(item.tool_use_id);
        const shouldFilter = !hasCanonicalTurnDiffEvidence(item.content);
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
        // Never log full raw messages in production: tool outputs and user text may contain secrets.
        // Keep enough context for debugging in dev builds only.
        console.error(`[typesRaw] Message validation failed (id=${id})`);
        if (__DEV__) {
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
        const unsafeRole = (rawInput as any)?.role;
        const role = unsafeRole === 'user' ? 'user' : 'agent';
        const text =
            role === 'user'
                ? '[Unparsed user message]'
                : '[Unparsed agent message]';
        return role === 'user'
            ? {
                id,
                ...(seq !== undefined ? { seq } : {}),
                localId,
                createdAt,
                role: 'user',
                ...(sidechainId ? { sidechainId } : {}),
                isSidechain: Boolean(sidechainId),
                content: { type: 'text', text },
                meta: markUnsupportedContentMeta((rawInput as any)?.meta as MessageMeta | undefined, 'unparsed-user-message'),
            }
            : {
                id,
                ...(seq !== undefined ? { seq } : {}),
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text, uuid: id, parentUUID: null }],
                meta: markUnsupportedContentMeta((rawInput as any)?.meta as MessageMeta | undefined, 'unparsed-agent-message'),
            };
    }
    const raw = parsed.data as RawRecord;

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
            // Skip Meta messages
            if (raw.content.data.isMeta) {
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

            // Progress records are transport-level status updates and are not rendered in transcript.
            if (raw.content.data.type === 'progress' || raw.content.data.type === 'tool_progress') {
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
                    if (isClaudeTaskNotificationText(raw.content.data.message.content)) {
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
	                                is_error: c.is_error || false,
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
            // Any other output payload should be surfaced as an opaque message rather than dropped.
            // Name the payload type: agent CLIs keep adding record types, and an unnamed placeholder
            // leaves nothing to grep for when one starts leaking into transcripts.
            const unsupportedType = (raw.content.data as { type?: unknown }).type;
            const unsupportedLabel = typeof unsupportedType === 'string' && unsupportedType.length > 0
                ? `[Unsupported agent output: ${unsupportedType}]`
                : '[Unsupported agent output]';
            return filterNormalizedEventRoleOutput({
                id,
                ...(seq !== undefined ? { seq } : {}),
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: unsupportedLabel,
                    uuid: id,
                    parentUUID: null,
                }],
                meta: markUnsupportedContentMeta(raw.meta, 'unsupported-agent-output'),
            }, opts?.messageRole);
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
                        uuid: raw.content.data.id,
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
                        uuid: raw.content.data.id,
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
    // Default: never drop unknown/unsupported records silently. Surface an opaque placeholder instead,
    // except for explicit status/metrics events we intentionally hide.
    if (raw.role === 'agent') {
        const contentType = raw.content.type;
        if (contentType === 'codex' || contentType === 'acp') {
            const dataType = (raw.content as any).data?.type;
            if (
                dataType === 'task_started'
                || dataType === 'task_complete'
                || dataType === 'turn_failed'
                || dataType === 'turn_cancelled'
                || dataType === 'turn_aborted'
                // Claude SDK per-turn usage/cost summary (source
                // 'claude-agent-sdk-result-usage'): transport-level metrics that
                // feed the usage pipeline, not a visible transcript row. The
                // human-readable result text is a separate 'message' record.
                || dataType === 'result'
            ) {
                return null;
            }
        }
    }
    return {
        id,
        ...(seq !== undefined ? { seq } : {}),
        localId,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'text',
            text: '[Unsupported transcript record]',
            uuid: id,
            parentUUID: null,
        }],
        meta: markUnsupportedContentMeta((raw as any)?.meta, 'unsupported-transcript-record'),
    };
}

export function normalizeRawMessage(
    id: string,
    localId: string | null,
    createdAt: number,
    rawInput: unknown,
    opts?: RawMessageNormalizationOptions,
): NormalizedMessage | null {
    const normalized = normalizeRawMessageFromRaw(id, localId, createdAt, rawInput, opts);
    const explicitSidechainId = normalizeExplicitSidechainId(opts?.sidechainId);

    // The public external item owns its validated sidechain identity. Provider raw data remains
    // a legacy fallback only when that explicit carrier is absent.
    if (!explicitSidechainId || !normalized) return normalized;
    return {
        ...normalized,
        sidechainId: explicitSidechainId,
        isSidechain: true,
    };
}
