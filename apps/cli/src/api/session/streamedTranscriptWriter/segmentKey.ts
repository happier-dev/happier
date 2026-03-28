export type StreamedTranscriptSegmentKind = 'assistant' | 'thinking';

export type StreamedTranscriptSegmentKey = string;

export function buildStreamedTranscriptSegmentKey(
  kind: StreamedTranscriptSegmentKind,
  sidechainId: string | null,
): StreamedTranscriptSegmentKey {
  return `${kind}:${sidechainId ?? 'main'}`;
}
