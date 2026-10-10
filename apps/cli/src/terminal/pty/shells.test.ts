import { describe, expect, it } from 'vitest';

import { resolveFiniteTerminalShell } from './shells';

describe('finite literal command shell invocation', () => {
  it('executes a POSIX command as a finite shell argument rather than interactive input', () => {
    const command = 'printf "%s" "$HOME"; exit 7';
    expect(resolveFiniteTerminalShell(command, { SHELL: '/bin/bash' }, 'linux'))
      .toEqual({ file: '/bin/bash', args: ['-c', command] });
  });

  it('uses finite command flags for cmd and PowerShell without changing command bytes', () => {
    const command = 'echo "C:\\a b\\" & exit 7';
    expect(resolveFiniteTerminalShell(command, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'))
      .toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', command] });
    expect(resolveFiniteTerminalShell(command, { HAPPIER_DAEMON_TERMINAL_SHELL: 'C:\\PowerShell\\pwsh.exe' }, 'win32'))
      .toEqual({ file: 'C:\\PowerShell\\pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] });
  });
});
