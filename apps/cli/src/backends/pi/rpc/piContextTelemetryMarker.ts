import { PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from '../bridgeExtension/piBridgeExtensionEnv';

/**
 * Parser for the context-telemetry stderr markers emitted by the Happier Pi tools-bridge
 * extension. One JSON object per line:
 *   {"type":"happy-pi-token-count","used":<tokens>,"size":<contextWindowTokens>}
 *
 * `used` is pi's live estimated context tokens (post-compaction it is null on the
 * extension side and the marker is simply not emitted); `size` is the model's context
 * window. These map onto `context_used_tokens` / `context_window_tokens` in the
 * token_count agent message the backend publishes after each turn.
 */

export interface PiContextTelemetry {
  used: number;
  size: number;
}

function asFiniteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** Returns parsed telemetry when the line is a well-formed bridge marker, else null. */
export function parsePiContextTelemetryMarkerLine(line: string): PiContextTelemetry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record.type !== PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE) return null;

  const used = asFiniteNonNegativeInteger(record.used);
  const size = asFiniteNonNegativeInteger(record.size);
  if (used === null || used <= 0 || size === null || size <= 0) return null;
  return { used, size };
}

/**
 * Merge context telemetry into a token_count `tokens` map (mutating the given map).
 * Keys match what the UI's token-count usage extraction reads
 * (`context_used_tokens`, `context_window_tokens`).
 */
export function mergePiContextTelemetryIntoTokens(
  tokens: Record<string, number>,
  telemetry: PiContextTelemetry,
): Record<string, number> {
  tokens.context_used_tokens = telemetry.used;
  tokens.context_window_tokens = telemetry.size;
  return tokens;
}

/**
 * Dedupe-key suffix for context telemetry so a changed live-context value re-publishes the
 * token_count even when the session's assistant-message counter (the other key component)
 * has not advanced (e.g. compaction, retries).
 */
export function buildPiContextTelemetryKeySuffix(telemetry: PiContextTelemetry): string {
  return `:ctx${telemetry.used}/${telemetry.size}`;
}

/**
 * Read Pi's live context telemetry from `get_session_stats` response data
 * (`stats.contextUsage`: the same estimate pi uses for compaction and its footer).
 * Returns null when absent or incomplete (e.g. `tokens` is null right after compaction).
 */
export function parsePiContextTelemetryFromSessionStats(stats: unknown): PiContextTelemetry | null {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  const contextUsage = (stats as Record<string, unknown>).contextUsage;
  if (!contextUsage || typeof contextUsage !== 'object' || Array.isArray(contextUsage)) return null;

  const record = contextUsage as Record<string, unknown>;
  const used = asFiniteNonNegativeInteger(record.tokens);
  const size = asFiniteNonNegativeInteger(record.contextWindow);
  if (used === null || used <= 0 || size === null || size <= 0) return null;
  return { used, size };
}
