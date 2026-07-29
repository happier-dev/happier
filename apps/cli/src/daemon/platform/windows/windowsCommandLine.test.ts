import { describe, expect, it } from 'vitest';

import {
  parseWindowsCommandLine,
  serializeWindowsCommandLine,
} from './windowsCommandLine';

describe('Windows native command-line codec', () => {
  it.each([
    [[]],
    [['plain']],
    [['C:\\Program Files\\Happier\\happier.exe', 'codex']],
    [['', 'two words', 'trailing\\', 'embedded"quote', 'slashes\\\\before"quote']],
    [[
      'C:\\Program Files\\Happier\\happier.exe',
      '--happy-terminal-title',
      'Happier codex session-1',
      '--happy-terminal-launch-correlation',
      '7f'.repeat(16),
      '--existing-session',
      'session with spaces',
    ]],
  ])('round-trips every argument without Start-Process array flattening (%j)', (argv) => {
    expect(parseWindowsCommandLine(serializeWindowsCommandLine(argv))).toEqual(argv);
  });

  it('parses the quoting shape emitted by a native Windows process command line', () => {
    expect(parseWindowsCommandLine(
      '"C:\\Program Files\\Happier\\happier.exe" codex "two words" "trailing\\\\" "embedded\\\"quote"',
    )).toEqual([
      'C:\\Program Files\\Happier\\happier.exe',
      'codex',
      'two words',
      'trailing\\',
      'embedded"quote',
    ]);
  });
});
