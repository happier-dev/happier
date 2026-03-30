import type { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveComparableCliVersion } from './resolveComparableCliVersion';

describe('resolveComparableCliVersion', () => {
  it('falls back to the current CLI version when the runtime package.json is unavailable', () => {
    expect(
      resolveComparableCliVersion({
        fallbackVersion: '1.2.3',
        projectRootPath: '/missing-bunfs-root',
        readFileSyncImpl: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBe('1.2.3');
  });

  it('prefers the disk version when package.json is readable', () => {
    expect(
      resolveComparableCliVersion({
        fallbackVersion: '1.2.3',
        projectRootPath: '/repo/apps/cli',
        readFileSyncImpl: ((() => JSON.stringify({ version: '2.0.0' })) as unknown) as typeof readFileSync,
      }),
    ).toBe('2.0.0');
  });
});
