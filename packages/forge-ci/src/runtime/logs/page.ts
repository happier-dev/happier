import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/plugin-sdk/actions';
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';
import type { ForgeCiActionResultByOperationV1, ForgeCiLogSelectionV1, ForgeCiLogV1 } from '@happier-dev/triage-protocol/ci/v1';
import { forgeCiJobKeyV1 } from '../identity.js';
import { decodeForgeCiLogBytesV1, sameForgeCiLogContentV1, type ForgeCiLogIndexV1 } from './index.js';
import { selectForgeCiLogLinesV1 } from './selection.js';

type AvailableLog = Extract<ForgeCiLogV1, { kind: 'available' }>;
type LogValue = Readonly<{ kind: 'value'; value: ForgeCiLogV1 }>;
type Fragment = Extract<AvailableLog, { fragments: unknown }>['fragments'][number];

/** In-process only. The provider's source-private codec binds this position to authority and query. */
export type ForgeCiLogPagePositionV1 = Readonly<{ lineIndex: number; utf16Offset: number }>;

const encoder = new TextEncoder();
function unavailable(code: string): ForgeCiActionResultByOperationV1['readJobLog'] {
  return { kind: 'unavailable', failure: { class: 'unsupportedContract', code } };
}
function newlineCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return count;
}
function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
}

/** Fits the canonical read result, preserving original bytes rather than reconstituting display text. */
export function projectForgeCiLogPageV1(input: Readonly<{
  index: ForgeCiLogIndexV1;
  selection: ForgeCiLogSelectionV1;
  position?: ForgeCiLogPagePositionV1;
  maxSerializedBytes?: number;
  measureSerializedBytes?(result: LogValue): number;
  mintContinuation(position: ForgeCiLogPagePositionV1): string | null;
}>): ForgeCiActionResultByOperationV1['readJobLog'] {
  const selected = selectForgeCiLogLinesV1(input.index, input.selection);
  if (selected.kind !== 'value') return selected;
  const requested = input.position ?? { lineIndex: 0, utf16Offset: 0 };
  if (!Number.isSafeInteger(requested.lineIndex) || !Number.isSafeInteger(requested.utf16Offset)
    || requested.lineIndex < 0 || requested.lineIndex > selected.lines.length || requested.utf16Offset < 0
    || requested.lineIndex === selected.lines.length && requested.utf16Offset !== 0) return unavailable('invalid_log_page_position');
  const startingLine = selected.lines[requested.lineIndex];
  if (startingLine && (requested.utf16Offset > startingLine.originalText.length || splitsSurrogate(startingLine.originalText, requested.utf16Offset))) {
    return unavailable('invalid_log_page_position');
  }
  const segments: Array<{ text: string; offset: number; lineIndex: number; rawOffset: number; startLine: number; startByte: number }> = [];
  const chunks: string[] = [];
  let length = 0;
  for (let i = requested.lineIndex; i < selected.lines.length; i += 1) {
    const line = selected.lines[i]!;
    const rawOffset = i === requested.lineIndex ? requested.utf16Offset : 0;
    const text = line.originalText.slice(rawOffset);
    if (text.length === 0) continue;
    segments.push({ text, offset: length, lineIndex: i, rawOffset, startLine: line.number,
      startByte: line.originalStartByte + encoder.encode(line.originalText.slice(0, rawOffset)).byteLength });
    chunks.push(text);
    length += text.length;
  }
  const remaining = chunks.join('');
  const resumeLine = startingLine ?? selected.lines.at(-1);
  const resumePrefix = startingLine ? startingLine.originalText.slice(0, requested.utf16Offset) : resumeLine?.originalText ?? '';
  const resumeStartLine = resumeLine ? resumeLine.number + newlineCount(resumePrefix) : input.index.log.startLine;
  const resumeStartByte = resumeLine ? resumeLine.originalStartByte + encoder.encode(resumePrefix).byteLength : input.index.log.startByte;
  const positionFor = (included: number): ForgeCiLogPagePositionV1 => {
    for (const segment of segments) if (included < segment.offset + segment.text.length) {
      return { lineIndex: segment.lineIndex, utf16Offset: segment.rawOffset + Math.max(0, included - segment.offset) };
    }
    return { lineIndex: selected.lines.length, utf16Offset: 0 };
  };
  const project = (prefix: string, _truncated: boolean): LogValue => {
    const fragments: Array<{ text: string; startLine: number; startByte: number; endByte: number; nextLine: number }> = [];
    for (const segment of segments) {
      if (segment.offset >= prefix.length) break;
      const text = segment.text.slice(0, prefix.length - segment.offset);
      const endByte = segment.startByte + encoder.encode(text).byteLength;
      const previous = fragments.at(-1);
      if (previous && previous.endByte === segment.startByte && previous.nextLine === segment.startLine) {
        previous.text += text;
        previous.endByte = endByte;
        previous.nextLine = segment.startLine + newlineCount(text);
      } else fragments.push({ text, startLine: segment.startLine, startByte: segment.startByte, endByte, nextLine: segment.startLine + newlineCount(text) });
    }
    const hasMore = prefix.length < remaining.length;
    const continuation = hasMore ? input.mintContinuation(positionFor(prefix.length)) : input.index.continuation;
    if (hasMore && (continuation === null || continuation.length === 0)) throw new RangeError('log_page_cursor_unavailable');
    // `complete` carries native EOF. The receiving index separately proves original prefix/no gaps.
    const sourceEof = input.selection.kind === 'all' ? input.index.log.complete
      : input.index.complete && selected.lines.length === input.index.lines.length;
    const first = fragments[0];
    const base = { kind: 'available' as const, job: input.index.job, logId: input.index.logId,
      startLine: first?.startLine ?? resumeStartLine,
      startByte: first?.startByte ?? resumeStartByte,
      complete: sourceEof && !hasMore && continuation === null, continuation };
    return { kind: 'value', value: first ? { ...base, fragments: fragments.map(({ text, startLine, startByte }) => ({ text, startLine, startByte })) } : { ...base, text: '' } };
  };
  try {
    const value = fitActionResultTextV1(remaining, project, {
      maxSerializedBytes: input.maxSerializedBytes ?? EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
      measureSerializedBytes: input.measureSerializedBytes ?? measureExternalActionResultResponseEnvelopeUtf8BytesV1,
    });
    if (remaining.length > 0 && value.value.kind === 'available' && 'text' in value.value && value.value.text.length === 0) return unavailable('insufficient_log_page_budget');
    return value;
  } catch (error) {
    if (error instanceof RangeError && error.message === 'log_page_cursor_unavailable') return unavailable(error.message);
    if (error instanceof RangeError && (error.message === 'action_result_base_exceeds_serialized_boundary' || error.message === 'invalid_serialized_boundary')) return unavailable('insufficient_log_page_budget');
    throw error;
  }
}

function fragmentsOf(log: AvailableLog): readonly Fragment[] {
  return 'fragments' in log ? log.fragments : [{ text: log.text, startLine: log.startLine, startByte: log.startByte }];
}

/** Combines observations of one immutable native log; this is neither a stream nor a cursor store. */
export function mergeForgeCiLogPagesV1(input: Readonly<{ previous?: AvailableLog; page: AvailableLog }>): ForgeCiActionResultByOperationV1['readJobLog'] {
  const { previous, page } = input;
  if (!previous) return { kind: 'value', value: page };
  if (previous.logId !== page.logId || forgeCiJobKeyV1(previous.job) !== forgeCiJobKeyV1(page.job)) return unavailable('log_page_identity_mismatch');
  if (sameForgeCiLogContentV1(previous, page)) {
    const complete = previous.complete || page.complete;
    const continuation = previous.complete && previous.continuation === null ? null : page.continuation;
    return { kind: 'value', value: complete === previous.complete && continuation === previous.continuation
      ? previous : { ...previous, complete, continuation } };
  }
  const combined = [...fragmentsOf(previous), ...fragmentsOf(page)].sort((a, b) => a.startByte - b.startByte || a.startLine - b.startLine);
  const fragments: Fragment[] = [];
  let lastBytes: Uint8Array | undefined;
  for (const fragment of combined) {
    const bytes = encoder.encode(fragment.text);
    const last = fragments.at(-1);
    if (!last || !lastBytes) { fragments.push(fragment); lastBytes = bytes; continue; }
    const previousEnd = last.startByte + lastBytes.byteLength;
    if (fragment.startByte > previousEnd) { fragments.push(fragment); lastBytes = bytes; continue; }
    const relative = fragment.startByte - last.startByte;
    const expectedLine = last.startLine + newlineCount(decodeForgeCiLogBytesV1([lastBytes.subarray(0, relative)]));
    if (expectedLine !== fragment.startLine) return unavailable('log_page_position_mismatch');
    const overlap = Math.min(previousEnd - fragment.startByte, bytes.byteLength);
    for (let i = 0; i < overlap; i += 1) if (lastBytes[relative + i] !== bytes[i]) return unavailable('log_page_content_mismatch');
    if (bytes.byteLength <= overlap) continue;
    const text = decodeForgeCiLogBytesV1([bytes.subarray(overlap)]);
    const clipped = overlap === 0 ? fragment : { text, startByte: fragment.startByte + overlap,
      startLine: fragment.startLine + newlineCount(decodeForgeCiLogBytesV1([bytes.subarray(0, overlap)])) };
    fragments.push(clipped);
    lastBytes = bytes.subarray(overlap);
  }
  const previousFragments = fragmentsOf(previous);
  const same = fragments.length === previousFragments.length && fragments.every((fragment, i) => {
    const old = previousFragments[i]!;
    return fragment.startByte === old.startByte && fragment.startLine === old.startLine && fragment.text === old.text;
  });
  const complete = previous.complete || page.complete;
  // Re-observing an already retained page cannot reopen a completed immutable walk.
  const continuation = same && previous.complete && previous.continuation === null ? null : page.continuation;
  if (same && complete === previous.complete && continuation === previous.continuation) return { kind: 'value', value: previous };
  const first = fragments[0];
  return { kind: 'value', value: first ? { kind: 'available', job: previous.job, logId: previous.logId,
    startLine: first.startLine, startByte: first.startByte, complete, continuation, fragments }
    : { kind: 'available', job: previous.job, logId: previous.logId, startLine: previous.startLine, startByte: previous.startByte, complete, continuation, text: '' } };
}
