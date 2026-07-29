import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyProcess, PtyProvider, PtySpawnParams } from '@/terminal/pty/provider';

class FakePty implements PtyProcess {
  readonly pid = 4321;
  write(): void { }
  resize(): void { }
  kill(): void { }
  onData(_listener: (data: string) => void): { dispose: () => void } { return { dispose: () => { } }; }
  onExit(_listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose: () => void } {
    return { dispose: () => { } };
  }
}

class FakePtyProvider implements PtyProvider {
  public readonly spawned: PtySpawnParams[] = [];

  spawn(params: PtySpawnParams): PtyProcess {
    this.spawned.push(params);
    return new FakePty();
  }
}

class FakeInteractivePty implements PtyProcess {
  readonly pid = 4343;
  readonly writes: string[] = [];
  private readonly onDataBytesListeners = new Set<(data: Buffer | string) => void>();
  private pendingLine = '';

  write(data: string): void {
    const chunk = String(data);
    this.writes.push(chunk);
    this.pendingLine += chunk.replace(/\r/g, '\n');
    if (!this.pendingLine.includes('\n')) {
      return;
    }

    const [line, ...rest] = this.pendingLine.split('\n');
    this.pendingLine = rest.join('\n');
    this.emitBytes(Buffer.from(`ran:${line.trim()}\r\n`, 'utf8'));
  }

  resize(): void { }
  kill(): void { }
  onData(_listener: (data: string) => void): { dispose: () => void } { return { dispose: () => { } }; }
  onDataBytes(listener: (data: Buffer | string) => void): { dispose: () => void } {
    this.onDataBytesListeners.add(listener);
    return {
      dispose: () => {
        this.onDataBytesListeners.delete(listener);
      },
    };
  }
  onExit(_listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose: () => void } {
    return { dispose: () => { } };
  }

  private emitBytes(data: Buffer): void {
    for (const listener of this.onDataBytesListeners) {
      listener(data);
    }
  }
}

class FakeInteractivePtyProvider implements PtyProvider {
  public readonly spawned: Array<{ params: PtySpawnParams; pty: FakeInteractivePty }> = [];

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakeInteractivePty();
    this.spawned.push({ params, pty });
    return pty;
  }
}

describe('registerMachineTerminalRpcHandlers', () => {
  it('fails closed when explicitly disabled', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '0' },
        workingDirectory: process.cwd(),
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_disabled',
      error: 'terminal_disabled',
    });
  });

  it('spawns a PTY session by default when cwd is allowed', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    const subDir = join(rootDir, 'subdir');
    await mkdir(rootDir, { recursive: true });
    await mkdir(subDir, { recursive: true });
    const realSubDir = await realpath(subDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: 'subdir', cols: 90, rows: 30 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realSubDir);
  });

  it('spawns a PTY session outside the default directory when unrestricted', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    const externalDir = join(suiteDir, 'external');
    await mkdir(rootDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });
    const realExternalDir = await realpath(externalDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: externalDir, cols: 90, rows: 30 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realExternalDir);
  });

  it('resolves a typed session-attach launch into PTY executable argv', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-attach-'));
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, (params: any) => Promise<any>>();
    registerMachineTerminalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
      } as unknown as RpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: suiteDir,
        sessionManager,
        resolveLaunch: () => ({ file: '/opt/happier/bin/happier', args: ['attach', 'session-1'] }),
      },
    });

    await expect(registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
      terminalKey: 'dialog-attach:session-1',
      cwd: suiteDir,
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    })).resolves.toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned[0]).toMatchObject({
      file: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
    });
  });

  it('rejects cwd outside the machine working directory', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        accessPolicy: { kind: 'restrictedRoots', roots: [rootDir] },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cwd: '/etc', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });
  });

  it('bridges byte-stream reads to the daemon substrate when available', async () => {
    const sessionManager = {
      readByteStream: async (input: unknown) => ({
        ok: true,
        terminalId: 'term-1',
        frames: [],
        nextByteOffset: 10,
        availableByteOffset: 10,
        droppedBeforeByteOffset: 0,
        done: false,
        input,
      }),
    };
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: process.cwd(),
        sessionManager: sessionManager as unknown as TerminalPtySessionManager & typeof sessionManager,
      },
    });

    const readBytes = registered.get('daemon.terminal.stream.readBytes');
    expect(readBytes).toBeDefined();

    await expect(readBytes!({ terminalId: 'term-1', byteOffset: 0, maxBytes: 4096, maxFrames: 8 }))
      .resolves.toEqual(expect.objectContaining({
        ok: true,
        terminalId: 'term-1',
        nextByteOffset: 10,
      }));
  });

  it('accepts stream input through RPC and exposes resulting PTY output via byte-stream reads', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    const sendInput = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT);
    const readBytes = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    expect(ensure).toBeDefined();
    expect(sendInput).toBeDefined();
    expect(readBytes).toBeDefined();

    const ensured = await ensure!({ terminalKey: 'k-rpc-roundtrip', cwd: rootDir, cols: 80, rows: 24 });
    expect(ensured).toEqual(expect.objectContaining({ ok: true, reused: false }));
    if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
      throw new Error('expected terminal ensure to succeed');
    }
    const terminalId = String(ensured.terminalId);

    await expect(sendInput!({
      terminalId,
      event: { t: 'text', text: 'printf terminal-marker' },
    })).resolves.toEqual({ ok: true });
    await expect(sendInput!({
      terminalId,
      event: { t: 'key', key: 'Enter', modifiers: [] },
    })).resolves.toEqual({ ok: true });

    expect(provider.spawned[0]?.pty.writes).toEqual(['printf terminal-marker', '\r']);

    const read = TerminalStreamReadResponseSchema.parse(await readBytes!({
      terminalId,
      byteOffset: 0,
      maxBytes: 4096,
      maxFrames: 8,
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected byte stream read to succeed');

    const byteFrames = read.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
    const decoded = Buffer.concat(byteFrames.map((frame) => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString('utf8');
    expect(decoded).toContain('ran:printf terminal-marker');
  });

  it('returns structured byte-stream unavailable fallback when the daemon substrate is still legacy-only', async () => {
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: process.cwd(),
        sessionManager: {
          read: async () => ({ ok: true, terminalId: 'term-1', events: [], nextCursor: 0, done: false }),
        } as unknown as TerminalPtySessionManager,
      },
    });

    const readBytes = registered.get('daemon.terminal.stream.readBytes');
    expect(readBytes).toBeDefined();

    await expect(readBytes!({ terminalId: 'term-1', byteOffset: 0 })).resolves.toEqual({
      ok: false,
      code: 'terminal_byte_stream_unavailable',
      message: 'Terminal byte stream is not available on this daemon.',
    });
  });

  it('converts legacy input errors to stream input response errors', async () => {
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: process.cwd(),
        sessionManager: {
          input: async () => ({ ok: false, errorCode: 'terminal_not_found', error: 'terminal_not_found' }),
        } as unknown as TerminalPtySessionManager,
      },
    });

    const sendInput = registered.get('daemon.terminal.stream.input');
    expect(sendInput).toBeDefined();

    await expect(sendInput!({
      terminalId: 'term-1',
      event: { t: 'text', text: 'ls\n' },
    })).resolves.toEqual({
      ok: false,
      code: 'terminal_not_found',
      message: 'terminal_not_found',
    });
  });

  it('uses the shared terminal input encoder for legacy manager stream-input fallback', async () => {
    const input = vi.fn(async () => ({ ok: true as const }));
    const resize = vi.fn(async () => ({ ok: true as const }));
    const registered = new Map<string, (params: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: process.cwd(),
        sessionManager: {
          input,
          resize,
        } as unknown as TerminalPtySessionManager,
      },
    });

    const sendInput = registered.get('daemon.terminal.stream.input');
    expect(sendInput).toBeDefined();

    await expect(sendInput!({
      terminalId: 'term-1',
      event: { t: 'paste', text: 'a\nb', bracketed: true },
    })).resolves.toEqual({ ok: true });
    await expect(sendInput!({
      terminalId: 'term-1',
      event: { t: 'key', key: 'Enter', modifiers: [] },
    })).resolves.toEqual({ ok: true });
    await expect(sendInput!({
      terminalId: 'term-1',
      event: { t: 'mouse', kind: 'down', button: 0, x: 1, y: 1, modifiers: [] },
    })).resolves.toEqual({
      ok: false,
      code: 'terminal_input_unsupported',
      message: 'terminal_input_unsupported',
    });

    expect(input).toHaveBeenNthCalledWith(1, { terminalId: 'term-1', data: '\u001b[200~a\rb\u001b[201~' });
    expect(input).toHaveBeenNthCalledWith(2, { terminalId: 'term-1', data: '\r' });
    expect(resize).not.toHaveBeenCalled();
  });
});
