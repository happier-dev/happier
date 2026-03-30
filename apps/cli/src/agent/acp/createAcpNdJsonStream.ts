import type { AnyMessage } from '@agentclientprotocol/sdk/dist/jsonrpc.js';
import type { Stream } from '@agentclientprotocol/sdk/dist/stream.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createAcpNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const messageCapture: WriteStream | null =
    process.env.HAPPIER_ACP_CAPTURE_IO === '1'
      ? createWriteStream(join(tmpdir(), 'acp.client.messages.raw'), { flags: 'a' })
      : null;

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = '';
      const reader = input.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split('\n');
          content = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            controller.enqueue(JSON.parse(trimmed) as AnyMessage);
          }
        }

        content += textDecoder.decode();
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          controller.enqueue(JSON.parse(trimmed) as AnyMessage);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

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
    async write(message: AnyMessage) {
      const content = JSON.stringify(message) + '\n';
      messageCapture?.write(content);
      await getOutputWriter().write(textEncoder.encode(content));
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

  return { readable, writable };
}
