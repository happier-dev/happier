import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureJavaScriptRuntimeExecutableMock, isBunMock } = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn<() => Promise<string | null>>(async () => process.execPath),
  isBunMock: vi.fn(() => false),
}));

vi.mock('../../../runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('../../../utils/runtime', () => ({
  isBun: isBunMock,
}));

import { maybeReexecToRuntime, resolveRuntimeEntrypointPath } from './runtimeReexec';

afterEach(() => {
  ensureJavaScriptRuntimeExecutableMock.mockReset();
  ensureJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath);
  isBunMock.mockReset();
  isBunMock.mockReturnValue(false);
});

function createExitMock() {
  return vi.fn<(code?: string | number | null) => never>((code?: string | number | null) => {
    return undefined as never;
  });
}

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
  it('execs into the runtime entrypoint when present and not already reexeced', async () => {
    const exec = vi.fn();
    const exit = createExitMock();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');

    await maybeReexecToRuntime({
      cliRootDir: '/repo/apps/cli',
      homeDir: '/home/x/.happier',
      packageName: '@happier-dev/cli',
      argv: ['self', 'check'],
      env: {},
      exec,
      exit,
      exists,
      readVersion,
    });

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({ isBunRuntime: false });
    expect(exec).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['/home/x/.happier/runtime/node_modules/@happier-dev/cli/dist/index.mjs', 'self', 'check']),
      expect.any(Object),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not exec into runtime when runtime version is not newer', async () => {
    const exec = vi.fn();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '1.0.0' : '9.9.9');

    await maybeReexecToRuntime({
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
    expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
  });

  it('propagates child exit status when exec throws', async () => {
    const exec = vi.fn(() => {
      const err: any = new Error('child failed');
      err.status = 17;
      throw err;
    });
    const exit = createExitMock();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');

    await maybeReexecToRuntime({
      cliRootDir: '/repo/apps/cli',
      homeDir: '/home/x/.happier',
      packageName: '@happier-dev/cli',
      argv: ['self', 'check'],
      env: {},
      exec,
      exit,
      exists,
      readVersion,
    });

    expect(exit).toHaveBeenCalledWith(17);
  });

  it('uses the ensured JavaScript runtime instead of process.execPath under Bun', async () => {
    const exec = vi.fn();
    const exit = createExitMock();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');
    isBunMock.mockReturnValue(true);
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');

    await maybeReexecToRuntime({
      cliRootDir: '/repo/apps/cli',
      homeDir: '/home/x/.happier',
      packageName: '@happier-dev/cli',
      argv: ['self', 'check'],
      env: {},
      exec,
      exit,
      exists,
      readVersion,
    });

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({ isBunRuntime: true });
    expect(exec).toHaveBeenCalledWith(
      '/managed/js-runtime',
      expect.arrayContaining(['/home/x/.happier/runtime/node_modules/@happier-dev/cli/dist/index.mjs', 'self', 'check']),
      expect.any(Object),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('fails closed when bun cannot resolve a JavaScript runtime for reexec', async () => {
    const exec = vi.fn();
    const exit = createExitMock();
    const exists = (path: string) => path.endsWith('/runtime/node_modules/@happier-dev/cli/dist/index.mjs');
    const readVersion = (path: string) => (path.includes('/runtime/') ? '9.9.9' : '1.0.0');
    isBunMock.mockReturnValue(true);
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue(null);

    await maybeReexecToRuntime({
      cliRootDir: '/repo/apps/cli',
      homeDir: '/home/x/.happier',
      packageName: '@happier-dev/cli',
      argv: ['self', 'check'],
      env: {},
      exec,
      exit,
      exists,
      readVersion,
    });

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({ isBunRuntime: true });
    expect(exec).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
