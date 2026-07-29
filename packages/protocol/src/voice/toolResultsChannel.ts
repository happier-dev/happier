export const VOICE_TOOL_RESULTS_JSON_PREFIX = 'VOICE_TOOL_RESULTS_JSON:' as const;
export const VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX = 'VOICE_TOOL_RESULT_INSTRUCTIONS:' as const;

/**
 * Formats the provider-facing JSON segment of a local voice tool-result follow-up.
 * Additional instruction-channel lines, when needed, are appended by the caller.
 */
export function formatVoiceToolResultsFollowUp(payload: unknown): string {
  return `${VOICE_TOOL_RESULTS_JSON_PREFIX}\n${JSON.stringify(payload)}`;
}

/**
 * Parses the canonical one-line JSON segment and ignores later channel lines.
 * Non-channel or malformed input fails closed instead of being treated as user speech.
 */
export function parseVoiceToolResultsFollowUp(text: unknown): unknown | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(VOICE_TOOL_RESULTS_JSON_PREFIX)) return null;

  const remainder = trimmed.slice(VOICE_TOOL_RESULTS_JSON_PREFIX.length).trimStart();
  const lineEnd = remainder.indexOf('\n');
  const jsonText = (lineEnd >= 0 ? remainder.slice(0, lineEnd) : remainder).trim();
  if (jsonText.length === 0) return null;

  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
}
