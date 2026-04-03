import { existsSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNodeBackedMcpServerCommand } from './resolveNodeBackedMcpServerCommand';
import { resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

const { requireJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('@/projectPath', () => ({
  projectPath: () => '/repo',
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  resolveTsxImportHookPath: vi.fn(() => '/repo/node_modules/tsx/dist/esm/index.mjs'),
  resolveCliTsxTsconfigPath: vi.fn(() => '/repo/tsconfig.json'),
}));

vi.mock('@/runtime/js/requireJavaScriptRuntimeExecutable', () => ({
  requireJavaScriptRuntimeExecutable: requireJavaScriptRuntimeExecutableMock,
}));

describe('resolveNodeBackedMcpServerCommand', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(existsSync).mockReturnValue(false);
    requireJavaScriptRuntimeExecutableMock.mockReset();
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('falls back to the tsx source entrypoint when the dist entrypoint is missing', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/dist/mcp/launchers/stdioMcpServerLauncher.mjs')) return false;
      if (path.endsWith('/src/mcp/launchers/stdioMcpServerLauncher.ts')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
        sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'],
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '--import',
        '/repo/node_modules/tsx/dist/esm/index.mjs',
        '/repo/src/mcp/launchers/stdioMcpServerLauncher.ts',
      ],
      env: {
        TSX_TSCONFIG_PATH: '/repo/tsconfig.json',
      },
    });
  });

  it('prefers the package-dist entrypoint when it exists', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/package-dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
        args: ['--url', 'http://127.0.0.1:4010/'],
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/package-dist/mcp/bridges/remoteMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:4010/',
      ],
    });
  });

  it('prefers the source entrypoint when explicitly requested even if package-dist exists', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/package-dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return true;
      if (path.endsWith('/src/mcp/bridges/remoteMcpStdioBridge.ts')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
        preferSourceEntrypoint: true,
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '--import',
        '/repo/node_modules/tsx/dist/esm/index.mjs',
        '/repo/src/mcp/bridges/remoteMcpStdioBridge.ts',
      ],
      env: {
        TSX_TSCONFIG_PATH: '/repo/tsconfig.json',
      },
    });
  });

  it('falls back to the dist entrypoint when package-dist is missing', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/package-dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return false;
      if (path.endsWith('/dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
      }),
    ).resolves.toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/dist/mcp/bridges/remoteMcpStdioBridge.mjs',
      ],
    });
  });

  it('uses the ensured JavaScript runtime when the current process cannot directly execute JS entrypoints', async () => {
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
      }),
    ).resolves.toEqual({
      command: '/managed/js-runtime',
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/dist/mcp/bridges/remoteMcpStdioBridge.mjs',
      ],
    });
  });

  it('fails closed when no JavaScript runtime is available for the entrypoint', async () => {
    requireJavaScriptRuntimeExecutableMock.mockRejectedValue(new ReferenceError('Set HAPPIER_JS_RUNTIME_PATH'));
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
      }),
    ).rejects.toThrow(/HAPPIER_JS_RUNTIME_PATH/);
  });

  it('fails closed when neither a packaged entrypoint nor a TSX source entrypoint is available', async () => {
    vi.mocked(resolveTsxImportHookPath).mockReturnValue(null);
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike);
      if (path.endsWith('/package-dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return false;
      if (path.endsWith('/dist/mcp/bridges/remoteMcpStdioBridge.mjs')) return false;
      if (path.endsWith('/src/mcp/bridges/remoteMcpStdioBridge.ts')) return true;
      return false;
    });

    await expect(
      resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
        sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
      }),
    ).rejects.toThrow(/remoteMcpStdioBridge/);
  });
});
