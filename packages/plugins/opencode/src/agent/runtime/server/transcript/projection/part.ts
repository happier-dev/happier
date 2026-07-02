import {
  asOpenCodeProjectionRecord,
  hasOpenCodeInternalFlag,
  normalizeOpenCodeProjectionLowerString,
  normalizeOpenCodeProjectionString,
} from './parsing.js';
import type {
  OpenCodePartProjection,
  OpenCodeTranscriptProjectionContext,
} from './types.js';

const TRANSCRIPT_PART_TYPES = new Set(['text', 'step']);

function extractNestedProjectionText(
  value: unknown,
  opts: Readonly<{ context: OpenCodeTranscriptProjectionContext }>,
): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  const chunks: string[] = [];
  for (const entry of value) {
    const projection = classifyOpenCodePartForProjection(entry, opts);
    if (projection.kind !== 'transcript_text' || !projection.text) continue;
    chunks.push(projection.text);
  }
  return chunks.join('');
}

export function classifyOpenCodePartForProjection(
  part: unknown,
  opts: Readonly<{ context: OpenCodeTranscriptProjectionContext }>,
): OpenCodePartProjection {
  const record = asOpenCodeProjectionRecord(part);
  if (!record) return { kind: 'non_transcript', text: '', partType: '' };

  const partType = normalizeOpenCodeProjectionLowerString(record.type);

  if (hasOpenCodeInternalFlag(record)) {
    return { kind: 'ignored_internal', text: '', partType };
  }

  const text = normalizeOpenCodeProjectionString(record.text)
    || extractNestedProjectionText(record.content, opts)
    || extractNestedProjectionText(record.parts, opts);

  if (partType === 'reasoning') {
    return opts.context === 'live_transcript'
      ? { kind: 'reasoning_text', text, partType }
      : { kind: 'non_transcript', text: '', partType };
  }

  if (!TRANSCRIPT_PART_TYPES.has(partType)) {
    return { kind: 'non_transcript', text: '', partType };
  }

  return text.trim().length > 0
    ? { kind: 'transcript_text', text, partType }
    : { kind: 'non_transcript', text: '', partType };
}
