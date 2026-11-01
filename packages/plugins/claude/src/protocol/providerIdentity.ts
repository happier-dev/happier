/**
 * Exact-value presence reader for identity bytes Claude minted.
 *
 * Claude owns its session ids, turn ids, tool-call ids and transcript uuids.
 * Happier hands those bytes straight back to the provider (`--resume`), uses
 * them to name transcript files, and compares them to decide which live session
 * a statusline payload, a session hook or a JSONL row belongs to. Presence is
 * therefore the only question Happier may answer about such a value: a reader
 * that trims turns `"  id  "` into a DIFFERENT id, which resumes the wrong
 * conversation, resolves a sibling's transcript, or makes a foreign payload
 * compare equal to the live session. Rejecting a blank value is fail-closed;
 * rewriting a present one is not.
 *
 * Happier-owned values — its own session/turn ids, filesystem paths, labels,
 * modes and display strings — keep their canonicalizing readers; the trimming
 * counterpart is `readClaudeRuntimeString` in
 * `agent/runtime/shared/runtimeHelpers.ts`.
 *
 * Package-private on purpose: this is not a Plugin SDK contract, and the plugin
 * runtime cannot import Protocol.
 */
export function hasClaudeProviderIdentityValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readClaudeProviderIdentityValue(value: unknown): string | null {
  return hasClaudeProviderIdentityValue(value) ? value : null;
}

/** Native JSONL owns its conversation id; an embedded SDK id can survive /clear. */
export function readClaudeTranscriptProviderSessionId(row: Readonly<Record<string, unknown>>): string | null {
  return readClaudeProviderIdentityValue(row.sessionId) ?? readClaudeProviderIdentityValue(row.session_id);
}
