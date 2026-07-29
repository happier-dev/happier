import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';

const runRealTerminalRpcQa =
  process.env.HAPPIER_TERMINAL_REAL_PTY_RPC_QA === '1' && process.platform !== 'win32';

async function waitForTerminalStreamMarker(params: Readonly<{
  readBytes: (params: unknown) => Promise<unknown>;
  terminalId: string;
  marker: string;
  timeoutMs: number;
}>): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  let byteOffset = 0;
  let decoded = '';

  while (Date.now() < deadline) {
    const read = TerminalStreamReadResponseSchema.parse(await params.readBytes({
      terminalId: params.terminalId,
      byteOffset,
      maxBytes: 16 * 1024,
      maxFrames: 64,
    }));
    if (!read.ok) {
      throw new Error(`terminal byte stream read failed: ${read.code}`);
    }
    const byteFrames = read.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
    if (byteFrames.length > 0) {
      decoded += Buffer.concat(
        byteFrames.map((frame) => Buffer.from(decodeTerminalStreamBytesFrame(frame))),
      ).toString('utf8');
    }
    byteOffset = read.nextByteOffset;
    if (decoded.includes(params.marker)) {
      return decoded;
    }
    await delay(50);
  }

  throw new Error(`timed out waiting for terminal marker ${params.marker}; decoded=${JSON.stringify(decoded.slice(-1000))}`);
}

describe('registerMachineTerminalRpcHandlers real PTY QA', () => {
  it.runIf(runRealTerminalRpcQa)('drives a real PTY through daemon terminal RPC stream input and byte reads', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-real-rpc-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {
          ...process.env,
          HAPPIER_DAEMON_TERMINAL_ENABLED: '1',
          HAPPIER_DAEMON_TERMINAL_SHELL: '/bin/sh',
        },
        platform: process.platform,
        workingDirectory: rootDir,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    const sendInput = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT);
    const readBytes = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    const close = registered.get(RPC_METHODS.DAEMON_TERMINAL_CLOSE);
    expect(ensure).toBeDefined();
    expect(sendInput).toBeDefined();
    expect(readBytes).toBeDefined();
    expect(close).toBeDefined();

    let terminalId: string | null = null;
    try {
      const ensured = await ensure!({
        terminalKey: `real-rpc-${Date.now()}`,
        cwd: rootDir,
        cols: 80,
        rows: 24,
        sessionId: 'session-terminal-real-rpc-qa',
      });
      expect(ensured).toEqual(expect.objectContaining({ ok: true, reused: false }));
      if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
        throw new Error('expected terminal ensure to succeed');
      }
      terminalId = String(ensured.terminalId);
      const marker = `happier-terminal-rpc-${Date.now()}`;

      await expect(sendInput!({
        terminalId,
        event: { t: 'text', text: `printf '${marker}\\n'` },
      })).resolves.toEqual({ ok: true });
      await expect(sendInput!({
        terminalId,
        event: { t: 'key', key: 'Enter', modifiers: [] },
      })).resolves.toEqual({ ok: true });

      const decoded = await waitForTerminalStreamMarker({
        readBytes: readBytes!,
        terminalId,
        marker,
        timeoutMs: 10_000,
      });
      expect(decoded).toContain(marker);
    } finally {
      if (terminalId) {
        await close?.({ terminalId });
      }
    }
  }, 15_000);
});
