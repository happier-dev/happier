import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createAcpFilteredStdoutReadable } from '../createAcpFilteredStdoutReadable';
import { AcpNdJsonProtocolError, createAcpNdJsonStream } from '../createAcpNdJsonStream';
import type { TransportHandler } from '@/agent/transport/TransportHandler';
import { nodeToWebStreams } from '../nodeToWebStreams';
import { getHolderReplayRange, setHolderReplayRange } from '@/subprocess/supervision/sessionHolderReplayPosition';

describe('createAcpNdJsonStream', () => {
  it('parses the final message even when the input ends without a trailing newline', async () => {
    const payload = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}';
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const output = new WritableStream<Uint8Array>();
    const stream = createAcpNdJsonStream(output, input);
    const reader = stream.readable.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true, value: undefined });
  });

  it('preserves both records in one holder frame and a UTF-8 record split across frames', async () => {
    const encode = (text: string) => Buffer.from(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'held', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    }) + '\n');
    const repeated = encode('same');
    const split = encode('🌱text');
    const splitAt = split.indexOf(Buffer.from('🌱')) + 2;
    const frame41 = Buffer.concat([repeated, repeated, split.subarray(0, splitAt)]);
    const frame42 = split.subarray(splitAt);
    const holderInstanceId = 'fixture-holder';
    const range = (startSequence: number, startOffset: number, endSequence: number, endOffset: number) => ({
      holderInstanceId,
      start: { sequence: startSequence, byteOffset: startOffset },
      end: { sequence: endSequence, byteOffset: endOffset },
    });
    const stdout = new PassThrough();
    const streams = nodeToWebStreams(new PassThrough(), stdout);
    const input = createAcpFilteredStdoutReadable({
      readable: streams.readable,
      transport: { agentName: 'test', getInitTimeout: () => 0, getToolPatterns: () => [] },
    });
    const reader = createAcpNdJsonStream(streams.writable, input).readable.getReader();

    stdout.write(setHolderReplayRange(frame41, range(41, 0, 41, frame41.length)));
    stdout.end(setHolderReplayRange(frame42, range(42, 0, 42, frame42.length)));

    for (const [text, position] of [
      ['same', range(41, 0, 41, repeated.length)],
      ['same', range(41, repeated.length, 41, 2 * repeated.length)],
      ['🌱text', range(41, 2 * repeated.length, 42, frame42.length)],
    ] as const) {
      const { value } = await reader.read();
      expect(value).toMatchObject({ params: { update: { content: { text } } } });
      expect(value && getHolderReplayRange(value)).toEqual(position);
    }
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('continues after the transport filters a diagnostic line', async () => {
    const payload = [
      'provider diagnostic: warming cache',
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}',
    ].join('\n');
    const rawInput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const transport: TransportHandler = {
      agentName: 'test',
      getInitTimeout: () => 0,
      getToolPatterns: () => [],
      filterStdoutLine: (line) => line.startsWith('provider diagnostic:') ? null : line,
    };
    const input = createAcpFilteredStdoutReadable({ readable: rawInput, transport });
    const stream = createAcpNdJsonStream(new WritableStream<Uint8Array>(), input);
    const reader = stream.readable.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true, value: undefined });
  });

  it('fails once with a typed protocol error for a malformed unfiltered frame', async () => {
    const rawInput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",malformed}\n'));
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
        controller.close();
      },
    });
    const transport: TransportHandler = {
      agentName: 'test',
      getInitTimeout: () => 0,
      getToolPatterns: () => [],
      filterStdoutLine: (line) => line,
    };
    const input = createAcpFilteredStdoutReadable({ readable: rawInput, transport });
    const stream = createAcpNdJsonStream(new WritableStream<Uint8Array>(), input);
    const reader = stream.readable.getReader();

    const failure = await reader.read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpNdJsonProtocolError);
    expect(failure).toMatchObject({ code: 'acp_ndjson_protocol_error' });
    await expect(reader.read()).rejects.toBe(failure);
  });

  it('preserves an upstream stdout transport failure instead of converting it to clean EOF', async () => {
    const transportFailure = new Error('provider stdout failed');
    const rawInput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(transportFailure);
      },
    });
    const transport: TransportHandler = {
      agentName: 'test',
      getInitTimeout: () => 0,
      getToolPatterns: () => [],
      filterStdoutLine: (line) => line,
    };
    const input = createAcpFilteredStdoutReadable({ readable: rawInput, transport });
    const reader = input.getReader();

    await expect(reader.read()).rejects.toBe(transportFailure);
    await expect(reader.read()).rejects.toBe(transportFailure);
  });

  it('reuses a single output writer across multiple message writes', async () => {
    const writes: string[] = [];
    let writerCount = 0;

    const output = {
      getWriter() {
        writerCount += 1;
        const currentWriterId = writerCount;
        return {
          async write(chunk: Uint8Array) {
            if (currentWriterId !== 1) {
              throw new Error(`unexpected writer ${currentWriterId}`);
            }
            writes.push(new TextDecoder().decode(chunk));
          },
          releaseLock() {
            // noop
          },
          async close() {
            // noop
          },
          async abort() {
            // noop
          },
        };
      },
    } as unknown as WritableStream<Uint8Array>;

    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const stream = createAcpNdJsonStream(output, input);
    const writer = stream.writable.getWriter();

    await writer.write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    writer.releaseLock();

    const nextWriter = stream.writable.getWriter();

    expect(nextWriter).toBe(writer);

    await nextWriter.write({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });

    expect(writerCount).toBe(1);
    expect(writes).toEqual([
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n',
      '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}\n',
    ]);
  });

  it('reports transport custody only after the underlying write succeeds', async () => {
    let releaseWrite!: () => void;
    const writeAccepted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const observed: unknown[] = [];
    const output = new WritableStream<Uint8Array>({
      async write() {
        await writeAccepted;
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const stream = createAcpNdJsonStream(output, input, {
      onMessageWritten: (message) => {
        observed.push(message);
      },
    });
    const message = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'cursor-session', prompt: [] },
    };

    const write = stream.writable.getWriter().write(message);
    await Promise.resolve();
    expect(observed).toEqual([]);

    releaseWrite();
    await write;
    expect(observed).toEqual([message]);
  });
});
