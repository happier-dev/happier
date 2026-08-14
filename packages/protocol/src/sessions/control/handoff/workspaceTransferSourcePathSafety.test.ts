import { describe, expect, it } from 'vitest';

async function loadSafetyModule() {
  return await import(new URL('./workspaceTransferSourcePathSafety.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('evaluateSessionHandoffWorkspaceTransferSourcePathSafety', () => {
  it('rejects missing source paths and filesystem roots', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'missing_source_path',
    });

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_filesystem_root',
    });
  });

  it('rejects home-directory shorthand and relative paths', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '~',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: 'projects/happier',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_not_absolute',
    });
  });

  it('allows narrower project paths and respects fallback home directories', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester/projects/happier',
        sourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: true,
      reasonCode: null,
    });

    expect(
      mod.evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
        sourcePath: '/Users/tester',
        fallbackSourceHomeDir: '/Users/tester',
      }),
    ).toEqual({
      allowed: false,
      reasonCode: 'path_is_home_directory',
    });
  });
});

describe('normalizeSessionHandoffWorkspaceRootPath', () => {
  it('normalizes POSIX roots while preserving their platform syntax', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.normalizeSessionHandoffWorkspaceRootPath('/Users/alice/./projects//demo/'))
      .toBe('/Users/alice/projects/demo');
  });

  it('normalizes Windows drive and UNC roots without rewriting them as POSIX paths', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.normalizeSessionHandoffWorkspaceRootPath('C:\\Users\\alice\\.\\projects\\\\demo\\'))
      .toBe('C:\\Users\\alice\\projects\\demo');
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('\\\\server\\share\\projects\\.\\demo\\'))
      .toBe('\\\\server\\share\\projects\\demo');
  });

  it('rejects roots, relative paths, parent traversal, and NUL bytes', async () => {
    const mod = await loadSafetyModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.normalizeSessionHandoffWorkspaceRootPath('/')).toBeNull();
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('C:\\')).toBeNull();
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('\\\\server\\share')).toBeNull();
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('projects/demo')).toBeNull();
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('C:\\Users\\alice\\..\\bob\\demo')).toBeNull();
    expect(mod.normalizeSessionHandoffWorkspaceRootPath('/repo/\0/demo')).toBeNull();
  });
});
