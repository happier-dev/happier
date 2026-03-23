import { describe, expect, it } from 'vitest';

import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { nodeToWebStreams } from '../nodeToWebStreams';
import {
  createAcpSubprocessEnvScope,
  waitForFileToContain,
} from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('nodeToWebStreams (ACP IO capture)', () => {
  it('captures stdin/stdout bytes when HAPPIER_ACP_CAPTURE_IO is enabled', async () => {
    await withTempDir('happier-acp-io-', async (dir) => {
      const traceFile = join(dir, 'tooltrace.jsonl');
      const envScope = createAcpSubprocessEnvScope();
      envScope.patch({
        HAPPIER_ACP_CAPTURE_IO: '1',
        HAPPIER_STACK_TOOL_TRACE_FILE: traceFile,
      });

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

        const capturedInPath = join(dir, 'acp.stdin.raw')
        const capturedOutPath = join(dir, 'acp.stdout.raw')
        await waitForFileToContain(capturedInPath, stdinPayload, { timeoutMs: 2_000, intervalMs: 10 })
        await waitForFileToContain(capturedOutPath, stdoutPayload, { timeoutMs: 2_000, intervalMs: 10 })
      } finally {
        envScope.restore();
      }
    });
  });
});
