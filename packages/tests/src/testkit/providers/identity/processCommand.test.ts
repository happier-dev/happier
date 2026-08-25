import { describe, expect, it } from 'vitest';

import {
  resolveObservedProcessExecutablePath,
  tokenizeObservedProcessCommand,
} from './processCommand';

describe('observed process command identity', () => {
  it('resolves a quoted executable path without losing its arguments', () => {
    const command = '"C:\\Program Files\\Happier\\provider.exe" serve --port 43111';

    expect(resolveObservedProcessExecutablePath(command))
      .toBe('C:\\Program Files\\Happier\\provider.exe');
    expect(tokenizeObservedProcessCommand(command)).toEqual([
      'C:\\Program Files\\Happier\\provider.exe',
      'serve',
      '--port',
      '43111',
    ]);
  });

  it('returns no executable for an empty command', () => {
    expect(resolveObservedProcessExecutablePath('   ')).toBeNull();
  });
});
