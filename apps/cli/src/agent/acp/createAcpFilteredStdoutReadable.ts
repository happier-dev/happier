import type { TransportHandler } from '@/agent/transport/TransportHandler';

export type DroppedStdoutLine = {
  reason:
    | 'transport_filter_null'
    | 'multiline_overflow'
    | 'multiline_incomplete';
  line: string;
};

export function createAcpFilteredStdoutReadable(params: Readonly<{
  readable: ReadableStream<Uint8Array>;
  transport: TransportHandler;
  onDroppedLine?: (entry: DroppedStdoutLine) => void;
  onDone?: () => void;
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
      let buffer = '';

      let multiline: { buf: string; bytes: number } | null = null;

      const drop = (reason: DroppedStdoutLine['reason'], line: string) => {
        params.onDroppedLine?.({ reason, line });
      };

      const enqueueLine = (line: string): void => {
        if (!line.trim()) return;
        const filtered = params.transport.filterStdoutLine?.(line);
        if (filtered === undefined) {
          controller.enqueue(encoder.encode(line + '\n'));
          return;
        }
        if (filtered === null) {
          drop('transport_filter_null', line);
          return;
        }
        controller.enqueue(encoder.encode(filtered + '\n'));
      };

      const tryFlushMultiline = (candidate: string): boolean => {
        const trimmed = candidate.trim();
        if (!trimmed) return false;
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed !== 'object' || parsed === null) return false;
          enqueueLine(JSON.stringify(parsed));
          return true;
        } catch {
          return false;
        }
      };

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine;

            if (multiline) {
              const nextBuf: string = multiline.buf.length > 0 ? `${multiline.buf}\n${line}` : line;
              const nextBytes: number = multiline.bytes + line.length + 1;
              if (nextBytes > maxMultilineBytes) {
                drop('multiline_overflow', multiline.buf);
                multiline = null;
                // Re-process current line normally (it may be a new JSON object or log output).
                enqueueLine(line);
                continue;
              }
              multiline = { buf: nextBuf, bytes: nextBytes };
              if (tryFlushMultiline(multiline.buf)) {
                multiline = null;
              }
              continue;
            }

            // Fast path: normal ndJSON line
            const trimmed = line.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              // If it parses as JSON already, emit as-is (preserves provider formatting).
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'object' && parsed !== null) {
                  enqueueLine(line);
                  continue;
                }
              } catch {
                // Start buffering a multi-line JSON payload.
                multiline = { buf: line, bytes: line.length };
                continue;
              }
            }

            enqueueLine(line);
          }
        }

        // Flush any remaining buffered lines.
        if (multiline) {
          if (!tryFlushMultiline(multiline.buf)) {
            drop('multiline_incomplete', multiline.buf);
          }
          multiline = null;
        }

        const trailing = buffer.trim();
        if (trailing) {
          // Treat trailing fragment as a dropped line; it can't be framed as ndJSON.
          drop('multiline_incomplete', buffer);
        }
      } finally {
        reader.releaseLock();
        try {
          params.onDone?.();
        } catch {
          // ignore
        }
        controller.close();
      }
    },
  });
}
