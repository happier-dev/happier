/**
 * Known internal Claude Code / Claude Agent SDK event types that should be skipped.
 *
 * These records are telemetry or internal state transitions, not conversation messages.
 * Keeping them out of Happier transcripts avoids confusing "[Unsupported agent output]" rows.
 */
export const INTERNAL_CLAUDE_EVENT_TYPES = new Set<string>([
  'file-history-snapshot',
  'change',
  'queue-operation',
  'rate_limit_event',
]);

