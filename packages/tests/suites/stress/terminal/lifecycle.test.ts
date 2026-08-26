import { Buffer } from 'node:buffer';

import {
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  createTerminalPtySessionManager,
  type TerminalPtySessionManagerConfig,
} from '../../../../../apps/cli/src/terminal/pty/sessions';
import type {
  Disposable,
  PtyExitEvent,
  PtyProcess,
  PtyProvider,
  PtySpawnParams,
} from '../../../../../apps/cli/src/terminal/pty/provider';

function createDisposable(onDispose: () => void): Disposable {
  return { dispose: onDispose };
}

class FakePty implements PtyProcess {
  public readonly pid = 4321;
  public killCount = 0;
  private readonly dataListeners = new Set<(data: string | Buffer) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(): void {
    // Input is outside this output-stream fixture.
  }

  resize(): void {
    // Resize is outside this output-stream fixture.
  }

  kill(): void {
    this.killCount += 1;
  }

  onData(listener: (data: string) => void): Disposable {
    const byteCapableListener = listener as unknown as (data: string | Buffer) => void;
    this.dataListeners.add(byteCapableListener);
    return createDisposable(() => {
      this.dataListeners.delete(byteCapableListener);
    });
  }

  onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return createDisposable(() => {
      this.exitListeners.delete(listener);
    });
  }

  emitBytes(bytes: Uint8Array): void {
    for (const listener of this.dataListeners) {
      listener(Buffer.from(bytes));
    }
  }
}

class FakePtyProvider implements PtyProvider {
  public readonly spawned: Array<Readonly<{ params: PtySpawnParams; pty: FakePty }>> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakePty();
    this.spawned.push({ params, pty });
    return pty;
  }
}

function terminalConfig(
  overrides: Partial<TerminalPtySessionManagerConfig> = {},
): TerminalPtySessionManagerConfig {
  return {
    maxSessions: 8,
    idleTimeoutMs: 60_000,
    bufferMaxBytes: 64 * 1024,
    bufferMaxEvents: 32,
    bufferRetentionMs: 60_000,
    urlParseBufferLimit: 8 * 1024,
    maxWriteChunkBytes: 64 * 1024,
    defaultCols: 80,
    defaultRows: 24,
    ...overrides,
  };
}

function readCanonicalByteFrames(response: unknown): readonly TerminalStreamBytesFrame[] {
  const parsed = TerminalStreamReadResponseSchema.parse(response);
  if (!parsed.ok) {
    throw new Error('expected terminal byte-stream read');
  }
  return parsed.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
}

describe('stress: terminal bounded byte-stream lifecycle', () => {
  it('composes daemon-owned credit, gap, and per-terminal cursor behavior', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: terminalConfig({ bufferMaxBytes: 6 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
    });

    try {
      const first = manager.ensure({ terminalKey: 'terminal-a', cwd: '/tmp' });
      const second = manager.ensure({ terminalKey: 'terminal-b', cwd: '/tmp' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error('expected terminal sessions');

      const firstPty = provider.spawned[0]?.pty;
      const secondPty = provider.spawned[1]?.pty;
      if (!firstPty || !secondPty) throw new Error('expected fake PTY sessions');
      firstPty.emitBytes(Buffer.from('abcdef'));
      secondPty.emitBytes(Buffer.from('XY'));

      const stalled = manager.readByteStream({
        terminalId: first.terminalId,
        byteOffset: 0,
        creditBytes: 0,
        maxBytes: 6,
        maxFrames: 4,
      });
      expect(stalled).toMatchObject({
        ok: true,
        nextByteOffset: 0,
        availableByteOffset: 6,
      });
      if (!stalled.ok) throw new Error('expected stalled terminal read');
      expect(stalled.frames.filter((frame) => frame.t === 'bytes')).toEqual([]);

      const firstWindow = manager.readByteStream({
        terminalId: first.terminalId,
        byteOffset: 0,
        creditBytes: 3,
        maxBytes: 6,
        maxFrames: 4,
      });
      expect(firstWindow).toMatchObject({
        ok: true,
        nextByteOffset: 3,
        availableByteOffset: 6,
      });
      expect(Buffer.concat(readCanonicalByteFrames(firstWindow).map(decodeTerminalStreamBytesFrame)))
        .toEqual(Buffer.from('abc'));
      expect(manager.acknowledgeByteStream({
        terminalId: first.terminalId,
        rendererId: 'stress-renderer',
        surfaceEpoch: 1,
        ackedByteOffset: 3,
        creditBytes: 3,
      })).toEqual({ ok: true });
      expect(manager.metrics()).toMatchObject({
        acknowledgedByteOffsetHighWater: 3,
        rendererAckLagBytesHighWater: 3,
      });

      const secondWindow = manager.readByteStream({
        terminalId: second.terminalId,
        byteOffset: 0,
        creditBytes: 2,
        maxBytes: 6,
        maxFrames: 4,
      });
      expect(secondWindow).toMatchObject({
        ok: true,
        terminalId: second.terminalId,
        nextByteOffset: 2,
        availableByteOffset: 2,
      });
      expect(Buffer.concat(readCanonicalByteFrames(secondWindow).map(decodeTerminalStreamBytesFrame)))
        .toEqual(Buffer.from('XY'));

      firstPty.emitBytes(Buffer.from('ghij'));
      const gapRead = manager.readByteStream({
        terminalId: first.terminalId,
        byteOffset: 0,
        creditBytes: 6,
        maxBytes: 6,
        maxFrames: 4,
      });
      expect(gapRead).toMatchObject({
        ok: true,
        nextByteOffset: 10,
        availableByteOffset: 10,
        droppedBeforeByteOffset: 6,
        frames: [
          {
            t: 'gap',
            terminalId: first.terminalId,
            droppedBeforeByteOffset: 6,
            nextAvailableByteOffset: 6,
            reason: 'ring_overflow',
          },
          {
            t: 'bytes',
            terminalId: first.terminalId,
            byteOffset: 6,
            byteLength: 4,
            encoding: 'base64',
          },
        ],
      });
      expect(Buffer.concat(readCanonicalByteFrames(gapRead).map(decodeTerminalStreamBytesFrame)))
        .toEqual(Buffer.from('ghij'));
    } finally {
      manager.dispose();
    }
  });

  it('releases session buffers and PTYs through idle reaping, close, and disposal', () => {
    let now = 0;
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: terminalConfig({ idleTimeoutMs: 100 }),
      now: () => now,
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
    });

    const idle = manager.ensure({ terminalKey: 'idle-terminal', cwd: '/tmp' });
    expect(idle.ok).toBe(true);
    if (!idle.ok) throw new Error('expected idle terminal');
    const idlePty = provider.spawned[0]?.pty;
    if (!idlePty) throw new Error('expected idle PTY');
    idlePty.emitBytes(Buffer.from('retained-before-idle-cleanup'));

    now = 101;
    const active = manager.ensure({ terminalKey: 'active-terminal', cwd: '/tmp' });
    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error('expected active terminal');
    expect(idlePty.killCount).toBe(1);
    expect(manager.readByteStream({
      terminalId: idle.terminalId,
      byteOffset: 0,
      creditBytes: 1,
    })).toEqual({
      ok: false,
      code: 'terminal_not_found',
      message: 'terminal_not_found',
    });

    const activePty = provider.spawned[1]?.pty;
    if (!activePty) throw new Error('expected active PTY');
    expect(manager.close({ terminalId: active.terminalId })).toEqual({ ok: true });
    expect(activePty.killCount).toBe(1);

    const final = manager.ensure({ terminalKey: 'dispose-terminal', cwd: '/tmp' });
    expect(final.ok).toBe(true);
    if (!final.ok) throw new Error('expected final terminal');
    const finalPty = provider.spawned[2]?.pty;
    if (!finalPty) throw new Error('expected final PTY');
    manager.dispose();
    expect(finalPty.killCount).toBe(1);
    expect(manager.readByteStream({
      terminalId: final.terminalId,
      byteOffset: 0,
      creditBytes: 1,
    })).toEqual({
      ok: false,
      code: 'terminal_not_found',
      message: 'terminal_not_found',
    });
  });
});
