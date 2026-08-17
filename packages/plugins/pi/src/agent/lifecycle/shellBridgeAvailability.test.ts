import { describe, expect, it, vi } from 'vitest';

import {
  resolveEffectivePiConfiguredShellPath,
  normalizePiShellPath,
  resolvePiShellBridgeAvailability,
  resolvePiSettingsShellPath,
} from './shellBridgeAvailability.js';

const NO_FILES = () => false;

describe('resolvePiShellBridgeAvailability', () => {
  it('fails closed on Windows when Pi cannot resolve Bash', () => {
    const result = resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      configuredShellPath: null,
      pathExists: NO_FILES,
      findBashOnPath: () => null,
    });

    expect(result).toMatchObject({
      available: false,
      reason: 'bash_not_found',
      searchedPaths: [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ],
    });
    if (result.available) throw new Error('expected unavailable result');
    expect(result.errorMessage).toContain('Install Git for Windows');
    expect(result.errorMessage).toContain('shellPath');
  });

  it('uses an existing configured shellPath before standard Windows locations', () => {
    const findBashOnPath = vi.fn(() => 'C:\\msys64\\usr\\bin\\bash.exe');

    expect(resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      configuredShellPath: 'D:\\PortableGit\\bin\\bash.exe',
      pathExists: (candidate) => candidate === 'D:\\PortableGit\\bin\\bash.exe',
      findBashOnPath,
    })).toEqual({
      available: true,
      shellPath: 'D:\\PortableGit\\bin\\bash.exe',
      source: 'configured_shell_path',
    });
    expect(findBashOnPath).not.toHaveBeenCalled();
  });

  it('does not fall back when a configured shellPath is missing', () => {
    const findBashOnPath = vi.fn(() => 'C:\\msys64\\usr\\bin\\bash.exe');
    const result = resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: {},
      configuredShellPath: 'D:\\missing\\bash.exe',
      pathExists: NO_FILES,
      findBashOnPath,
    });

    expect(result).toMatchObject({
      available: false,
      reason: 'configured_shell_path_not_found',
      configuredShellPath: 'D:\\missing\\bash.exe',
    });
    expect(findBashOnPath).not.toHaveBeenCalled();
  });

  it('resolves a relative configured shellPath from the selected workspace', () => {
    const pathExists = vi.fn((candidate: string) => candidate === 'C:\\workspace\\tools\\bash.exe');

    expect(resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: {},
      directory: 'C:\\workspace',
      configuredShellPath: 'tools\\bash.exe',
      pathExists,
      findBashOnPath: () => null,
    })).toEqual({
      available: true,
      shellPath: 'C:\\workspace\\tools\\bash.exe',
      source: 'configured_shell_path',
    });
    expect(pathExists).toHaveBeenCalledWith('C:\\workspace\\tools\\bash.exe');
  });

  it('preserves Pi settings string values exactly for deep-merge precedence', () => {
    expect(resolvePiSettingsShellPath({ shellPath: '  ' })).toBe('  ');
    expect(resolvePiSettingsShellPath({ shellPath: '' })).toBe('');
  });

  it('normalizes file URLs with the target platform semantics used by Pi', () => {
    expect(normalizePiShellPath(
      'file:///C:/Program%20Files/Git/bin/bash.exe',
      'win32',
      'C:\\Users\\alice',
    )).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('lets a trusted empty project shellPath override a configured global path and select Bash fallback', () => {
    const configuredShellPath = resolveEffectivePiConfiguredShellPath({
      globalShellPath: 'D:\\global\\bash.exe',
      projectShellPath: '',
      projectTrusted: true,
    });

    expect(configuredShellPath).toBe('');
    expect(resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      configuredShellPath,
      pathExists: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
      findBashOnPath: () => null,
    })).toEqual({
      available: true,
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      source: 'git_bash',
    });
  });

  it('accepts Pi-recognized Git Bash and PATH Bash candidates', () => {
    expect(resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      configuredShellPath: null,
      pathExists: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
      findBashOnPath: () => null,
    })).toEqual({
      available: true,
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      source: 'git_bash',
    });

    expect(resolvePiShellBridgeAvailability({
      platform: 'win32',
      env: {},
      configuredShellPath: null,
      pathExists: (candidate) => candidate === 'C:\\cygwin64\\bin\\bash.exe',
      findBashOnPath: () => 'C:\\cygwin64\\bin\\bash.exe',
    })).toEqual({
      available: true,
      shellPath: 'C:\\cygwin64\\bin\\bash.exe',
      source: 'path',
    });
  });

  it('keeps non-Windows launches available without a Windows Bash prerequisite', () => {
    const findBashOnPath = vi.fn(() => null);
    expect(resolvePiShellBridgeAvailability({
      platform: 'linux',
      env: {},
      configuredShellPath: null,
      pathExists: NO_FILES,
      findBashOnPath,
    })).toEqual({ available: true, shellPath: null, source: 'non_windows' });
    expect(findBashOnPath).not.toHaveBeenCalled();
  });

  it('uses project shellPath only when Pi trusts the project', () => {
    expect(resolveEffectivePiConfiguredShellPath({
      globalShellPath: 'C:\\global\\bash.exe',
      projectShellPath: 'D:\\project\\bash.exe',
      projectTrusted: false,
    })).toBe('C:\\global\\bash.exe');
    expect(resolveEffectivePiConfiguredShellPath({
      globalShellPath: 'C:\\global\\bash.exe',
      projectShellPath: 'D:\\project\\bash.exe',
      projectTrusted: true,
    })).toBe('D:\\project\\bash.exe');
  });
});
