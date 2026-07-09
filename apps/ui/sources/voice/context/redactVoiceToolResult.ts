import { redactVoicePathLikeData } from '@/voice/shared/redactVoicePathLikeData';

/**
 * Privacy preferences that gate what voice tool-result detail is allowed to cross the provider
 * boundary (the `VOICE_TOOL_RESULTS_JSON` follow-up channel). This is the single owner of
 * provider-bound tool-result redaction: every tool result — regardless of which `tools/actionImpl`
 * leaf produced it — is routed through {@link redactVoiceToolResultValue} before it reaches the
 * model, so session summaries, file paths, and pending permission state are gated consistently.
 */
export type VoiceToolResultRedactionPrefs = Readonly<{
  shareFilePaths: boolean;
  shareSessionSummary: boolean;
  sharePermissionRequests: boolean;
}>;

/**
 * Session reference objects (`{ id, title, locationLabel, serverId, serverName }`) carry the session
 * `title`, which is the session SUMMARY text. When summary sharing is disabled those titles must not
 * reach the provider. The human-summary resolver treats `title ?? label ?? name` as equivalent
 * session-summary text, so the raw-channel key-set mirrors that title-equivalent set — otherwise a
 * tool result carrying a session under a `label`/`name` key would survive `shareSessionSummary=false`
 * on the raw `VOICE_TOOL_RESULTS_JSON` channel (X-L2).
 */
const SESSION_SUMMARY_KEYS: ReadonlySet<string> = new Set(['title', 'label', 'name']);

/**
 * `locationLabel` is a repo/workspace path tail. Path-bearing string values elsewhere are handled by
 * {@link redactVoicePathLikeData}, but the label key itself can hold a non-path workspace alias, so
 * it is dropped wholesale when path sharing is disabled (mirrors the `listSessions` tool gating).
 */
const FILE_PATH_KEYS: ReadonlySet<string> = new Set(['locationLabel']);

/**
 * Pending permission-request identifiers/state surfaced by the session-activity tool.
 */
const PERMISSION_REQUEST_KEYS: ReadonlySet<string> = new Set(['permissionRequestIds']);

function shouldDropKey(key: string, prefs: VoiceToolResultRedactionPrefs): boolean {
  if (!prefs.shareSessionSummary && SESSION_SUMMARY_KEYS.has(key)) return true;
  if (!prefs.shareFilePaths && FILE_PATH_KEYS.has(key)) return true;
  if (!prefs.sharePermissionRequests && PERMISSION_REQUEST_KEYS.has(key)) return true;
  return false;
}

function stripGatedKeys(value: unknown, prefs: VoiceToolResultRedactionPrefs, depth: number): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => stripGatedKeys(entry, prefs, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (shouldDropKey(key, prefs)) continue;
    output[key] = stripGatedKeys(entry, prefs, depth + 1);
  }
  return output;
}

/**
 * Redact a voice tool-result (or argument) value for the provider boundary. Strips session
 * summaries and pending permission identifiers per the supplied prefs, then delegates path-like
 * string/key redaction to the canonical {@link redactVoicePathLikeData} owner. This is the only
 * redaction applied to provider-bound tool results — no per-tool redaction path should exist.
 */
export function redactVoiceToolResultValue(value: unknown, prefs: VoiceToolResultRedactionPrefs): unknown {
  const stripped = stripGatedKeys(value, prefs, 0);
  return prefs.shareFilePaths ? stripped : redactVoicePathLikeData(stripped);
}
