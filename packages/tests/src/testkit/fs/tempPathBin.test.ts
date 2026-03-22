import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempPathBin, prependPathEntry, resolvePathEnvKey } from './tempPathBin';
import { withTempPathBin } from './withTempPathBin';

describe('testkit fs tempPathBin', () => {
  it('resolves the active path env key', () => {
    expect(resolvePathEnvKey({ Path: 'C:\\tools' })).toBe('Path');
    expect(resolvePathEnvKey({ PATH: '/usr/bin' })).toBe('PATH');
  });

  it('prepends a path entry to the selected env key', () => {
    const env = prependPathEntry('/tmp/happier-bin', {
      PATH: ['/usr/bin', '/bin'].join(delimiter),
      HOME: '/tmp/home',
    });

    expect(env.PATH?.split(delimiter)[0]).toBe('/tmp/happier-bin');
    expect(env.HOME).toBe('/tmp/home');
  });

  it('creates a temp path-bin and returns env with the bin dir prepended', async () => {
    const tempPathBin = await createTempPathBin({
      prefix: 'happier-tests-temp-path-bin-',
      env: {
        PATH: ['/usr/bin', '/bin'].join(delimiter),
      },
    });

    try {
      expect(existsSync(tempPathBin.dir)).toBe(true);
      expect(tempPathBin.env[tempPathBin.pathKey]?.split(delimiter)[0]).toBe(tempPathBin.dir);
    } finally {
      await tempPathBin.cleanup();
    }
  });

  it('cleans up a temp path-bin after withTempPathBin returns', async () => {
    let createdDir = '';

    await withTempPathBin(
      {
        prefix: 'happier-tests-with-temp-path-bin-',
        env: {
          PATH: '/usr/bin',
        },
      },
      async (tempPathBin) => {
        createdDir = tempPathBin.dir;
        expect(existsSync(tempPathBin.dir)).toBe(true);
        expect(tempPathBin.env[tempPathBin.pathKey]?.split(delimiter)[0]).toBe(tempPathBin.dir);
      },
    );

    expect(createdDir).not.toBe('');
    expect(existsSync(createdDir)).toBe(false);
  });
});
