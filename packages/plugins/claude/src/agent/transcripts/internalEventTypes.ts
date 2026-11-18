export const INTERNAL_CLAUDE_EVENT_TYPES = new Set<string>([
    'file-history-snapshot',
    'change',
    'queue-operation',
    'rate_limit_event',
    'attachment',
    'last-prompt',
    'mode',
    'pr-link',
    'tool_progress',
    // Claude Agent SDK 0.3.206+: per-command queue/execution state, not conversation output.
    'command_lifecycle',
]);

/**
 * Claude-native JSONL record types the pinned CLI durably writes beside the
 * conversation and that carry no recipient-facing transcript row. Advancing
 * past one of these is complete, not lossy; every other unmapped record is an
 * unsupported record whose loss must be reported instead of hidden.
 *
 * Basis: record types observed across the local `~/.claude/projects` corpus
 * (`system`, `result`, `attachment`, `queue-operation`, `last-prompt`,
 * `control_request`, `control_response`, `event`, `permission-mode`, `mode`,
 * `progress`, `file-history-snapshot`, `agent-setting`, `ai-title`,
 * `bridge-session`) plus `summary`, which the raw JSONL schema already
 * ratifies. `agent-setting`, `ai-title`, and `bridge-session` are session
 * bookkeeping envelopes — an agent setting, the generated session title, and
 * bridge sequence state — that carry no message body, so a page that advances
 * past one is complete rather than lossy. Keep this bookkeeping list explicit:
 * new or malformed native records produce a visible unsupported-content row
 * and safe diagnostic so transcripts stay readable across Claude CLI releases.
 * Only actual source loss, such as replacement or an unread boundary, is a
 * discontinuity; an unknown record must never be skipped silently.
 */
export const CLAUDE_NON_TRANSCRIPT_RECORD_TYPES = new Set<string>([
    ...INTERNAL_CLAUDE_EVENT_TYPES,
    'agent-setting',
    'ai-title',
    'custom-title',
    'bridge-session',
    // Observed native 2026-10-15: persisted cost counters and ATIS latch state,
    // neither of which contains a recipient-facing conversation message.
    'cost-state',
    'atis-latch',
    // Native tool-name accounting carries no conversation content.
    'tools-used',
    // Claude 2.1.302 API input bookkeeping, observed in c11's native JSONL.
    // Blobs may repeat prior prompts; none of these records is new conversation.
    'api-request-shape',
    'api-request-blob',
    'api-request',
    'control_request',
    'control_response',
    'event',
    'permission-mode',
    'progress',
    'result',
    'summary',
    'system',
]);

/** Transcript-only exclusions; raw lifecycle observers still receive these events. */
export function isClaudeInternalEventType(type: unknown): boolean {
    return typeof type === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(type);
}
