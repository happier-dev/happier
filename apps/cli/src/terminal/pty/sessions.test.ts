import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
} from '@happier-dev/protocol';

import { createTerminalPtySessionManager, type TerminalPtySessionManagerConfig } from './sessions';
import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './provider';

function createFakeDisposable(): Disposable {
  return { dispose: () => { } };
}

class FakePty implements PtyProcess {
  public readonly pid: number;
  public readonly writes: string[] = [];
  public readonly resizes: Array<Readonly<{ cols: number; rows: number }>> = [];
  private readonly onDataListeners = new Set<(data: string | Buffer) => void>();
  private readonly onExitListeners = new Set<(e: PtyExitEvent) => void>();

  constructor(pid = 4321) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(String(data));
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    // noop
  }

  onData(listener: (data: string) => void): Disposable {
    this.onDataListeners.add(listener as (data: string | Buffer) => void);
    return createFakeDisposable();
  }

  onExit(listener: (e: PtyExitEvent) => void): Disposable {
    this.onExitListeners.add(listener);
    return createFakeDisposable();
  }

  emitData(data: string | Buffer): void {
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

class FakeByteHookPty extends FakePty {
  private readonly onDataBytesListeners = new Set<(data: string | Buffer) => void>();

  onDataBytes(listener: (data: string | Buffer) => void): Disposable {
    this.onDataBytesListeners.add(listener);
    return {
      dispose: () => {
        this.onDataBytesListeners.delete(listener);
      },
    };
  }

  emitByteHookData(data: string | Buffer): void {
    for (const listener of this.onDataBytesListeners) {
      listener(data);
    }
  }
}

class FakeByteHookProvider implements PtyProvider {
  public readonly spawned: Array<{ params: PtySpawnParams; pty: FakeByteHookPty }> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakeByteHookPty();
    this.spawned.push({ params, pty });
    return pty;
  }
}

class FakeResizeUnavailablePty extends FakePty {
  resize(): void {
    throw new Error('terminal_resize_unavailable');
  }
}

class FakeResizeUnavailableProvider implements PtyProvider {
  public readonly spawned: Array<{ params: PtySpawnParams; pty: FakeResizeUnavailablePty }> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakeResizeUnavailablePty();
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
    bufferRetentionMs: 10 * 60_000,
    urlParseBufferLimit: 32_768,
    maxWriteChunkBytes: 16_384,
    defaultCols: 80,
    defaultRows: 24,
    ...overrides,
  };
}

const BASH_ENV: NodeJS.ProcessEnv = { SHELL: '/bin/bash' };

type ByteReadResult =
  | Readonly<{
      ok: true;
      terminalId: string;
      mode: 'bytes';
      chunks: readonly Readonly<{ bytes: Buffer; byteOffset: number; byteLength: number }>[];
      nextByteOffset: number;
      availableByteOffset: number;
      droppedBeforeByteOffset: number;
      done: boolean;
    }>
  | Readonly<{
      ok: true;
      terminalId: string;
      mode: 'legacyOnly';
      provider: string;
      reason: string;
      done: boolean;
    }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type ByteCapableSessionManager = ReturnType<typeof createTerminalPtySessionManager> & {
  readBytes?: (input: Readonly<{ terminalId: string; byteOffset: number; maxBytes: number; maxChunks: number }>) => ByteReadResult;
};

describe('TerminalPtySessionManager', () => {
  it('reuses sessions by terminalKey', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
    });

    const first = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 80, rows: 24 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');

    const second = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 81, rows: 25 });
    expect(second).toEqual({ ok: true, terminalId: first.terminalId, reused: true });
  });

  it('reports resize-unavailable when a reused terminal cannot apply requested dimensions', () => {
    const provider = new FakeResizeUnavailableProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
    });

    const first = manager.ensure({ terminalKey: 'k-resize-reuse', cwd: '/tmp', cols: 80, rows: 24 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');

    expect(manager.ensure({ terminalKey: 'k-resize-reuse', cwd: '/tmp', cols: 100, rows: 40 })).toEqual({
      ok: false,
      errorCode: 'terminal_resize_unavailable',
      error: 'terminal_resize_unavailable',
    });
    expect(provider.spawned).toHaveLength(1);
  });

  it('streams PTY output via cursor reads', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: BASH_ENV,
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

  it('requests raw byte output on byte-capable platforms', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    expect(provider.spawned[0]?.params.options.encoding).toBeNull();
  });

  it('preserves invalid UTF-8 bytes in byte replay', () => {
    const provider = new FakePtyProvider();
    const manager: ByteCapableSessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from([0x61, 0xff, 0x00, 0x62]));

    expect(typeof manager.readBytes).toBe('function');
    const read = manager.readBytes?.({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read).toMatchObject({
      ok: true,
      terminalId: ensured.terminalId,
      mode: 'bytes',
      nextByteOffset: 4,
      availableByteOffset: 4,
      droppedBeforeByteOffset: 0,
    });
    if (!read?.ok || read.mode !== 'bytes') throw new Error('expected byte read');
    expect(Buffer.concat(read.chunks.map((chunk) => chunk.bytes))).toEqual(Buffer.from([0x61, 0xff, 0x00, 0x62]));

    const streamRead = manager.readByteStream({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxFrames: 10 });
    expect(streamRead).toMatchObject({
      ok: true,
      terminalId: ensured.terminalId,
      nextByteOffset: 4,
      availableByteOffset: 4,
      droppedBeforeByteOffset: 0,
      done: false,
    });
  });

  it('includes detected URL control frames in byte-stream reads', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-url', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('Open https://example.com/path\n', 'utf8'));

    const read = manager.readByteStream({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxFrames: 10 });
    expect(read).toMatchObject({ ok: true, terminalId: ensured.terminalId });
    if (!read.ok) throw new Error('expected ok');
    expect(read.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        t: 'url',
        terminalId: ensured.terminalId,
        url: 'https://example.com/path',
        kind: 'generic',
      }),
    ]));
  });

  it('does not lose URL control frames when the first byte-stream read exhausts its frame budget', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-url-budget', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('Open https://example.com/path\n', 'utf8'));

    const firstRead = manager.readByteStream({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxFrames: 1 });
    expect(firstRead).toMatchObject({ ok: true, nextByteOffset: 30 });
    if (!firstRead.ok) throw new Error('expected ok');
    expect(firstRead.frames.map((frame) => frame.t)).toEqual(['bytes']);

    const secondRead = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: firstRead.nextByteOffset,
      maxBytes: 1024,
      maxFrames: 1,
    });
    expect(secondRead).toMatchObject({ ok: true, terminalId: ensured.terminalId });
    if (!secondRead.ok) throw new Error('expected ok');
    expect(secondRead.frames).toEqual([
      expect.objectContaining({
        t: 'url',
        terminalId: ensured.terminalId,
        url: 'https://example.com/path',
        kind: 'generic',
      }),
    ]);
  });

  it('splits protocol-facing byte-stream frames at the decoded frame cap', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxBytes: 1024 * 1024, bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-large-frame', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    const payload = Buffer.alloc(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES + 44 * 1024, 0x61);
    pty.emitData(payload);

    const read = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024 * 1024,
      maxFrames: 10,
    });

    const parsed = TerminalStreamReadResponseSchema.safeParse(read);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const byteFrames = parsed.data.ok ? parsed.data.frames.filter((frame) => frame.t === 'bytes') : [];
    expect(byteFrames.map((frame) => frame.byteLength)).toEqual([
      TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
      44 * 1024,
    ]);
    expect(Buffer.concat(byteFrames.map((frame) => Buffer.from(decodeTerminalStreamBytesFrame(frame)))))
      .toEqual(payload);
  });

  it('limits byte-stream reads by renderer credit', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-credit', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('abcdef', 'utf8'));

    const noCredit = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 0,
    });
    expect(noCredit).toMatchObject({
      ok: true,
      nextByteOffset: 0,
      availableByteOffset: 6,
    });
    if (!noCredit.ok) throw new Error('expected ok');
    expect(noCredit.frames.filter((frame) => frame.t === 'bytes')).toEqual([]);

    const read = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 2,
    });
    expect(read).toMatchObject({
      ok: true,
      nextByteOffset: 2,
      availableByteOffset: 6,
    });
    if (!read.ok) throw new Error('expected ok');
    expect(read.frames).toEqual([
      expect.objectContaining({ t: 'bytes', byteOffset: 0, byteLength: 2 }),
    ]);
  });

  it('keeps live sessions active during zero-credit byte-stream polling', () => {
    let now = 0;
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ idleTimeoutMs: 100 }),
      now: () => now,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-zero-credit-liveness', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('abcdef', 'utf8'));
    now = 50;
    expect(manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 0,
    })).toMatchObject({ ok: true, nextByteOffset: 0 });

    now = 120;
    expect(manager.input({ terminalId: ensured.terminalId, data: 'still attached' })).toEqual({ ok: true });
    expect(pty.writes).toEqual(['still attached']);
  });

  it('delivers byte-stream URL control frames even when byte credit is exhausted', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-url-no-credit', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('Open https://example.com/path\n', 'utf8'));

    const read = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 0,
    });

    expect(read).toMatchObject({
      ok: true,
      nextByteOffset: 0,
      availableByteOffset: 30,
    });
    if (!read.ok) throw new Error('expected ok');
    expect(read.frames).toEqual([
      expect.objectContaining({
        t: 'url',
        terminalId: ensured.terminalId,
        url: 'https://example.com/path',
        kind: 'generic',
      }),
    ]);
  });

  it('delivers byte-stream exit frames when caught up with no byte credit', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-exit-no-credit', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitExit({ exitCode: 7 });

    const read = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 0,
    });

    expect(read).toMatchObject({
      ok: true,
      nextByteOffset: 0,
      availableByteOffset: 0,
      done: true,
    });
    if (!read.ok) throw new Error('expected ok');
    expect(read.frames).toEqual([{
      t: 'exit',
      terminalId: ensured.terminalId,
      byteOffset: 0,
      exitCode: 7,
      signal: null,
    }]);
  });

  it('keeps byte-stream reads open when the exit frame is deferred by the frame budget', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-exit-budget', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('a', 'utf8'));
    pty.emitExit({ exitCode: 9 });

    const firstRead = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 1,
    });
    expect(firstRead).toMatchObject({
      ok: true,
      nextByteOffset: 1,
      availableByteOffset: 1,
      done: false,
    });
    if (!firstRead.ok) throw new Error('expected ok');
    expect(firstRead.frames).toEqual([
      expect.objectContaining({ t: 'bytes', byteOffset: 0, byteLength: 1 }),
    ]);

    const secondRead = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: firstRead.nextByteOffset,
      maxBytes: 1024,
      maxFrames: 1,
    });
    expect(secondRead).toMatchObject({
      ok: true,
      nextByteOffset: 1,
      availableByteOffset: 1,
      done: true,
    });
    if (!secondRead.ok) throw new Error('expected ok');
    expect(secondRead.frames).toEqual([{
      t: 'exit',
      terminalId: ensured.terminalId,
      byteOffset: 1,
      exitCode: 9,
      signal: null,
    }]);
  });

  it('records renderer ACK lag metrics without moving ACK state backwards', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-ack', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from('abcdef', 'utf8'));

    expect(manager.acknowledgeByteStream({
      terminalId: ensured.terminalId,
      rendererId: 'web',
      surfaceEpoch: 1,
      ackedByteOffset: 2,
    })).toEqual({ ok: true });
    expect(manager.metrics()).toMatchObject({
      acknowledgedByteOffsetHighWater: 2,
      rendererAckLagBytesHighWater: 4,
    });

    expect(manager.acknowledgeByteStream({
      terminalId: ensured.terminalId,
      rendererId: 'web',
      surfaceEpoch: 1,
      ackedByteOffset: 1,
    })).toEqual({ ok: true });
    expect(manager.metrics()).toMatchObject({
      acknowledgedByteOffsetHighWater: 2,
      rendererAckLagBytesHighWater: 4,
    });
  });

  it('reports byte gaps when the byte ring overflows', () => {
    const provider = new FakePtyProvider();
    const manager: ByteCapableSessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxBytes: 4, bufferMaxEvents: 10 }),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitData(Buffer.from([0x01, 0x02, 0x03]));
    pty.emitData(Buffer.from([0x04, 0x05, 0x06]));

    expect(typeof manager.readBytes).toBe('function');
    const read = manager.readBytes?.({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read).toMatchObject({
      ok: true,
      mode: 'bytes',
      availableByteOffset: 6,
      droppedBeforeByteOffset: 3,
    });
    if (!read?.ok || read.mode !== 'bytes') throw new Error('expected byte read');
    expect(Buffer.concat(read.chunks.map((chunk) => chunk.bytes))).toEqual(Buffer.from([0x04, 0x05, 0x06]));
  });

  it('exposes structured legacy-only byte status on Windows', () => {
    const provider = new FakePtyProvider();
    const manager: ByteCapableSessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: 'powershell.exe' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: 'C:\\Users\\tester' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');

    expect(provider.spawned[0]?.params.options.encoding).toBe('utf8');
    expect(typeof manager.readBytes).toBe('function');
    const read = manager.readBytes?.({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read).toMatchObject({
      ok: true,
      terminalId: ensured.terminalId,
      mode: 'legacyOnly',
      provider: 'windows-conpty',
    });
  });

  it('preserves legacy-only byte-stream status even when the renderer has no byte credit', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: 'powershell.exe' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });

    const ensured = manager.ensure({ terminalKey: 'k-legacy-stream', cwd: 'C:\\Users\\tester' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');

    const read = manager.readByteStream({
      terminalId: ensured.terminalId,
      byteOffset: 0,
      maxBytes: 1024,
      maxFrames: 10,
      creditBytes: 0,
    });
    expect(read).toMatchObject({
      ok: true,
      terminalId: ensured.terminalId,
      frames: [
        expect.objectContaining({
          t: 'legacyOnly',
          terminalId: ensured.terminalId,
          provider: 'windows-conpty',
        }),
      ],
    });
  });

  it('fails closed when the PTY provider cannot resize the backing terminal', () => {
    const provider = new FakeResizeUnavailableProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-resize', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');

    expect(manager.resize({ terminalId: ensured.terminalId, cols: 100, rows: 40 })).toEqual({
      ok: false,
      errorCode: 'terminal_resize_unavailable',
      error: 'terminal_resize_unavailable',
    });
  });

  it('applies renderer-neutral input events at the PTY boundary', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-input-event', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'text', text: 'ls' },
    })).toEqual({ ok: true });
    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'paste', text: 'a\nb', bracketed: true },
    })).toEqual({ ok: true });
    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'key', key: 'Enter', modifiers: [] },
    })).toEqual({ ok: true });
    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'key', key: 'c', modifiers: ['ctrl'] },
    })).toEqual({ ok: true });
    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'ime', phase: 'commit', text: 'あ' },
    })).toEqual({ ok: true });
    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'resize', cols: 120, rows: 40 },
    })).toEqual({ ok: true });

    expect(pty.writes).toEqual([
      'ls',
      '\u001b[200~a\rb\u001b[201~',
      '\r',
      '\u0003',
      'あ',
    ]);
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('rejects semantic mouse input instead of writing unsafe escape sequences without renderer mode state', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k-mouse-event', cwd: '/tmp', cols: 80, rows: 24 });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    expect(manager.inputEvent({
      terminalId: ensured.terminalId,
      event: { t: 'mouse', kind: 'down', button: 0, x: 1, y: 1, modifiers: [] },
    })).toEqual({
      ok: false,
      code: 'terminal_input_unsupported',
      message: 'terminal_input_unsupported',
    });
    expect(pty.writes).toEqual([]);
  });

  it('diagnoses decoded byte-hook output as legacy-only instead of treating it as byte-faithful', () => {
    const provider = new FakeByteHookProvider();
    const manager: ByteCapableSessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: { SHELL: '/bin/bash' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitByteHookData('decoded output');

    const read = manager.readBytes?.({ terminalId: ensured.terminalId, byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read).toMatchObject({
      ok: true,
      terminalId: ensured.terminalId,
      mode: 'legacyOnly',
      provider: 'unknown',
    });
  });

  it('suppresses zsh prompt EOL markers in embedded terminal sessions by default', () => {
    const provider = new FakePtyProvider();
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh' };
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env,
      platform: 'darwin',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);

    const spawnedEnv = provider.spawned[0]?.params.options.env;
    expect(provider.spawned[0]?.params.args).toEqual(['-l', '+o', 'prompt_sp']);
    expect(spawnedEnv).toMatchObject({
      SHELL: '/bin/zsh',
      PROMPT_EOL_MARK: '',
    });
    expect(env.PROMPT_EOL_MARK).toBeUndefined();
  });

  it('uses the configured zsh prompt EOL marker override when provided', () => {
    const provider = new FakePtyProvider();
    const env: NodeJS.ProcessEnv = {
      SHELL: '/bin/zsh',
      HAPPIER_DAEMON_TERMINAL_PROMPT_EOL_MARK: 'marker',
    };
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env,
      platform: 'darwin',
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/tmp' });
    expect(ensured.ok).toBe(true);

    expect(provider.spawned[0]?.params.args).toEqual(['-l']);
    expect(provider.spawned[0]?.params.options.env).toMatchObject({
      SHELL: '/bin/zsh',
      HAPPIER_DAEMON_TERMINAL_PROMPT_EOL_MARK: 'marker',
      PROMPT_EOL_MARK: 'marker',
    });
  });

  it('emits a gap event when the cursor is too old', () => {
    const provider = new FakePtyProvider();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig({ bufferMaxEvents: 2 }),
      now: () => 0,
      env: BASH_ENV,
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
      env: BASH_ENV,
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

type RegisterCall = Readonly<{
  terminalKey: string;
  workspacePath: string;
  pids: readonly number[];
  terminalId: string;
  sessionId?: string;
}>;
type UnregisterCall = Readonly<{ terminalKey: string; terminalId: string }>;

function createRecordingRegistry() {
  const registers: RegisterCall[] = [];
  const unregisters: UnregisterCall[] = [];
  return {
    registers,
    unregisters,
    registry: {
      registerTerminalProcesses(input: RegisterCall) {
        registers.push(input);
      },
      unregister(input: UnregisterCall) {
        unregisters.push(input);
      },
      lookupByPid() {
        return null;
      },
    },
  };
}

describe('TerminalPtySessionManager terminal->port registration', () => {
  it('registers spawned pids with workspace + session + terminal attribution', () => {
    const provider = new FakePtyProvider();
    const { registry, registers } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });
    expect(ensured.ok).toBe(true);
    if (!ensured.ok) throw new Error('expected ok');

    expect(registers).toHaveLength(1);
    expect(registers[0]).toMatchObject({
      terminalKey: 'k1',
      workspacePath: '/repo/web',
      pids: [provider.spawned[0]?.pty.pid],
      terminalId: ensured.terminalId,
      sessionId: 'session-a',
    });
  });

  it('omits sessionId from the registration when none is supplied', () => {
    const provider = new FakePtyProvider();
    const { registry, registers } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    manager.ensure({ terminalKey: 'k1', cwd: '/repo/web' });

    expect(registers).toHaveLength(1);
    expect(registers[0]?.sessionId).toBeUndefined();
  });

  it('unregisters identity-checked on close', () => {
    const provider = new FakePtyProvider();
    const { registry, unregisters } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });
    if (!ensured.ok) throw new Error('expected ok');
    manager.close({ terminalId: ensured.terminalId });

    expect(unregisters).toEqual([{ terminalKey: 'k1', terminalId: ensured.terminalId }]);
  });

  it('unregisters identity-checked on self-exit', () => {
    const provider = new FakePtyProvider();
    const { registry, unregisters } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    const ensured = manager.ensure({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });
    if (!ensured.ok) throw new Error('expected ok');
    const pty = provider.spawned[0]?.pty;
    if (!pty) throw new Error('missing fake pty');

    pty.emitExit({ exitCode: 0, signal: 0 });

    expect(unregisters).toEqual([{ terminalKey: 'k1', terminalId: ensured.terminalId }]);
  });

  it('re-registers with a new terminalId on restart (replace-by-key) and unregisters the old run', () => {
    const provider = new FakePtyProvider();
    const { registry, registers, unregisters } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    const first = manager.ensure({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });
    if (!first.ok) throw new Error('expected ok');
    const restarted = manager.restart({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });
    if (!restarted.ok) throw new Error('expected ok');

    expect(restarted.terminalId).not.toBe(first.terminalId);
    // old run unregistered (identity-checked) then new run registered (replace-by-key)
    expect(unregisters).toEqual([{ terminalKey: 'k1', terminalId: first.terminalId }]);
    expect(registers).toHaveLength(2);
    expect(registers[1]).toMatchObject({ terminalKey: 'k1', terminalId: restarted.terminalId });
  });

  it('skips registration when the backend cannot supply a pid', () => {
    class PidlessPty extends FakePty {
      constructor() {
        super(0);
      }
    }
    class PidlessProvider extends FakePtyProvider {
      override spawn(params: PtySpawnParams): PtyProcess {
        const pty = new PidlessPty();
        this.spawned.push({ params, pty });
        return pty;
      }
    }
    const provider = new PidlessProvider();
    const { registry, registers } = createRecordingRegistry();
    const manager = createTerminalPtySessionManager({
      ptyProvider: provider,
      config: defaultConfig(),
      now: () => 0,
      env: BASH_ENV,
      platform: 'linux',
      terminalRegistry: registry,
    });

    manager.ensure({ terminalKey: 'k1', cwd: '/repo/web', sessionId: 'session-a' });

    expect(registers).toHaveLength(0);
  });
});
