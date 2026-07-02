import { classifyOpenCodePartForProjection } from './part.js';
import type { OpenCodeTranscriptProjectionContext } from './types.js';

export function extractOpenCodeProjectedText(
  parts: unknown[],
  opts: Readonly<{ context: Extract<OpenCodeTranscriptProjectionContext, 'history_import' | 'direct_transcript'> }>,
): string {
  if (!Array.isArray(parts)) return '';

  const chunks: string[] = [];
  for (const part of parts) {
    const projection = classifyOpenCodePartForProjection(part, opts);
    if (projection.kind !== 'transcript_text' || !projection.text) continue;
    chunks.push(projection.text);
  }
  return chunks.join('').trim();
}
