import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWindowsTerminalWindowIdentity } from './windowsHostedSessionRuntime';
import { parseWindowsCommandLine } from './windowsCommandLine';
import {
  buildPowerShellStartWindowsTerminalInvocation,
  buildWindowsTerminalArgumentLine,
} from './windowsTerminalSpawn';

describe('Windows Terminal dispatcher executable identity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Both executables in this invocation used to be bare names, so the PowerShell child resolved
  // `wt.exe` from its own `PATH` and the daemon resolved `powershell.exe` from a third one.
  it('names the exact Terminal and installed PowerShell executables', () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');

    const invocation = buildPowerShellStartWindowsTerminalInvocation({
      filePath: 'C:\\Program Files\\Happier\\happier.exe',
      args: ['--version'],
      workingDirectory: 'C:\\repo',
      windowId: 'happy-window',
      title: 'Happier Session',
      terminalExecutablePath: 'C:\\Users\\lee\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
    });

    expect(invocation.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const script = invocation.args[3] ?? '';
    expect(script).toContain(
      "-FilePath 'C:\\Users\\lee\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'",
    );
    expect(script).not.toContain("-FilePath 'wt.exe'");
  });

  it('quotes a Terminal path containing a single quote instead of breaking the script', () => {
    const invocation = buildPowerShellStartWindowsTerminalInvocation({
      filePath: 'C:\\happier.exe',
      args: [],
      workingDirectory: 'C:\\repo',
      windowId: 'happy-window',
      title: 'Happier Session',
      terminalExecutablePath: "C:\\Users\\o'brien\\wt.exe",
    });

    expect(invocation.args[3] ?? '').toContain("-FilePath 'C:\\Users\\o''brien\\wt.exe'");
  });
});

describe('Windows Terminal native invocation', () => {
  it('preserves native argv while escaping Terminal command separators', () => {
    const argumentLine = buildWindowsTerminalArgumentLine({
      windowId: 'happy-window',
      title: 'Happier; Session',
      workingDirectory: 'C:\\repo;copy',
      filePath: 'C:\\Program Files\\Happier\\happier.exe',
      args: [
        '',
        'space value',
        'quote"value',
        'slash\\',
        'semi;colon',
        '日本語',
      ],
    });

    expect(parseWindowsCommandLine(argumentLine)).toEqual([
      '-w',
      'happy-window',
      'new-tab',
      '--title',
      'Happier\\; Session',
      '--startingDirectory',
      'C:\\repo\\;copy',
      'C:\\Program Files\\Happier\\happier.exe',
      '',
      'space value',
      'quote"value',
      'slash\\',
      'semi\\;colon',
      '日本語',
    ]);
  });

  it('emits the canonical new-window selector and a stable named-window target', () => {
    const buildTargetArgs = (windowName: string) => {
      const identity = buildWindowsTerminalWindowIdentity({
        agentCommand: 'codex',
        reservedSessionId: 'reserved-session',
        windowName,
        randomHex: () => 'ab'.repeat(16),
      });
      return parseWindowsCommandLine(
        buildWindowsTerminalArgumentLine({
          windowId: identity.windowId,
          title: identity.title,
          workingDirectory: 'C:\\repo',
          filePath: 'C:\\happier.exe',
          args: ['codex'],
        }),
      );
    };

    expect(buildTargetArgs(' new ').slice(0, 3)).toEqual([
      '-w',
      'new',
      'new-tab',
    ]);
    const firstNamedTarget = buildTargetArgs('happier').slice(0, 3);
    const secondNamedTarget = buildTargetArgs('happier').slice(0, 3);
    expect(firstNamedTarget).toEqual([
      '-w',
      'happier',
      'new-tab',
    ]);
    expect(secondNamedTarget).toEqual(firstNamedTarget);
  });
});
