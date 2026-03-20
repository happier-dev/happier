import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PtyProcess } from './ptyProvider';

function createFakeProcess(): PtyProcess {
  return {
    write: () => { },
    resize: () => { },
    kill: () => { },
    onData: () => ({ dispose: () => { } }),
    onExit: () => ({ dispose: () => { } }),
  };
}

async function loadProviderWithModules(
  modules: Record<string, unknown>,
  createOptions?: Parameters<(typeof import('./ptyProvider'))['createNodePtyProvider']>[0],
) {
  vi.resetModules();
  const debug = vi.fn();
  vi.doMock('node:module', () => ({
    createRequire: () => {
      return (id: string) => {
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

  const { createNodePtyProvider } = await import('./ptyProvider');
  return {
    provider: createNodePtyProvider(createOptions),
    debug,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unmock('node:module');
});

describe('createNodePtyProvider', () => {
  it('uses the compiled binary path as the require base inside embedded bun bundles', async () => {
    vi.resetModules();
    const { resolvePtyProviderRequireBase } = await import('./ptyProvider');
    expect(
      resolvePtyProviderRequireBase({
        importMetaUrl: 'file:///$bunfs/root/happier',
        currentExecPath: '/Applications/Happier.app/Contents/MacOS/happier',
      }),
    ).toBe('/Applications/Happier.app/Contents/MacOS/happier');
  });

  it('keeps the module url as the require base for source-mode runs', async () => {
    vi.resetModules();
    const { resolvePtyProviderRequireBase } = await import('./ptyProvider');
    expect(
      resolvePtyProviderRequireBase({
        importMetaUrl: 'file:///Users/tester/dev/apps/cli/dist/daemon/terminalPty/ptyProvider.js',
        currentExecPath: '/usr/local/bin/node',
      }),
    ).toBe('file:///Users/tester/dev/apps/cli/dist/daemon/terminalPty/ptyProvider.js');
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

  it('falls back to homebridge when node-pty spawn throws', async () => {
    const pty = createFakeProcess();
    const nodePty = { spawn: vi.fn(() => { throw new Error('boom'); }) };
    const homebridge = { spawn: vi.fn(() => pty) };

    const { provider } = await loadProviderWithModules({
      'node-pty': nodePty,
      '@homebridge/node-pty-prebuilt-multiarch': homebridge,
    });

    const spawned = provider.spawn({ file: '/bin/bash', args: [], options: {} });

    expect(spawned).toBe(pty);
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

    expect(spawned).toBe(pty);
    expect(homebridge.spawn).toHaveBeenCalledTimes(1);
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
});
