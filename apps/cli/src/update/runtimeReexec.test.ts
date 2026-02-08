import { describe, expect, it, vi } from 'vitest';

import { maybeReexecToRuntime, resolveRuntimeEntrypointPath } from './runtimeReexec';

describe('resolveRuntimeEntrypointPath', () => {
  it('resolves a dist entrypoint under runtime/node_modules', () => {
    expect(
      resolveRuntimeEntrypointPath({ homeDir: '/home/x/.happier', packageName: '@happier-dev/cli' }),
    ).toBe('/home/x/.happier/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
  });

  it('throws when packageName is empty', () => {
    expect(() => resolveRuntimeEntrypointPath({ homeDir: '/home/x/.happier', packageName: '   ' })).toThrow(
      /packageName is required/i,
    );
  });
});

describe('maybeReexecToRuntime', () => {
  it('execs into the runtime entrypoint when present and not already reexeced', () => {
    const exec = vi.fn();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    try {
      expect(() =>
        maybeReexecToRuntime({
          cliRootDir: '/repo/apps/cli',
          homeDir: '/home/x/.happier',
          packageName: '@happier-dev/cli',
          argv: ['self', 'check'],
          env: {},
          exec,
          exists,
          readVersion,
        }),
      ).toThrow('exit:0');

      expect(exec).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(['/home/x/.happier/runtime/node_modules/@happier-dev/cli/dist/index.mjs', 'self', 'check']),
        expect.any(Object),
      );
      const execOpts = exec.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(execOpts?.cwd).toBeUndefined();
    } finally {
      exit.mockRestore();
    }
  });

  it('does not exec into runtime when runtime version is not newer', () => {
    const exec = vi.fn();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '1.0.0' : '9.9.9');

    maybeReexecToRuntime({
      cliRootDir: '/repo/apps/cli',
      homeDir: '/home/x/.happier',
      packageName: '@happier-dev/cli',
      argv: ['self', 'check'],
      env: {},
      exec,
      exists,
      readVersion,
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it('propagates child exit status when exec throws', () => {
    const exec = vi.fn(() => {
      const err: any = new Error('child failed');
      err.status = 17;
      throw err;
    });
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    try {
      expect(() =>
        maybeReexecToRuntime({
          cliRootDir: '/repo/apps/cli',
          homeDir: '/home/x/.happier',
          packageName: '@happier-dev/cli',
          argv: ['self', 'check'],
          env: {},
          exec,
          exists,
          readVersion,
        }),
      ).toThrow('exit:17');
    } finally {
      exit.mockRestore();
    }
  });
});
