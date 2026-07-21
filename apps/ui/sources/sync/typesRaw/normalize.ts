import type { SessionMessageRole } from '@happier-dev/protocol';

import type { MessageMeta } from '../domains/messages/messageMetaTypes';
import {
    hasSyntheticNoResponseMeta,
    markSyntheticNoResponseMeta,
    SYNTHETIC_NO_RESPONSE_TEXT,
} from '../domains/messages/syntheticNoResponseMessageMeta';
import { hasSessionMediaRenderItems } from '../domains/sessionMedia/sessionMediaMessageMeta';
import { rawRecordSchema, type AgentEvent, type RawAgentContent, type RawRecord, type UsageData } from './schemas';
import { buildUsageDataFromTokenCountMessage } from './tokenCountUsage';

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

type ContextCompactionPhase = 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
type ContextCompactionSource =
    | 'provider-event'
    | 'provider-status'
    | 'provider-hook'
    | 'transcript-inference'
    | 'user-command'
    | 'runtime';
type ContextCompactionTrigger = 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
type ContextCompactionContinuation = 'paused';
type ContextCompactionPauseReason = 'provider-idle-after-compaction';
type ContextCompactionAgentEvent = Extract<AgentEvent, { type: 'context-compaction' }>;

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
};

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstMessageText(value: unknown): string | null {
    if (!isPlainRecord(value)) return null;
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    const message = value.message;
    if (!isPlainRecord(message)) return null;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    for (const item of content) {
        if (!isPlainRecord(item)) continue;
        if (typeof item.text === 'string') return item.text;
    }
    return null;
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
        content.type === 'thinking' ||
        content.type === 'tool-call' ||
        content.type === 'tool-result'
    );
}

function filterNormalizedEventRoleOutput(
    message: NormalizedMessage,
    messageRole: SessionMessageRole | null | undefined,
): NormalizedMessage | null {
    return shouldKeepNormalizedEventRoleOutput(message, messageRole) ? message : null;
}

function isCompactHookLocalCommandStdoutText(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('<local-command-stdout>')) return false;
    return /\b(?:PreCompact|PostCompact)\b/.test(trimmed);
}

function isCompactHookLocalCommandStdout(value: unknown): boolean {
    return isCompactHookLocalCommandStdoutText(firstMessageText(value));
}

function isClaudeLocalCommandText(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.startsWith('<local-command-caveat>')) return true;
    if (trimmed.includes('<command-name>/compact</command-name>')) return true;
    return isCompactHookLocalCommandStdoutText(trimmed);
}

function isClaudeLocalCommandTranscriptValue(value: unknown): boolean {
    return isClaudeLocalCommandText(firstMessageText(value));
}

function readOriginalStructuredContentData(rawInput: unknown, contentType: 'event' | 'acp'): Record<string, unknown> | null {
    if (!isPlainRecord(rawInput)) return null;
    const content = rawInput.content;
    if (!isPlainRecord(content) || content.type !== contentType) return null;
    return isPlainRecord(content.data) ? content.data : null;
}

function normalizeContextCompactionPhase(value: unknown): {
    phase: ContextCompactionPhase;
    legacyDetected: boolean;
} {
    if (value === 'started' || value === 'progress' || value === 'completed' || value === 'failed' || value === 'cancelled') {
        return { phase: value, legacyDetected: false };
    }
    if (value === 'detected') {
        return { phase: 'completed', legacyDetected: true };
    }
    return { phase: 'completed', legacyDetected: false };
}

function normalizeContextCompactionSource(value: unknown, fallback: ContextCompactionSource | undefined): ContextCompactionSource | undefined {
    if (
        value === 'provider-event' ||
        value === 'provider-status' ||
        value === 'provider-hook' ||
        value === 'transcript-inference' ||
        value === 'user-command' ||
        value === 'runtime'
    ) {
        return value;
    }
    return fallback;
}

function normalizeContextCompactionTrigger(value: unknown): ContextCompactionTrigger | undefined {
    return value === 'manual' || value === 'auto' || value === 'threshold' || value === 'overflow' || value === 'unknown'
        ? value
        : undefined;
}

function normalizeContextCompactionContinuation(value: unknown): ContextCompactionContinuation | undefined {
    return value === 'paused' ? value : undefined;
}

function normalizeContextCompactionPauseReason(value: unknown): ContextCompactionPauseReason | undefined {
    return value === 'provider-idle-after-compaction' ? value : undefined;
}

function normalizeContextCompactionEventData(
    value: Record<string, unknown>,
    providerFallback?: string,
): AgentEvent {
    const phaseResult = normalizeContextCompactionPhase(value.phase);
    const source = normalizeContextCompactionSource(
        value.source,
        phaseResult.legacyDetected ? 'transcript-inference' : undefined,
    );
    const provider = readNonEmptyString(value.provider) ?? readNonEmptyString(providerFallback);
    const tokenCountBefore = readFiniteNumber(value.tokenCountBefore) ?? readFiniteNumber(value.tokensBefore);
    const tokenCountAfter = readFiniteNumber(value.tokenCountAfter) ?? readFiniteNumber(value.tokensAfter);
    const retryAttempt = readFiniteNumber(value.retryAttempt);
    const event: ContextCompactionAgentEvent = {
        type: 'context-compaction',
        phase: phaseResult.phase,
    };

    if (provider) event.provider = provider;
    const lifecycleId = readNonEmptyString(value.lifecycleId);
    if (lifecycleId) event.lifecycleId = lifecycleId;
    const backendId = readNonEmptyString(value.backendId);
    if (backendId) event.backendId = backendId;
    const agentId = readNonEmptyString(value.agentId);
    if (agentId) event.agentId = agentId;
    const trigger = normalizeContextCompactionTrigger(value.trigger);
    if (trigger) event.trigger = trigger;
    if (source) event.source = source;
    const providerEventId = readNonEmptyString(value.providerEventId);
    if (providerEventId) event.providerEventId = providerEventId;
    const providerSessionId = readNonEmptyString(value.providerSessionId);
    if (providerSessionId) event.providerSessionId = providerSessionId;
    const turnId = readNonEmptyString(value.turnId);
    if (turnId) event.turnId = turnId;
    if (tokenCountBefore !== undefined) event.tokenCountBefore = tokenCountBefore;
    if (tokenCountAfter !== undefined) event.tokenCountAfter = tokenCountAfter;
    const tokenCountSource = readNonEmptyString(value.tokenCountSource);
    if (tokenCountSource) event.tokenCountSource = tokenCountSource;
    if (retryAttempt !== undefined) event.retryAttempt = Math.max(0, Math.trunc(retryAttempt));
    const errorCode = readNonEmptyString(value.errorCode);
    if (errorCode) event.errorCode = errorCode;
    const sanitizedErrorPreview = readNonEmptyString(value.sanitizedErrorPreview) ?? readNonEmptyString(value.errorMessage);
    if (sanitizedErrorPreview) event.sanitizedErrorPreview = sanitizedErrorPreview;
    const continuation = normalizeContextCompactionContinuation(value.continuation);
    if (continuation) event.continuation = continuation;
    const pauseReason = normalizeContextCompactionPauseReason(value.pauseReason);
    if (pauseReason) event.pauseReason = pauseReason;

    return event;
}

export function normalizeRawMessage(
    id: string,
    localId: string | null,
    createdAt: number,
    rawInput: unknown,
    opts?: Readonly<{ seq?: number; messageRole?: SessionMessageRole | null }>,
): NormalizedMessage | null {
    const seq = typeof opts?.seq === 'number' && Number.isFinite(opts.seq) ? Math.trunc(opts.seq) : undefined;

    // Zod transform handles normalization during validation
    const parsed = rawRecordSchema.safeParse(rawInput);
    if (!parsed.success) {
        // Never log full raw messages in production: tool outputs and user text may contain secrets.
        // Keep enough context for debugging in dev builds only.
        console.error(`[typesRaw] Message validation failed (id=${id})`);
        const rawInputRecord = isPlainRecord(rawInput) ? rawInput : null;
        const rawContentRecord = isPlainRecord(rawInputRecord?.content) ? rawInputRecord.content : null;
        const rawDataRecord = isPlainRecord(rawContentRecord?.data) ? rawContentRecord.data : null;
        if (__DEV__) {
            const contentType = rawContentRecord?.type;
            const dataType = rawDataRecord?.type;
            const provider = rawContentRecord?.provider;
            const toolName =
                contentType === 'codex'
                    ? rawDataRecord?.name
                    : contentType === 'acp'
                        ? rawDataRecord?.name
                        : null;
            const callId =
                contentType === 'codex'
                    ? rawDataRecord?.callId
                    : contentType === 'acp'
                        ? rawDataRecord?.callId
                        : null;

            console.error('Zod issues:', JSON.stringify(parsed.error.issues, null, 2));
            console.error('Raw summary:', {
                role: rawInputRecord?.role,
                contentType,
                dataType,
                provider,
                toolName: typeof toolName === 'string' ? toolName : undefined,
                callId: typeof callId === 'string' ? callId : undefined,
            });
        }
        const unsafeRole = rawInputRecord?.role;
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
                isSidechain: false,
                content: { type: 'text', text },
                meta: rawInputRecord?.meta as MessageMeta | undefined,
            }
            : {
                id,
                ...(seq !== undefined ? { seq } : {}),
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text, uuid: id, parentUUID: null }],
                meta: rawInputRecord?.meta as MessageMeta | undefined,
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
        if (isClaudeLocalCommandTranscriptValue(raw.content)) {
            return null;
        }
        return {
            id,
            ...(seq !== undefined ? { seq } : {}),
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
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

            if (isClaudeLocalCommandTranscriptValue(raw.content.data)) {
                return null;
            }

            if ((raw.content.data as { type?: unknown }).type === 'claude_jsonl_consumed_marker') {
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
                    if (content.length === 0 && hasSessionMediaRenderItems(raw.meta)) {
                        content.push({
                            type: 'text',
                            text: '',
                            uuid: outputUuid,
                            parentUUID: raw.content.data.parentUuid ?? null,
                        });
                    }
                    const sidechainId = metaSidechainId ?? getOutputSidechainId(raw.content.data) ?? claudeParentToolUseId;
                    const legacyIsSidechain = getOutputIsSidechain(raw.content.data);
	                  const normalized = {
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
	                  } satisfies NormalizedMessage;
                    return filterNormalizedEventRoleOutput(normalized, opts?.messageRole);
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
	                      const normalized = {
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
	                    } satisfies NormalizedMessage;
                    return filterNormalizedEventRoleOutput(normalized, opts?.messageRole);
	                }

                // Handle regular user messages
                if (raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    if (isClaudeTaskNotificationText(raw.content.data.message.content)) {
                        return null;
                    }
                    const normalized = {
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
                    } satisfies NormalizedMessage;
                    return filterNormalizedEventRoleOutput(normalized, opts?.messageRole);
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
                  const normalized = {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      sidechainId,
                      isSidechain,
                    content,
                    meta: raw.meta
                } satisfies NormalizedMessage;
                return filterNormalizedEventRoleOutput(normalized, opts?.messageRole);
            }
            // Any other output payload should be surfaced as an opaque message rather than dropped.
            // Name the payload type: agent CLIs keep adding record types, and an unnamed placeholder
            // leaves nothing to grep for when one starts leaking into transcripts.
            const unsupportedType = (raw.content.data as { type?: unknown }).type;
            const unsupportedLabel = typeof unsupportedType === 'string' && unsupportedType.length > 0
                ? `[Unsupported agent output: ${unsupportedType}]`
                : '[Unsupported agent output]';
            const normalized = {
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
                meta: raw.meta,
            } satisfies NormalizedMessage;
            return filterNormalizedEventRoleOutput(normalized, opts?.messageRole);
        }
          if (raw.content.type === 'event') {
              const originalEventData = readOriginalStructuredContentData(rawInput, 'event');
              const content = raw.content.data.type === 'context-compaction'
                  ? normalizeContextCompactionEventData({
                      ...(raw.content.data as unknown as Record<string, unknown>),
                      ...(originalEventData ?? {}),
                  })
                  : raw.content.data;
              return {
                  id,
                  ...(seq !== undefined ? { seq } : {}),
                  localId,
                  createdAt,
                  role: 'event',
                  content,
                  isSidechain: false,
            };
        }
        if (raw.content.type === 'codex') {
            const structuredSidechain = resolveStructuredContentSidechain(raw.content.data);
              if (raw.content.data.type === 'token_count') {
                  const usage = buildUsageDataFromTokenCountMessage(raw.content.data);
                  if (!usage) return null;
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [],
                    usage,
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
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
                        name: raw.content.data.name || 'unknown',
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
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
        }
          // ACP (Agent Communication Protocol) - unified format for all agent providers
          if (raw.content.type === 'acp') {
              const structuredSidechain = resolveStructuredContentSidechain(raw.content.data);
              const acpDataRecord = raw.content.data as unknown as Record<string, unknown>;
              if (raw.content.data.type === 'context-compaction') {
                  const originalAcpDataRecord = readOriginalStructuredContentData(rawInput, 'acp');
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'event',
                      isSidechain: false,
                      content: normalizeContextCompactionEventData({
                          ...acpDataRecord,
                          ...(originalAcpDataRecord ?? {}),
                      }, raw.content.provider),
                      meta: raw.meta,
                  } satisfies NormalizedMessage;
              }
              if (raw.content.data.type === 'token_count') {
                  const usage = buildUsageDataFromTokenCountMessage(acpDataRecord);
                  if (!usage) return null;
                  return {
                      id,
                      ...(seq !== undefined ? { seq } : {}),
                      localId,
                      createdAt,
                      role: 'agent',
                      isSidechain: structuredSidechain.isSidechain,
                    ...(structuredSidechain.sidechainId ? { sidechainId: structuredSidechain.sidechainId } : {}),
                    content: [],
                    usage,
                    meta: raw.meta
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
                        name: typeof acpDataRecord.name === 'string' ? acpDataRecord.name : 'unknown',
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
            // Task lifecycle events are status/metrics - skip normalization, they don't need UI rendering
        }
    }
    // Default: never drop unknown/unsupported records silently. Surface an opaque placeholder instead,
    // except for explicit status/metrics events we intentionally hide.
    if (raw.role === 'agent') {
        const contentType = raw.content.type;
        if (contentType === 'codex' || contentType === 'acp') {
            const dataType = (raw.content as any).data?.type;
            if (
                dataType === 'token_count'
                || dataType === 'task_started'
                || dataType === 'task_complete'
                || dataType === 'turn_failed'
                || dataType === 'turn_cancelled'
                || dataType === 'turn_aborted'
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
        meta: (raw as any)?.meta,
    };
}
