import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '@/daemon/terminalPty/terminalPtySessionManager';
import type { PtyProcess, PtyProvider, PtySpawnParams } from '@/daemon/terminalPty/ptyProvider';

class FakePty implements PtyProcess {
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

    await expect(ensure!({ terminalKey: 'k', cwd: '/etc', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });
  });
});
