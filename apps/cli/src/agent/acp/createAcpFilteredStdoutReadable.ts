import type { TransportHandler } from '@/agent/transport/TransportHandler';
import { getHolderReplayRange, joinHolderReplayRanges, setHolderReplayRange, type HolderReplayRange } from '@/subprocess/supervision/sessionHolderReplayPosition';

export type DroppedStdoutLine = {
  reason:
    | 'transport_filter_null'
    | 'multiline_overflow';
  line: string;
};

export function createAcpFilteredStdoutReadable(params: Readonly<{
  readable: ReadableStream<Uint8Array>;
  transport: TransportHandler;
  onDroppedLine?: (entry: DroppedStdoutLine) => void;
  onDone?: () => void;
  acceptDiscardedRange?: (range: HolderReplayRange) => void;
  /**
   * Maximum bytes to buffer while reassembling a multi-line JSON object/array.
   * This is defensive against providers that emit huge payloads without proper ndJSON framing.
   */
  maxMultilineBytes?: number;
}>): ReadableStream<Uint8Array> {
  const maxMultilineBytes =
    typeof params.maxMultilineBytes === 'number' && Number.isFinite(params.maxMultilineBytes) && params.maxMultilineBytes > 0
      ? Math.trunc(params.maxMultilineBytes)
      : 1_000_000;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = params.readable.getReader();
      let pendingFragments: Uint8Array[] = [];
      let pendingRange: HolderReplayRange | undefined;
      let multiline: { buf: string; bytes: number; range?: HolderReplayRange } | null = null;

      const drop = (reason: DroppedStdoutLine['reason'], line: string) => {
        params.onDroppedLine?.({ reason, line });
      };

      const enqueueLine = (line: string, range?: HolderReplayRange): void => {
        if (!line.trim()) {
          if (range) params.acceptDiscardedRange?.(range);
          return;
        }
        const filtered = params.transport.filterStdoutLine?.(line);
        if (filtered === null) {
          drop('transport_filter_null', line);
          if (range) params.acceptDiscardedRange?.(range);
          return;
        }
        const bytes = encoder.encode((filtered ?? line) + '\n');
        controller.enqueue(range ? setHolderReplayRange(bytes, range) : bytes);
      };

      const tryFlushMultiline = (candidate: string, range?: HolderReplayRange): boolean => {
        const trimmed = candidate.trim();
        if (!trimmed) return false;
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed !== 'object' || parsed === null) return false;
          enqueueLine(JSON.stringify(parsed), range);
          return true;
        } catch {
          return false;
        }
      };

      const appendFragment = (fragment: Uint8Array, range: HolderReplayRange | undefined) => {
        pendingFragments.push(fragment);
        pendingRange = joinHolderReplayRanges(pendingRange, range);
      };
      const finishLine = (): Readonly<{ text: string; range?: HolderReplayRange }> => {
        const bytes = pendingFragments.length === 1 ? pendingFragments[0]! : Buffer.concat(pendingFragments);
        const range = pendingRange;
        pendingFragments = [];
        pendingRange = undefined;
        return { text: decoder.decode(bytes, { stream: true }), range };
      };

      const handleLine = (line: string, range: HolderReplayRange | undefined) => {
        if (multiline) {
          const nextBuf: string = multiline.buf.length > 0 ? `${multiline.buf}\n${line}` : line;
          const nextBytes: number = multiline.bytes + line.length + 1;
          if (nextBytes > maxMultilineBytes) {
            drop('multiline_overflow', multiline.buf);
            if (multiline.range) params.acceptDiscardedRange?.(multiline.range);
            multiline = null;
            // Re-process current line normally (it may be a new JSON object or log output).
            enqueueLine(line, range);
            return;
          }
          const joinedRange = joinHolderReplayRanges(multiline.range, range);
          multiline = { buf: nextBuf, bytes: nextBytes, range: joinedRange };
          if (tryFlushMultiline(multiline.buf, joinedRange)) multiline = null;
          return;
        }

        const trimmed = line.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
              enqueueLine(line, range);
              return;
            }
          } catch {
            multiline = { buf: line, bytes: line.length, range };
            return;
          }
        }

        enqueueLine(line, range);
      };

      let completed = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;

          // LF is one byte. Keep incomplete records in bytes until we know the
          // raw extent of the line, including a UTF-8 scalar split across frames.
          const range = getHolderReplayRange(value);
          const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          let start = 0;
          const append = (end: number) => {
            appendFragment(bytes.subarray(start, end), range && {
              holderInstanceId: range.holderInstanceId,
              start: { sequence: range.start.sequence, byteOffset: range.start.byteOffset + start },
              end: { sequence: range.end.sequence, byteOffset: range.start.byteOffset + end },
            });
          };
          for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
            append(newline + 1);
            const line = finishLine();
            handleLine(line.text.slice(0, -1), line.range);
            start = newline + 1;
          }
          if (start < bytes.length) append(bytes.length);
        }

        const last = finishLine();
        const tail = last.text + decoder.decode();
        // The ACP stream accepts one final complete frame without a trailing LF.
        if (multiline) {
          const candidate = tail.length > 0 ? `${multiline.buf}\n${tail}` : multiline.buf;
          const range = joinHolderReplayRanges(multiline.range, last.range);
          if (!tryFlushMultiline(candidate, range)) {
            // Let the canonical ACP stream distinguish protocol failure from diagnostics.
            enqueueLine(candidate, range);
          }
        } else if (tail.length > 0 || last.range) {
          enqueueLine(tail, last.range);
        }
        completed = true;
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
        try {
          params.onDone?.();
        } catch {
          // ignore
        }
        if (completed) controller.close();
      }
    },
  });
}
