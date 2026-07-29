import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PtyProcess } from './provider';

function createFakeProcess(pid = 4321): PtyProcess {
  return {
    pid,
    write: () => { },
    resize: () => { },
    kill: () => { },
    onData: () => ({ dispose: () => { } }),
    onExit: () => ({ dispose: () => { } }),
  };
}

function createEmittingFakeProcess(): PtyProcess & { emitData: (chunk: string | Buffer) => void } {
  const listeners = new Set<(chunk: string | Buffer) => void>();
  return {
    pid: 4321,
    write: () => { },
    resize: () => { },
    kill: () => { },
    onData: (listener) => {
      listeners.add(listener as (chunk: string | Buffer) => void);
      return {
        dispose: () => {
          listeners.delete(listener as (chunk: string | Buffer) => void);
        },
      };
    },
    onExit: () => ({ dispose: () => { } }),
    emitData: (chunk) => {
      for (const listener of listeners) {
        listener(chunk);
      }
    },
  };
}

function createThisSensitiveFakeProcess(): PtyProcess {
  const nativeProcess = {
    pid: 5678,
    write(this: unknown): void {
      if (this !== nativeProcess) {
        throw new Error('write lost native this binding');
      }
    },
    resize(this: unknown): void {
      if (this !== nativeProcess) {
        throw new Error('resize lost native this binding');
      }
    },
    kill(this: unknown): void {
      if (this !== nativeProcess) {
        throw new Error('kill lost native this binding');
      }
    },
    onData: () => ({ dispose: () => { } }),
    onExit: () => ({ dispose: () => { } }),
  } satisfies PtyProcess;
  return nativeProcess;
}

class FakeNativePtyProcess extends EventEmitter implements PtyProcess {
  readonly pid = 13579;
  readonly _agent?: {
    readonly inSocket: EventEmitter;
    readonly outSocket: EventEmitter;
  };
  readonly _close = vi.fn();
  readonly #writeError: unknown;

  constructor(params?: Readonly<{ includeWindowsSockets?: boolean; writeError?: unknown }>) {
    super();
    this.#writeError = params?.writeError;
    if (params?.includeWindowsSockets) {
      this._agent = {
        inSocket: new EventEmitter(),
        outSocket: new EventEmitter(),
      };
    }
  }

  write(): void {
    if (this.#writeError) throw this.#writeError;
  }
  resize(): void { }
  kill(): void { }
  onData(): ReturnType<PtyProcess['onData']> { return { dispose: () => { } }; }
  onExit(): ReturnType<PtyProcess['onExit']> { return { dispose: () => { } }; }
}

async function loadProviderWithModules(
  modules: Record<string, unknown>,
  createOptions?: Parameters<(typeof import('./provider'))['createNodePtyProvider']>[0],
  packageJsonByPath?: Record<string, unknown>,
) {
  vi.resetModules();
  const debug = vi.fn();
  const requireCalls: string[] = [];
  if (packageJsonByPath) {
    vi.doMock('node:fs', () => ({
      readFileSync: (path: string) => {
        if (!(path in packageJsonByPath)) {
          throw new Error(`missing file: ${path}`);
        }
        return JSON.stringify(packageJsonByPath[path]);
      },
    }));
  }
  vi.doMock('node:module', () => ({
    createRequire: () => {
      return (id: string) => {
        requireCalls.push(id);
        if (!(id in modules)) {
          throw new Error(`missing module: ${id}`);
        }
        return modules[id];
      };
    },
  }));
  vi.doMock('@/ui/logger', () => ({
    logger: {
      debug,
    },
  }));

  const { createNodePtyProvider } = await import('./provider');
  return {
    provider: createNodePtyProvider(createOptions),
    debug,
    requireCalls,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unmock('node:module');
  vi.unmock('node:fs');
  vi.unmock('./nodeRelay');
});

describe('createNodePtyProvider', () => {
  it('uses the compiled binary path as the require base inside embedded bun bundles', async () => {
    vi.resetModules();
    const { resolvePtyProviderRequireBase } = await import('./provider');
    expect(
      resolvePtyProviderRequireBase({
        importMetaUrl: 'file:///$bunfs/root/happier',
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
      }),
    ).toBe('/Applications/Happier.app/Contents/MacOS/happier');
  });

  it('keeps the module url as the require base for source-mode runs', async () => {
    vi.resetModules();
    const { resolvePtyProviderRequireBase } = await import('./provider');
    expect(
      resolvePtyProviderRequireBase({
        importMetaUrl: 'file:///Users/tester/dev/apps/cli/dist/terminal/pty/provider.js',
        currentExecPath: '/usr/local/bin/node',
      }),
    ).toBe('file:///Users/tester/dev/apps/cli/dist/terminal/pty/provider.js');
  });

  it('uses the real packaged entrypoint as the require base for embedded Windows child processes', async () => {
    vi.resetModules();
    const { resolvePtyProviderRequireBase } = await import('./provider');
    expect(
      resolvePtyProviderRequireBase({
        importMetaUrl: 'file:///B:/%7EBUN/root/happier.exe',
        currentExecPath: 'C:\\Program Files\\Bun\\bun.exe',
        argv: [
          'bun',
          'B:/~BUN/root/happier.exe',
          'C:\\Users\\test\\happier-v0.2.10-windows-x64\\package-dist\\index.mjs',
          'claude',
          '--happy-starting-mode',
          'remote',
          '--started-by',
          'daemon',
        ],
      }).replaceAll('\\', '/'),
    ).toBe('C:/Users/test/happier-v0.2.10-windows-x64/package-dist/index.mjs');
  });

  it('prefers node-pty when available', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };
    const homebridge = { spawn: vi.fn(() => pty) };

    const { provider, debug } = await loadProviderWithModules({
      'node-pty': nodePty,
      '@homebridge/node-pty-prebuilt-multiarch': homebridge,
    });

    provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(nodePty.spawn).toHaveBeenCalledTimes(1);
    expect(homebridge.spawn).toHaveBeenCalledTimes(0);
    expect(debug).toHaveBeenCalledWith(
      '[terminal-pty] backend resolution',
      expect.objectContaining({
        preferredBackend: 'node-pty',
        secondaryBackend: '@homebridge/node-pty-prebuilt-multiarch',
      }),
    );
  });

  it('forwards the native PTY pid so spawned processes can be registered', async () => {
    const pty = createFakeProcess(24680);
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned.pid).toBe(24680);
  });

  it('preserves native PTY method bindings for backends that depend on this context', async () => {
    const pty = createThisSensitiveFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(() => spawned.write('echo ok\n')).not.toThrow();
    expect(() => spawned.resize(80, 24)).not.toThrow();
    expect(() => spawned.kill()).not.toThrow();
  });

  it('exposes raw byte listeners when native PTY output is byte-capable', async () => {
    const pty = createEmittingFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: { encoding: null } });
    const byteCapable = spawned as typeof spawned & {
      onDataBytes?: (listener: (chunk: Buffer) => void) => { dispose: () => void };
    };
    const onBytes = vi.fn();

    expect(typeof byteCapable.onDataBytes).toBe('function');
    byteCapable.onDataBytes?.(onBytes);
    pty.emitData(Buffer.from([0x00, 0xff, 0x61]));

    expect(onBytes).toHaveBeenCalledWith(Buffer.from([0x00, 0xff, 0x61]));
  });

  it('prefers node-pty on Windows because the homebridge package does not ship Windows conpty prebuilds', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };
    const homebridge = { spawn: vi.fn(() => pty) };

    const { provider, debug } = await loadProviderWithModules({
      'node-pty': nodePty,
      '@homebridge/node-pty-prebuilt-multiarch': homebridge,
    }, {
      platform: 'win32',
      fallbackProvider: null,
    });

    provider.spawn({ file: 'cmd.exe', args: [], options: {} });

    expect(nodePty.spawn).toHaveBeenCalledTimes(1);
    expect(homebridge.spawn).toHaveBeenCalledTimes(0);
    expect(debug).toHaveBeenCalledWith(
      '[terminal-pty] backend resolution',
      expect.objectContaining({
        preferredBackend: 'node-pty',
        secondaryBackend: '@homebridge/node-pty-prebuilt-multiarch',
      }),
    );
  });

  it('suppresses node-pty Windows socket errors at the native provider boundary', async () => {
    const pty = new FakeNativePtyProcess({ includeWindowsSockets: true });
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    }, {
      platform: 'win32',
      fallbackProvider: null,
    });

    const spawned = provider.spawn({ file: 'cmd.exe', args: [], options: {} });

    expect(spawned).toMatchObject({
      write: expect.any(Function),
      resize: expect.any(Function),
      kill: expect.any(Function),
      onData: expect.any(Function),
      onDataBytes: expect.any(Function),
      onExit: expect.any(Function),
    });
    expect(() => pty._agent?.inSocket.emit('error', new Error('Socket is closed')))
      .not.toThrow();
    expect(() => pty._agent?.outSocket.emit('error', new Error('Socket is closed')))
      .not.toThrow();
  });

  it('does not suppress non-socket Windows PTY errors at the native provider boundary', async () => {
    const pty = new FakeNativePtyProcess({ includeWindowsSockets: true });
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    }, {
      platform: 'win32',
      fallbackProvider: null,
    });

    provider.spawn({ file: 'cmd.exe', args: [], options: {} });

    const ptyError = new Error('provider-level fatal');
    const inputError = new Error('input provider fatal');
    const outputError = new Error('output provider fatal');

    expect(() => pty.emit('error', ptyError)).toThrow(ptyError);
    expect(() => pty._agent?.inSocket.emit('error', inputError)).toThrow(inputError);
    expect(() => pty._agent?.outSocket.emit('error', outputError)).toThrow(outputError);
  });

  it('does not synthesize socket cleanup for non-socket Windows PTY write errors', async () => {
    const fatal = new Error('provider write fatal');
    const pty = new FakeNativePtyProcess({ includeWindowsSockets: true, writeError: fatal });
    const nodePty = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
    }, {
      platform: 'win32',
      fallbackProvider: null,
    });

    const spawned = provider.spawn({ file: 'cmd.exe', args: [], options: {} });

    expect(() => spawned.write('hello')).toThrow(fatal);
    expect(pty._close).not.toHaveBeenCalled();
  });

  it('falls back to homebridge when node-pty spawn throws', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => { throw new Error('boom'); }) };
    const homebridge = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
      '@homebridge/node-pty-prebuilt-multiarch': homebridge,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toMatchObject({
      write: expect.any(Function),
      resize: expect.any(Function),
      kill: expect.any(Function),
      onData: expect.any(Function),
      onDataBytes: expect.any(Function),
      onExit: expect.any(Function),
    });
    expect(nodePty.spawn).toHaveBeenCalledTimes(1);
    expect(homebridge.spawn).toHaveBeenCalledTimes(1);
  });

  it('uses homebridge when node-pty is missing', async () => {
    const pty = createFakeProcess();
    const homebridge = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      '@homebridge/node-pty-prebuilt-multiarch': homebridge,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toMatchObject({
      write: expect.any(Function),
      resize: expect.any(Function),
      kill: expect.any(Function),
      onData: expect.any(Function),
      onDataBytes: expect.any(Function),
      onExit: expect.any(Function),
    });
    expect(homebridge.spawn).toHaveBeenCalledTimes(1);
  });

  it('tries packaged absolute module paths when bare PTY module resolution misses', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };
    const absoluteNodePty = 'C:/Users/test/happier-v0.2.10-windows-x64/node_modules/node-pty';

    const { provider, requireCalls } = await loadProviderWithModules({
      [absoluteNodePty]: nodePty,
    }, {
      argv: [
        'bun',
        'B:/~BUN/root/happier.exe',
        'C:\\Users\\test\\happier-v0.2.10-windows-x64\\package-dist\\index.mjs',
        'claude',
      ],
      platform: 'win32',
      fallbackProvider: null,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toMatchObject({ write: expect.any(Function) });
    expect(requireCalls).toEqual(expect.arrayContaining([
      'node-pty',
      absoluteNodePty,
    ]));
  });

  it('tries packaged package entry files when Bun cannot resolve absolute package directories', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };
    const packageDir = 'C:/Users/test/happier-v0.2.10-windows-x64/node_modules/node-pty';
    const packageEntry = 'C:/Users/test/happier-v0.2.10-windows-x64/node_modules/node-pty/lib/index.js';

    const { provider, requireCalls } = await loadProviderWithModules({
      [packageEntry]: nodePty,
    }, {
      argv: [
        'bun',
        'B:/~BUN/root/happier.exe',
        'C:\\Users\\test\\happier-v0.2.10-windows-x64\\package-dist\\index.mjs',
        'claude',
      ],
      platform: 'win32',
      fallbackProvider: null,
    }, {
      [`${packageDir}/package.json`]: { main: './lib/index.js' },
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toMatchObject({ write: expect.any(Function) });
    expect(requireCalls).toEqual(expect.arrayContaining([
      'node-pty',
      packageDir,
      packageEntry,
    ]));
  });

  it('tries packaged module paths next to the self-contained Windows executable', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => pty) };
    const packageDir = 'C:/Users/test/happier-v0.2.10-windows-x64/node_modules/node-pty';

    const { provider, requireCalls } = await loadProviderWithModules({
      [packageDir]: nodePty,
    }, {
      currentExecPath: 'C:\\Users\\test\\happier-v0.2.10-windows-x64\\happier.exe',
      argv: [
        'C:\\Users\\test\\happier-v0.2.10-windows-x64\\happier.exe',
        'claude',
        '--happy-starting-mode',
        'remote',
      ],
      platform: 'win32',
      fallbackProvider: null,
    });

    const spawned = provider.spawn({ file: 'cmd.exe', args: [], options: {} });

    expect(spawned).toMatchObject({ write: expect.any(Function) });
    expect(requireCalls).toEqual(expect.arrayContaining([
      'node-pty',
      packageDir,
    ]));
  });

  it('uses the injected fallback when native pty modules are unavailable', async () => {
    const pty = createFakeProcess();
    const fallbackProvider = { spawn: vi.fn(() => pty) };
    const { provider, debug } = await loadProviderWithModules({}, { fallbackProvider, fallbackBackendName: 'test-fallback' });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toBe(pty);
    expect(fallbackProvider.spawn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      '[terminal-pty] falling back to external PTY backend because native providers are unavailable',
      expect.objectContaining({
        fallbackBackend: 'test-fallback',
      }),
    );
  });

  it('throws a clear error when no implementation is available', async () => {
    const { provider } = await loadProviderWithModules({}, { platform: 'win32', fallbackProvider: null });

    expect(() => provider.spawn({ file: '/bin/bash', args: [], options: {} }))
      .toThrowError(new Error('terminal_pty_provider_missing'));
  });

  it('uses the managed Node relay fallback on Windows when native providers are unavailable', async () => {
    vi.resetModules();
    const relayProcess = createFakeProcess();
    const relayProvider = { spawn: vi.fn(() => relayProcess) };
    const createNodePtyRelayProvider = vi.fn(() => relayProvider);
    vi.doMock('node:module', () => ({
      createRequire: () => {
        return () => {
          throw new Error('missing native PTY');
        };
      },
    }));
    vi.doMock('./nodeRelay', () => ({
      createNodePtyRelayProvider,
    }));
    vi.doMock('@/ui/logger', () => ({
      logger: {
        debug: vi.fn(),
      },
    }));

    const { createNodePtyProvider } = await import('./provider');
    const provider = createNodePtyProvider({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32' },
      currentExecPath: 'C:\\happier\\happier.exe',
    });

    const spawned = provider.spawn({ file: 'cmd.exe', args: ['/c', 'echo ok'], options: {} });

    expect(spawned).toBe(relayProcess);
    expect(createNodePtyRelayProvider).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'win32',
      currentExecPath: 'C:\\happier\\happier.exe',
    }));
    expect(relayProvider.spawn).toHaveBeenCalledWith({ file: 'cmd.exe', args: ['/c', 'echo ok'], options: {} });
  });
});
