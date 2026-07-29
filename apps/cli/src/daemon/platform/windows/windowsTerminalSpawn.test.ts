import { describe, expect, it } from 'vitest';

import { buildWindowsTerminalWindowIdentity } from './windowsHostedSessionRuntime';
import { parseWindowsCommandLine } from './windowsCommandLine';
import {
  buildWindowsTerminalArgumentLine,
} from './windowsTerminalSpawn';

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
