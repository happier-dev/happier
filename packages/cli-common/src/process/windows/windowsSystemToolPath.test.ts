import { describe, expect, it } from 'vitest';

import {
  requireWindowsSystemToolPath,
  resolveWindowsSystemToolPath,
  windowsSystemToolCommand,
} from './windowsSystemToolPath.js';

describe('resolveWindowsSystemToolPath', () => {
  it('pins every system tool under the installed SystemRoot', () => {
    const env = { SystemRoot: 'C:\\WINDOWS' } satisfies NodeJS.ProcessEnv;

    expect(resolveWindowsSystemToolPath('powershell.exe', env))
      .toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(resolveWindowsSystemToolPath('taskkill.exe', env)).toBe('C:\\WINDOWS\\System32\\taskkill.exe');
    expect(resolveWindowsSystemToolPath('icacls.exe', env)).toBe('C:\\WINDOWS\\System32\\icacls.exe');
    expect(resolveWindowsSystemToolPath('whoami.exe', env)).toBe('C:\\WINDOWS\\System32\\whoami.exe');
  });

  it('accepts the WINDIR spelling and any casing Windows exposes', () => {
    expect(resolveWindowsSystemToolPath('taskkill.exe', { windir: 'D:\\Win' }))
      .toBe('D:\\Win\\System32\\taskkill.exe');
    expect(resolveWindowsSystemToolPath('taskkill.exe', { SYSTEMROOT: 'E:\\Windows' }))
      .toBe('E:\\Windows\\System32\\taskkill.exe');
  });

  it('prefers SystemRoot over WINDIR so one machine cannot resolve two roots', () => {
    expect(resolveWindowsSystemToolPath('taskkill.exe', { SystemRoot: 'C:\\WINDOWS', WINDIR: 'D:\\Other' }))
      .toBe('C:\\WINDOWS\\System32\\taskkill.exe');
  });

  it('reports no pin when the environment never says where Windows is', () => {
    expect(resolveWindowsSystemToolPath('powershell.exe', {})).toBeNull();
    expect(resolveWindowsSystemToolPath('powershell.exe', { SystemRoot: '   ' })).toBeNull();
    expect(windowsSystemToolCommand('powershell.exe', {})).toBe('powershell.exe');
    expect(() => requireWindowsSystemToolPath('powershell.exe', {})).toThrow(/SystemRoot.*WINDIR/u);
  });
});
