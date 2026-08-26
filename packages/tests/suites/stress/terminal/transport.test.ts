import { Buffer } from 'node:buffer';

import {
  TERMINAL_STREAM_MAX_FRAMES,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createRunDirs } from '../../../src/testkit/runDir';
import {
  assertTerminalReportHasNoLoss,
  formatTerminalBenchmarkReportSummary,
} from '../../../src/testkit/terminal/report';
import {
  buildTerminalBenchRun,
  writeTerminalBenchReport,
} from '../../../src/testkit/terminal/benchCli';
import { registerMachineTerminalRpcHandlers } from '../../../../../apps/cli/src/api/machine/rpcHandlers.terminal';
import { createEncryptedRpcTestClient } from '../../../../../apps/cli/src/rpc/handlers/encryptedRpc.testkit';
import { createTerminalPtySessionManager } from '../../../../../apps/cli/src/terminal/pty/sessions';
import type {
  Disposable,
  PtyExitEvent,
  PtyProcess,
  PtyProvider,
  PtySpawnParams,
} from '../../../../../apps/cli/src/terminal/pty/provider';

const run = createRunDirs({ runLabel: 'terminal-stress' });

function disposable(onDispose: () => void = () => {}): Disposable {
  return { dispose: onDispose };
}

class RawBytePty implements PtyProcess {
  public readonly pid = 4321;
  private readonly byteListeners = new Set<(data: Buffer | string) => void>();

  write(): void {}

  resize(): void {}

  kill(): void {}

  onData(_listener: (data: string) => void): Disposable {
    return disposable();
  }

  onDataBytes(listener: (data: Buffer | string) => void): Disposable {
    this.byteListeners.add(listener);
    return disposable(() => this.byteListeners.delete(listener));
  }

  onExit(_listener: (event: PtyExitEvent) => void): Disposable {
    return disposable();
  }

  emitBytes(bytes: Buffer): void {
    for (const listener of this.byteListeners) {
      listener(bytes);
    }
  }
}

class RawBytePtyProvider implements PtyProvider {
  public readonly spawned: Array<Readonly<{ params: PtySpawnParams; pty: RawBytePty }>> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new RawBytePty();
    this.spawned.push({ params, pty });
    return pty;
  }
}

describe('stress: canonical terminal base64 framing', () => {
  it('frames every TERM workload through the canonical bounded protocol codec without byte loss', () => {
    const report = buildTerminalBenchRun({
      repeat: 1,
      frameBytes: 8 * 1024,
    });

    assertTerminalReportHasNoLoss(report);
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.totals.decodedBytes).toBeGreaterThan(0);
    expect(formatTerminalBenchmarkReportSummary(report)).toContain('terminal-canonical-base64-framing');
    writeTerminalBenchReport(report, `${run.testDir('transport')}/terminal-canonical-base64-framing.json`);
  });

  it('composes PTY output through encrypted machine RPC and strict decoding with an omitted frame cap', async () => {
    const provider = new RawBytePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 1,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: TERMINAL_STREAM_MAX_FRAMES,
        bufferMaxEvents: TERMINAL_STREAM_MAX_FRAMES + 10,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: TERMINAL_STREAM_MAX_FRAMES + 10,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'terminal-stress',
      registerHandlers: (rpcHandlerManager) => {
        registerMachineTerminalRpcHandlers({
          rpcHandlerManager,
          deps: {
            env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
            platform: 'linux',
            workingDirectory: process.cwd(),
            sessionManager,
          },
        });
      },
    });

    try {
      const ensured = await client.call<unknown, {
        terminalKey: string;
        cwd: string;
        cols: number;
        rows: number;
      }>(RPC_METHODS.DAEMON_TERMINAL_ENSURE, {
        terminalKey: 'encrypted-frame-cap',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
        throw new Error('expected terminal ensure to succeed');
      }
      const terminalId = String(ensured.terminalId);
      const pty = provider.spawned[0]?.pty;
      if (!pty) throw new Error('expected PTY to spawn');
      for (let index = 0; index < TERMINAL_STREAM_MAX_FRAMES + 1; index += 1) {
        pty.emitBytes(Buffer.from([index % 251]));
      }

      const response = TerminalStreamReadResponseSchema.parse(
        await client.call<unknown, { terminalId: string; byteOffset: number }>(
          RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
          { terminalId, byteOffset: 0 },
        ),
      );
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error('expected terminal byte stream response');
      expect(response.frames).toHaveLength(TERMINAL_STREAM_MAX_FRAMES);
      expect(response.frames[0]).toMatchObject({
        t: 'gap',
        droppedBeforeByteOffset: 1,
        nextAvailableByteOffset: 1,
      });
      expect(response.nextByteOffset).toBe(TERMINAL_STREAM_MAX_FRAMES);
      expect(response.availableByteOffset).toBe(TERMINAL_STREAM_MAX_FRAMES + 1);

      const byteFrames = response.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
      expect(Buffer.concat(byteFrames.map(decodeTerminalStreamBytesFrame))).toEqual(
        Buffer.from(Array.from({ length: TERMINAL_STREAM_MAX_FRAMES - 1 }, (_value, index) => (index + 1) % 251)),
      );
    } finally {
      sessionManager.dispose();
    }
  });
});
