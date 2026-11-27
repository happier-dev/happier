import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionHolderAdoption } from '@/subprocess/supervision/sessionHolderAdoption';
import { getHolderReplayRange, joinHolderReplayRanges, setHolderReplayRange, type HolderReplayRange } from '@/subprocess/supervision/sessionHolderReplayPosition';

export class AcpNdJsonProtocolError extends Error {
  readonly code = 'acp_ndjson_protocol_error' as const;

  constructor(options?: ErrorOptions) {
    super('ACP transport received a malformed newline-delimited JSON frame', options);
    this.name = 'AcpNdJsonProtocolError';
  }
}

export function createAcpNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options?: Readonly<{
    onMessageWritten?: (message: AnyMessage) => void;
    onHolderRecord?: (message: AnyMessage, range: HolderReplayRange) => void;
    /**
     * A held Agent's adopt contract, applied below the ACP SDK (which owns its
     * own request ids): handshake answers, id shifting and held requests.
     */
    sessionHolderAdoption?: (
      deliver: (message: Record<string, unknown>) => void,
      settleInOrder: (settle: () => void) => void,
    ) => SessionHolderAdoption | null;
  }>,
): Stream & Readonly<{ sessionHolderAdoption: SessionHolderAdoption | null }> {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const messageCapture: WriteStream | null =
    sessionProcessEnvironment().HAPPIER_ACP_CAPTURE_IO === '1'
      ? createWriteStream(join(tmpdir(), 'acp.client.messages.raw'), { flags: 'a' })
      : null;

  let adoption: SessionHolderAdoption | null = null;
  // A held request's answer settles when the SDK reads past every frame before it, the
  // order in which the SDK dispatches a live answer and its preceding notifications.
  type InOrderSettlement = Readonly<{ settleInOrder: () => void }>;
  const isSettlement = (item: unknown): item is InOrderSettlement =>
    typeof item === 'object' && item !== null && typeof (item as InOrderSettlement).settleInOrder === 'function';
  const source = new ReadableStream<AnyMessage | InOrderSettlement>({
    async start(controller) {
      let content = '';
      let contentRange: HolderReplayRange | undefined;
      const reader = input.getReader();
      adoption = options?.sessionHolderAdoption?.(message => {
        try { controller.enqueue(message as AnyMessage); } catch { /* the stream already ended */ }
      }, settle => {
        try { controller.enqueue({ settleInOrder: settle }); } catch { settle(); }
      }) ?? null;
      const enqueueLine = (line: string, range?: HolderReplayRange): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: AnyMessage;
        try {
          message = JSON.parse(trimmed) as AnyMessage;
        } catch (cause) {
          throw new AcpNdJsonProtocolError({ cause });
        }
        if (range) {
          setHolderReplayRange(message, range);
          const params = 'params' in message ? message.params : undefined;
          if (params && typeof params === 'object') setHolderReplayRange(params, range);
          options?.onHolderRecord?.(message, range);
        }
        const routed = adoption ? adoption.incoming(message as Record<string, unknown>) : message;
        if (routed) controller.enqueue((range ? setHolderReplayRange(routed, range) : routed) as AnyMessage);
      };
      let terminalError: unknown = null;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          contentRange = joinHolderReplayRanges(contentRange, getHolderReplayRange(value));
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split('\n');
          content = lines.pop() || '';
          for (const line of lines) {
            enqueueLine(line, contentRange);
          }
          if (!content) contentRange = undefined;
        }

        content += textDecoder.decode();
        for (const line of content.split('\n')) {
          enqueueLine(line, contentRange);
        }
      } catch (error) {
        terminalError = error;
        controller.error(error);
        try {
          await reader.cancel(error);
        } catch {
          // The protocol failure remains authoritative if the source is already closed.
        }
      } finally {
        reader.releaseLock();
      }
      if (terminalError === null) controller.close();
    },
  });

  // Only a holder-launched stream can carry settlements; every other stream is read as is.
  const readable = options?.sessionHolderAdoption
    ? source.pipeThrough(new TransformStream<AnyMessage | InOrderSettlement, AnyMessage>({
      transform(item, controller) {
        if (isSettlement(item)) item.settleInOrder();
        else controller.enqueue(item);
      },
    }))
    : source as ReadableStream<AnyMessage>;

  let outputWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const getOutputWriter = (): WritableStreamDefaultWriter<Uint8Array> => {
    if (outputWriter) return outputWriter;
    outputWriter = output.getWriter();
    return outputWriter;
  };
  const releaseOutputWriter = (): void => {
    if (!outputWriter) return;
    outputWriter.releaseLock();
    outputWriter = null;
  };

  const writer = {
    async write(original: AnyMessage) {
      const message = adoption ? await adoption.outgoing(original as Record<string, unknown>) as AnyMessage | null : original;
      if (!message) {
        options?.onMessageWritten?.(original);
        return;
      }
      const content = JSON.stringify(message) + '\n';
      messageCapture?.write(content);
      await getOutputWriter().write(textEncoder.encode(content));
      options?.onMessageWritten?.(original);
    },
    async close() {
      const writer = getOutputWriter();
      try {
        await writer.close();
      } finally {
        messageCapture?.end();
        releaseOutputWriter();
      }
    },
    async abort(reason) {
      const writer = getOutputWriter();
      try {
        await writer.abort(reason);
      } finally {
        messageCapture?.end();
        releaseOutputWriter();
      }
    },
    releaseLock() {
      // Intentionally a no-op. ACP SDK reacquires a writer for every message, and
      // some packaged runtimes do not reliably support repeated outer getWriter()
      // churn. We keep one stable writer facade bound to the same underlying
      // child-stdin writer instead.
    },
    get closed() {
      return Promise.resolve(undefined);
    },
    get desiredSize() {
      return null;
    },
    get ready() {
      return Promise.resolve(undefined);
    },
  } as WritableStreamDefaultWriter<AnyMessage>;

  const writable = {
    getWriter() {
      return writer;
    },
    get locked() {
      return false;
    },
    async abort(reason?: unknown) {
      await writer.abort(reason);
    },
    async close() {
      await writer.close();
    },
  } as unknown as WritableStream<AnyMessage>;

  return { readable, writable, get sessionHolderAdoption() { return adoption; } };
}
