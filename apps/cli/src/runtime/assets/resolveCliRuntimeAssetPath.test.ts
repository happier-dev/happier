import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveCliRuntimeAssetPath', () => {
  const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/projectPath');
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
    }
  });

  it('uses the executable directory when running as a self-contained binary', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/runtime/payload/happier',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/runtime/payload/scripts/claude_local_launcher.cjs',
    );
  });

  it('uses the project root when running under a JavaScript runtime', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/usr/local/bin/node',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/repo/apps/cli/scripts/claude_local_launcher.cjs',
    );
  });

  it('uses the installed cli current payload when launched from the stable shim path', async () => {
    vi.doMock('@/projectPath', () => ({
      projectPath: () => '/repo/apps/cli',
    }));
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, 'execPath', {
        ...originalExecPathDescriptor,
        value: '/Users/test/.happier/bin/happier',
      });
    }

    const { resolveCliRuntimeAssetPath } = await import('./resolveCliRuntimeAssetPath');

    expect(resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs')).toBe(
      '/Users/test/.happier/cli/current/scripts/claude_local_launcher.cjs',
    );
  });
});
