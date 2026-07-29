import { describe, expect, it } from 'vitest';

import { processCommandContainsPathFragment } from './processCommandPathMatch';

describe('processCommandContainsPathFragment', () => {
  it('matches exact and descendant command arguments', () => {
    expect(processCommandContainsPathFragment(
      'node "/opt/happier/apps/cli/src/index.ts" daemon start-sync',
      '/opt/happier/apps/cli',
    )).toBe(true);
    expect(processCommandContainsPathFragment(
      'runner --root=/opt/happier/apps/cli',
      '/opt/happier/apps/cli',
    )).toBe(true);
  });

  it('rejects sibling-prefix and embedded-token collisions', () => {
    expect(processCommandContainsPathFragment(
      'node /opt/happier/apps/cli-old/src/index.ts daemon start-sync',
      '/opt/happier/apps/cli',
    )).toBe(false);
    expect(processCommandContainsPathFragment(
      'node prefix/opt/happier/apps/cli/src/index.ts daemon start-sync',
      '/opt/happier/apps/cli',
    )).toBe(false);
  });

  it('preserves POSIX case while matching Windows drive and UNC paths case-insensitively', () => {
    expect(processCommandContainsPathFragment(
      'node /Work/Happier/apps/cli/src/index.ts daemon start-sync',
      '/work/happier/apps/cli',
    )).toBe(false);
    expect(processCommandContainsPathFragment(
      String.raw`C:\Runtime\node.exe C:\Users\Alice\Happier\apps\cli\src\index.ts daemon start-sync`,
      'c:/users/alice/happier/apps/cli',
    )).toBe(true);
    expect(processCommandContainsPathFragment(
      String.raw`node.exe \\Server\Share\Happier\apps\cli\dist\index.mjs daemon start-sync`,
      '//server/share/happier/apps/cli',
    )).toBe(true);
  });
});
