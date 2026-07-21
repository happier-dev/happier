/**
 * Known internal Claude Code / Claude Agent SDK event types that should be skipped.
 *
 * These records are telemetry or internal state transitions, not conversation messages.
 * Keeping them out of Happier transcripts avoids confusing "[Unsupported agent output]" rows.
 *
 * `attachment` records carry context injections (hook output, reminders, tool/skill listings,
 * file snapshots) rather than conversation content, so they belong here too.
 */
export const INTERNAL_CLAUDE_EVENT_TYPES = new Set<string>([
  'file-history-snapshot',
  'change',
  'queue-operation',
  'rate_limit_event',
  'attachment',
  'last-prompt',
  'mode',
  'pr-link',
]);

