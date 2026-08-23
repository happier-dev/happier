export const INTERNAL_CLAUDE_EVENT_TYPES = new Set<string>([
    'file-history-snapshot',
    'change',
    'queue-operation',
    'rate_limit_event',
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
 * past one is complete rather than lossy. Keep this list closed: a Claude
 * release that starts writing conversation content under a new type must fail
 * closed here rather than be skipped silently.
 */
export const CLAUDE_NON_TRANSCRIPT_RECORD_TYPES = new Set<string>([
    ...INTERNAL_CLAUDE_EVENT_TYPES,
    'agent-setting',
    'ai-title',
    'attachment',
    'bridge-session',
    'control_request',
    'control_response',
    'event',
    'last-prompt',
    'mode',
    'permission-mode',
    'progress',
    'result',
    'summary',
    'system',
]);
