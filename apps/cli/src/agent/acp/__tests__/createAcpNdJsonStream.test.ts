import { describe, expect, it } from 'vitest';

import { createAcpNdJsonStream } from '../createAcpNdJsonStream';

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
});
