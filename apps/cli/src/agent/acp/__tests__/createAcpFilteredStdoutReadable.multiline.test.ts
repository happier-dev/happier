import { describe, expect, it } from 'vitest';

import { createAcpFilteredStdoutReadable } from '../createAcpFilteredStdoutReadable';
import type { TransportHandler } from '@/agent/transport/TransportHandler';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function makeReadable(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe('createAcpFilteredStdoutReadable', () => {
  it('reassembles multi-line JSON objects and drops non-JSON lines', async () => {
    const dropped: Array<{ reason: string; line: string }> = [];
    const transport: TransportHandler = {
      agentName: 'test',
      getInitTimeout: () => 0,
      getToolPatterns: () => [],
      filterStdoutLine: (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed !== 'object' || parsed === null) return null;
          return line;
        } catch {
          return null;
        }
      },
    };

    const input = [
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      'progress: 1/3',
      '{',
      '  "jsonrpc": "2.0",',
      '  "id": 2,',
      '  "result": {}',
      '}',
      'progress: 2/3',
      '[{"jsonrpc":"2.0","id":3,"result":{}}]',
      '',
    ].join('\n');

    const filtered = createAcpFilteredStdoutReadable({
      readable: makeReadable(input),
      transport,
      onDroppedLine: (entry: { reason: string; line: string }) => dropped.push(entry),
      maxMultilineBytes: 1024,
    });

    const output = await readAll(filtered);
    const outLines = output.split('\n').filter(Boolean);

    expect(outLines).toHaveLength(3);
    expect(outLines[0]).toContain('"id":1');
    expect(outLines[1]).toContain('"id":2');
    expect(outLines[2]).toContain('"id":3');

    expect(dropped.some((d) => d.line.includes('progress: 1/3'))).toBe(true);
    expect(dropped.some((d) => d.line.includes('progress: 2/3'))).toBe(true);
  });
});
