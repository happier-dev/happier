/**
 * xAI's provider-local JSON output-audio spelling normalization.
 *
 * The current Speech-to-Speech Audio Transport contract permits both
 * `response.output_audio.delta` and `response.audio.delta` for JSON output.
 * Normalize only that documented delta alias here; response completion keeps
 * its documented `response.output_audio.done` spelling.
 */
export function normalizeXaiRealtimeEventType(type: string): string {
  return type === 'response.audio.delta' ? 'response.output_audio.delta' : type;
}
