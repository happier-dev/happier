import { describe, expect, it } from 'vitest';

import { createTerminalPtySessionManager, type TerminalPtySessionManagerConfig } from './terminalPtySessionManager';
import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './ptyProvider';

function createFakeDisposable(): Disposable {
  return { dispose: () => { } };
}

class FakePty implements PtyProcess {
  public readonly writes: string[] = [];
  private readonly onDataListeners = new Set<(data: string) => void>();
  private readonly onExitListeners = new Set<(e: PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(String(data));
  }

  resize(): void {
    // noop
  }

  kill(): void {
    // noop
  }

  onData(listener: (data: string) => void): Disposable {
    this.onDataListeners.add(listener);
    return createFakeDisposable();
  }

  onExit(listener: (e: PtyExitEvent) => void): Disposable {
    this.onExitListeners.add(listener);
    return createFakeDisposable();
  }

  emitData(data: string): void {
    for (const listener of this.onDataListeners) {
      listener(data);
    }
  }

  emitExit(e: PtyExitEvent): void {
    for (const listener of this.onExitListeners) {
      listener(e);
    }
  }
}

class FakePtyProvider implements PtyProvider {
  public readonly spawned: Array<{ params: PtySpawnParams; pty: FakePty }> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakePty();
    this.spawned.push({ params, pty });
    return pty;
  }
}

function defaultConfig(overrides?: Partial<TerminalPtySessionManagerConfig>): TerminalPtySessionManagerConfig {
  return {
    maxSessions: 10,
    idleTimeoutMs: 60_000,
    bufferMaxBytes: 1_000_000,
    bufferMaxEvents: 1000,
    urlParseBufferLimit: 32_768,
    maxWriteChunkBytes: 16_384,
    defaultCols: 80,
    defaultRows: 24,
    ...overrides,
  };
}

describe('TerminalPtySessionManager', () => {
  it('reuses sessions by terminalKey', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
    });

    const first = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 80, rows: 24 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');

    const second = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 81, rows: 25 });
    expect(second).toEqual({ ok: true, terminalId: first.terminalId, reused: true });
  });

  it('streams PTY output via cursor reads', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData('hello');

    const read1 = manager.read({ terminalId: ensured.terminalId, cursor: 0, maxBytes: 1024, maxEvents: 10 });
    expect(read1.ok).toBe(true);
    if (!read1.ok) throw new Error('expected ok');
    expect(read1.events).toEqual([{ t: 'data', data: 'hello' }]);
    expect(read1.nextCursor).toBe(1);

    const read2 = manager.read({ terminalId: ensured.terminalId, cursor: read1.nextCursor, maxBytes: 1024, maxEvents: 10 });
    expect(read2.ok).toBe(true);
    if (!read2.ok) throw new Error('expected ok');
    expect(read2.events).toEqual([]);
    expect(read2.nextCursor).toBe(1);
  });

  it('emits a gap event when the cursor is too old', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 2 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData('a');
    pty.emitData('b');
    pty.emitData('c');

    const read = manager.read({ terminalId: ensured.terminalId, cursor: 0, maxBytes: 1024, maxEvents: 10 });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected ok');
    expect(read.events).toEqual([
      { t: 'gap', droppedBefore: 1 },
      { t: 'data', data: 'b' },
      { t: 'data', data: 'c' },
    ]);
    expect(read.nextCursor).toBe(3);
  });

  it('appends an exit event and marks done when caught up', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitExit({ exitCode: 0, signal: 0 });

    const read1 = manager.read({ terminalId: ensured.terminalId, cursor: 0, maxBytes: 1024, maxEvents: 10 });
    expect(read1.ok).toBe(true);
    if (!read1.ok) throw new Error('expected ok');
    expect(read1.events).toEqual([{ t: 'exit', exitCode: 0, signal: 0 }]);
    expect(read1.done).toBe(true);
  });
});

