import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveYarnInvocation } from '../pipeline/tauri/resolve-yarn-invocation.mjs';

test('resolveYarnInvocation prefers yarn.cmd on Windows when yarn is available in a cmd shell', () => {
  const yarn = resolveYarnInvocation({
    platform: 'win32',
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);
      assert.deepEqual(args, ['/D', '/S', '/C', 'yarn --version']);
      return '1.22.22\n';
    },
  });

  assert.deepEqual(yarn, { cmd: 'yarn.cmd', prefixArgs: [] });
});
