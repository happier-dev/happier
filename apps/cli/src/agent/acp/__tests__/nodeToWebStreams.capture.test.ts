import { describe, expect, it } from 'vitest';

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { nodeToWebStreams } from '../nodeToWebStreams';

async function readFileWithRetry(path: string, opts: Readonly<{ timeoutMs?: number; intervalMs?: number }> = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await readFile(path, 'utf8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
      if (code !== 'ENOENT') {
        throw err;
      }
      if (Date.now() > deadline) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

describe('nodeToWebStreams (ACP IO capture)', () => {
  it('captures stdin/stdout bytes when HAPPIER_ACP_CAPTURE_IO is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-acp-io-'));
    const traceFile = join(dir, 'tooltrace.jsonl');

    const prevCapture = process.env.HAPPIER_ACP_CAPTURE_IO;
    const prevTrace = process.env.HAPPIER_STACK_TOOL_TRACE_FILE;
    process.env.HAPPIER_ACP_CAPTURE_IO = '1';
    process.env.HAPPIER_STACK_TOOL_TRACE_FILE = traceFile;

    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();

      const { writable, readable } = nodeToWebStreams(stdin, stdout);

      const encoder = new TextEncoder();
      const stdinPayload = '{"jsonrpc":"2.0","method":"ping"}\n';
      const stdoutPayload = '{"jsonrpc":"2.0","id":1,"result":{}}\n';

      const writer = writable.getWriter();
      await writer.write(encoder.encode(stdinPayload));
      await writer.close();

      stdout.write(Buffer.from(stdoutPayload, 'utf8'));
      stdout.end();

      // Drain the stream so all stdout chunks are processed before assertions.
      const reader = readable.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      const capturedIn = await readFileWithRetry(join(dir, 'acp.stdin.raw'));
      const capturedOut = await readFileWithRetry(join(dir, 'acp.stdout.raw'));

      expect(capturedIn).toContain(stdinPayload);
      expect(capturedOut).toContain(stdoutPayload);
    } finally {
      if (prevCapture === undefined) delete (process.env as any).HAPPIER_ACP_CAPTURE_IO;
      else process.env.HAPPIER_ACP_CAPTURE_IO = prevCapture;
      if (prevTrace === undefined) delete (process.env as any).HAPPIER_STACK_TOOL_TRACE_FILE;
      else process.env.HAPPIER_STACK_TOOL_TRACE_FILE = prevTrace;
    }
  });
});
