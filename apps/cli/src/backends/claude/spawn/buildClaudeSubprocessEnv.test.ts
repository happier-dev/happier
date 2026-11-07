import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeSubprocessEnv } from './buildClaudeSubprocessEnv';

describe('buildClaudeSubprocessEnv', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => Object.defineProperty(process, 'platform', originalPlatformDescriptor));

  it.each(['win32', 'linux', 'darwin'] as const)('preserves Windows system variables only on Windows (%s)', (platform) => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
    const windowsEnv = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
      CommonProgramFiles: 'C:\\Program Files\\Common Files',
      'CommonProgramFiles(x86)': 'C:\\Program Files (x86)\\Common Files',
      CommonProgramW6432: 'C:\\Program Files\\Common Files',
      pRoGrAmDaTa: 'C:\\ProgramData',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      PUBLIC: 'C:\\Users\\Public',
      COMPUTERNAME: 'WINDOWS-HOST',
      OS: 'Windows_NT',
      pRoCeSsOr_ArChItEcTuRe: 'AMD64',
    };
    const baseEnv = { ...windowsEnv, Path: 'C:\\Tools', HOME: 'C:\\Users\\alice', UNRELATED_SECRET: 'private' };
    const child = buildClaudeSubprocessEnv({ baseEnv });
    expect(child.HOME).toBe(baseEnv.HOME);
    expect(child.UNRELATED_SECRET).toBeUndefined();
    if (platform === 'win32') {
      expect(child).toMatchObject(windowsEnv);
      expect(child.Path).toBe(baseEnv.Path);
    } else {
      for (const key of Object.keys(windowsEnv)) expect(child[key]).toBeUndefined();
    }
    expect(baseEnv.ProgramFiles).toBe('C:\\Program Files');
  });

  it('drops inherited session attribution while preserving an explicit child entrypoint', () => {
    const baseEnv = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    expect(buildClaudeSubprocessEnv({ baseEnv }).CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    const child = buildClaudeSubprocessEnv({ baseEnv, envOverlay: { CLAUDE_CODE_ENTRYPOINT: 'happier', CLAUDECODE: '1' } });
    expect(child.CLAUDE_CODE_ENTRYPOINT).toBe('happier');
    expect(child.CLAUDECODE).toBeUndefined();
    expect(baseEnv.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
  });

  it('preserves only Claude\'s exact external sandbox assertion from the runner environment', () => {
    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '1',
        UNRELATED_SECRET: 'do-not-forward',
      },
    })).toMatchObject({
      PATH: '/bin',
      IS_SANDBOX: '1',
    });

    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '0',
      },
    })).toEqual({ PATH: '/bin' });
  });
});
