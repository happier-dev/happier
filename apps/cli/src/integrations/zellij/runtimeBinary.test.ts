import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path === '/runtime/tools/unpacked'),
  };
});

vi.mock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
  resolveCliRuntimeAssetPath: (...segments: readonly string[]) => `/runtime/${segments.join('/')}`,
}));

vi.mock('./resolveZellijBinary', () => ({
  resolveZellijBinary: vi.fn(async () => null),
}));

describe('resolveZellijRuntimeBinary', () => {
  it('resolves the bundled zellij binary from the unpacked CLI tools directory', async () => {
    const resolveZellijBinaryModule = await import('./resolveZellijBinary');
    vi.mocked(resolveZellijBinaryModule.resolveZellijBinary).mockResolvedValue('/runtime/tools/unpacked/zellij');

    const runtimeBinary = await import('./runtimeBinary');

    await expect(runtimeBinary.resolveZellijRuntimeBinary()).resolves.toBe('/runtime/tools/unpacked/zellij');
    expect(resolveZellijBinaryModule.resolveZellijBinary).toHaveBeenCalledWith({
      toolsDir: '/runtime/tools/unpacked',
      expectedVersion: runtimeBinary.BUNDLED_ZELLIJ_VERSION,
    });
    expect(runtimeBinary.resolveZellijToolsDir()).toBe('/runtime/tools/unpacked');
    expect(vi.mocked(existsSync)).toHaveBeenCalledWith('/runtime/tools/unpacked');
  });
});
