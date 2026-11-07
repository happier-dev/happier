import { decodeTerminalStreamBytesFrame, encodeTerminalStreamBytes,
  type TerminalStreamBytesFrame, type TerminalStreamReadResponse } from '../../terminal/stream.js';
import type { ProjectExecutionOutputSelectionReceiptV1 } from '../specs/actionOperations.js';

type Output = Extract<TerminalStreamReadResponse, { ok: true }>;

/** Project one admitted ring read onto the requested interval; missing bytes stay missing. */
export function selectOperationOutput(
  output: Output,
  request: ProjectExecutionOutputSelectionReceiptV1['request'],
): Readonly<{ output: Output; selection: ProjectExecutionOutputSelectionReceiptV1 }> {
  const start = request.byteOffset;
  const end = request.selection.endByteOffset;
  const frames: TerminalStreamBytesFrame[] = [];
  const gaps: ProjectExecutionOutputSelectionReceiptV1['coverage']['gaps'] = [];
  const evictedEnd = Math.min(end, Math.max(start, output.droppedBeforeByteOffset));
  if (evictedEnd > start) gaps.push({ startByteOffset: start, endByteOffset: evictedEnd, reason: 'evicted' });
  let delivered = evictedEnd;
  const decoder = new TextDecoder();
  let text = '';
  for (const frame of output.frames) {
    if (frame.t !== 'bytes') continue;
    const from = Math.max(start, frame.byteOffset);
    const to = Math.min(end, frame.byteOffset + frame.byteLength);
    if (from >= to) continue;
    if (from > delivered) gaps.push({ startByteOffset: delivered, endByteOffset: from, reason: 'not_returned' });
    const bytes = decodeTerminalStreamBytesFrame(frame).subarray(from - frame.byteOffset, to - frame.byteOffset);
    frames.push({ ...frame, byteOffset: from, byteLength: bytes.byteLength, data: encodeTerminalStreamBytes(bytes) });
    text += decoder.decode(bytes, { stream: true });
    delivered = to;
  }
  text += decoder.decode();
  if (delivered < end) gaps.push({ startByteOffset: delivered, endByteOffset: end, reason: 'not_returned' });
  return {
    // Keep the ring's availability/retention facts and a valid cursor even when
    // the entire selection is evicted. Control markers are coverage, not selected text.
    output: { ...output, frames, nextByteOffset: frames.length
      ? frames[frames.length - 1]!.byteOffset + frames[frames.length - 1]!.byteLength
      : Math.max(output.droppedBeforeByteOffset, Math.min(output.nextByteOffset, end)) },
    selection: { request, text, coverage: { complete: gaps.length === 0, gaps } },
  };
}
